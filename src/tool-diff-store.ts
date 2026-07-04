import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { TeleCodexConfig } from "./config.js";

type TelegramChatId = number | string;

export type ToolDiffPreviewSource =
  | "app-server-fileChange"
  | "sdk-fileChange"
  | "turn-diff"
  | "unknown";

export type ToolDiffPreviewPayload = {
  summary?: string;
  diffText: string;
  files?: Array<{ kind?: string; path: string }>;
  source: ToolDiffPreviewSource;
  truncated?: boolean;
  limits?: {
    maxLines: number;
    maxChars: number;
  };
};

export type StoreToolDiffPreviewInput = {
  contextKey: string;
  threadId?: string;
  chatId: TelegramChatId;
  messageThreadId?: number;
  toolCallId?: string;
  toolName?: string;
  payload: ToolDiffPreviewPayload;
};

export type LookupToolDiffPreviewInput = {
  id: string;
  contextKey: string;
  chatId: TelegramChatId;
  messageThreadId?: number;
};

export class ToolDiffPreviewStore {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly maxRows = 500;

  constructor(private readonly config: TeleCodexConfig) {
    const dbPath = getToolDiffPreviewDbPath(config.workspace);
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.ttlMs = Math.max(1, config.toolDiffPreviewTtlMinutes) * 60 * 1000;
    this.initialize();
  }

  store(input: StoreToolDiffPreviewInput): string {
    this.cleanup();

    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    const payloadJson = JSON.stringify(input.payload);
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO tool_diff_previews (
          id,
          context_key,
          thread_id,
          chat_id,
          message_thread_id,
          tool_call_id,
          tool_name,
          created_at,
          expires_at,
          payload_json,
          source,
          summary_text,
          has_diff,
          truncated
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.contextKey,
        input.threadId ?? null,
        String(input.chatId),
        input.messageThreadId ?? null,
        input.toolCallId ?? null,
        input.toolName ?? "file_change",
        now,
        expiresAt,
        payloadJson,
        input.payload.source,
        input.payload.summary ?? null,
        input.payload.diffText.trim() ? 1 : 0,
        input.payload.truncated ? 1 : 0,
      );

    this.trimRows();
    return id;
  }

  lookup(input: LookupToolDiffPreviewInput): ToolDiffPreviewPayload | undefined {
    const row = this.db
      .prepare(
        `
        SELECT payload_json
        FROM tool_diff_previews
        WHERE id = ?
          AND chat_id = ?
          AND context_key = ?
          AND expires_at > ?
          AND (
            message_thread_id IS NULL
            OR message_thread_id = ?
          )
        LIMIT 1
        `,
      )
      .get(input.id, String(input.chatId), input.contextKey, Date.now(), input.messageThreadId ?? null) as
      | { payload_json: string }
      | undefined;

    if (!row) {
      return undefined;
    }

    try {
      return JSON.parse(row.payload_json) as ToolDiffPreviewPayload;
    } catch {
      return undefined;
    }
  }

  cleanup(now = Date.now()): void {
    this.db.prepare("DELETE FROM tool_diff_previews WHERE expires_at <= ?").run(now);
  }

  private initialize(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_diff_previews (
        id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL,
        thread_id TEXT,
        chat_id TEXT NOT NULL,
        message_thread_id INTEGER,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL DEFAULT 'file_change',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        summary_text TEXT,
        has_diff INTEGER NOT NULL DEFAULT 1,
        truncated INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tool_diff_previews_context_created
      ON tool_diff_previews (context_key, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_tool_diff_previews_thread_created
      ON tool_diff_previews (thread_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_tool_diff_previews_expires
      ON tool_diff_previews (expires_at);

      CREATE INDEX IF NOT EXISTS idx_tool_diff_previews_chat_context
      ON tool_diff_previews (chat_id, context_key, created_at DESC);
    `);
    this.cleanup();
  }

  private trimRows(): void {
    this.db
      .prepare(
        `
        DELETE FROM tool_diff_previews
        WHERE id IN (
          SELECT id
          FROM tool_diff_previews
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
        `,
      )
      .run(this.maxRows);
  }
}

export function getToolDiffPreviewDbPath(workspace: string): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim();
  if (!instance || instance === "default") {
    return path.join(workspace, ".telecodex", "tool-diffs.sqlite");
  }

  return path.join(workspace, ".telecodex", instance, "tool-diffs.sqlite");
}
