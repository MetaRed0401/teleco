import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { TeleCodexConfig } from "./config.js";

const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TelegramDeliveryClaim = "send" | "already-delivered" | "in-flight";

export type ClaimTelegramDeliveryInput = {
  deliveryKey: string;
  contextKey: string;
  chatId: number | string;
  messageThreadId?: number;
  operationId: string;
  itemId?: string;
  kind: "live-final" | "recovered-final" | "recovered-item";
  payload: string;
};

type DeliveryRow = {
  state: "sending" | "sent" | "failed";
  payload_hash: string;
};

class TelegramDeliveryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.db = new Database(dbPath);
    this.initialize();
  }

  claim(input: ClaimTelegramDeliveryInput): TelegramDeliveryClaim {
    const now = Date.now();
    const payloadHash = hashPayload(input.payload);
    const existing = this.db
      .prepare("SELECT state, payload_hash FROM telegram_deliveries WHERE delivery_key = ? LIMIT 1")
      .get(input.deliveryKey) as DeliveryRow | undefined;

    if (existing?.state === "sent") {
      return "already-delivered";
    }
    if (existing?.state === "sending") {
      return "in-flight";
    }

    this.db
      .prepare(
        `
        INSERT INTO telegram_deliveries (
          delivery_key,
          instance_name,
          context_key,
          chat_id,
          message_thread_id,
          operation_id,
          item_id,
          kind,
          payload_hash,
          state,
          attempts,
          created_at,
          updated_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?)
        ON CONFLICT(delivery_key) DO UPDATE SET
          payload_hash = excluded.payload_hash,
          state = 'sending',
          attempts = telegram_deliveries.attempts + 1,
          last_error = NULL,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
        `,
      )
      .run(
        input.deliveryKey,
        currentInstanceName(),
        input.contextKey,
        String(input.chatId),
        input.messageThreadId ?? null,
        input.operationId,
        input.itemId ?? null,
        input.kind,
        payloadHash,
        now,
        now,
        now + DELIVERY_TTL_MS,
      );
    return "send";
  }

  complete(deliveryKey: string, telegramMessageId?: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        UPDATE telegram_deliveries
        SET state = 'sent', telegram_message_id = ?, sent_at = ?, updated_at = ?, expires_at = ?
        WHERE delivery_key = ?
        `,
      )
      .run(telegramMessageId ?? null, now, now, now + DELIVERY_TTL_MS, deliveryKey);
  }

  fail(deliveryKey: string, error: unknown): void {
    const now = Date.now();
    const detail = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(
        `
        UPDATE telegram_deliveries
        SET state = 'failed', last_error = ?, updated_at = ?, expires_at = ?
        WHERE delivery_key = ?
        `,
      )
      .run(detail.slice(0, 500), now, now + DELIVERY_TTL_MS, deliveryKey);
  }

  cleanup(now = Date.now()): number {
    const result = this.db.prepare("DELETE FROM telegram_deliveries WHERE expires_at <= ?").run(now);
    if (result.changes > 0) {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.pragma("incremental_vacuum(64)");
    }
    return result.changes;
  }

  private initialize(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.pragma("auto_vacuum = INCREMENTAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_deliveries (
        delivery_key TEXT PRIMARY KEY,
        instance_name TEXT NOT NULL,
        context_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_thread_id INTEGER,
        operation_id TEXT NOT NULL,
        item_id TEXT,
        kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        telegram_message_id INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_expires
      ON telegram_deliveries (expires_at);

      CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_operation
      ON telegram_deliveries (operation_id, updated_at DESC);
    `);
    this.cleanup();
  }
}

const stores = new Map<string, TelegramDeliveryStore>();
const scheduledCleanupPaths = new Set<string>();

export function claimTelegramDelivery(
  config: TeleCodexConfig,
  input: ClaimTelegramDeliveryInput,
): TelegramDeliveryClaim {
  return getStore(config).claim(input);
}

export function completeTelegramDelivery(
  config: TeleCodexConfig,
  deliveryKey: string,
  telegramMessageId?: number,
): void {
  getStore(config).complete(deliveryKey, telegramMessageId);
}

export function failTelegramDelivery(config: TeleCodexConfig, deliveryKey: string, error: unknown): void {
  getStore(config).fail(deliveryKey, error);
}

export function scheduleTelegramDeliveryCleanup(config: TeleCodexConfig): void {
  const dbPath = getTelegramDeliveryDbPath(config.workspace);
  if (scheduledCleanupPaths.has(dbPath)) {
    return;
  }
  scheduledCleanupPaths.add(dbPath);
  setImmediate(() => {
    try {
      getStore(config).cleanup();
    } catch (error) {
      console.warn("Failed to clean Telegram delivery ledger:", error instanceof Error ? error.message : String(error));
    } finally {
      scheduledCleanupPaths.delete(dbPath);
    }
  });
}

export function getTelegramDeliveryDbPath(workspace: string): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim();
  if (!instance || instance === "default") {
    return path.join(workspace, ".telecodex", "telegram-deliveries.sqlite");
  }
  return path.join(workspace, ".telecodex", instance, "telegram-deliveries.sqlite");
}

function getStore(config: TeleCodexConfig): TelegramDeliveryStore {
  const dbPath = getTelegramDeliveryDbPath(config.workspace);
  let store = stores.get(dbPath);
  if (!store) {
    store = new TelegramDeliveryStore(dbPath);
    stores.set(dbPath, store);
  }
  return store;
}

function currentInstanceName(): string {
  return process.env.TELECODEX_INSTANCE?.trim() || "default";
}

function hashPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
