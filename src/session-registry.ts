import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService } from "./codex-session.js";
import type { FinalResponseMode, ResponsePreviewMode, TeleCodexConfig, ToolActivityMode } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import {
  DEFAULT_TELEGRAM_RESPONSE_FORMAT,
  normalizeTelegramPrettyMode,
  normalizeTelegramResponseFormat,
  type TelegramPrettyMode,
  type TelegramResponseFormat,
} from "./telegram-formatting.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  launchProfileId?: string;
  responseFormat?: TelegramResponseFormat;
  prettyMode?: TelegramPrettyMode;
  responsePreviewMode?: ResponsePreviewMode;
  toolActivityMode?: ToolActivityMode;
  finalResponseMode?: FinalResponseMode;
  updatedAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = getContextPersistPath(config.workspace);
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.resolveMetadata(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    session = await CodexSessionService.create(this.config, {
      workspace: meta?.workspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      fastMode: meta?.fastMode,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
    });

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
    const info = session.getInfo();
    const existing = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      fastMode: info.fastMode || undefined,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      responseFormat: existing?.responseFormat,
      prettyMode: existing?.prettyMode,
      responsePreviewMode: existing?.responsePreviewMode,
      toolActivityMode: existing?.toolActivityMode,
      finalResponseMode: existing?.finalResponseMode,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  getResponseFormat(contextKey: TelegramContextKey): TelegramResponseFormat {
    return normalizeTelegramResponseFormat(this.metadata.get(contextKey)?.responseFormat);
  }

  setResponseFormat(
    contextKey: TelegramContextKey,
    responseFormat: TelegramResponseFormat,
    session?: CodexSessionService,
  ): TelegramResponseFormat {
    const normalized = normalizeTelegramResponseFormat(responseFormat);
    const info = session?.getInfo();
    const existing = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info?.threadId ?? existing?.threadId ?? null,
      workspace: info?.workspace ?? existing?.workspace ?? this.config.workspace,
      model: info?.model ?? existing?.model,
      reasoningEffort: info?.reasoningEffort ?? existing?.reasoningEffort,
      fastMode: info?.fastMode || existing?.fastMode || undefined,
      launchProfileId: info ? info.nextLaunchProfileId ?? info.launchProfileId : existing?.launchProfileId,
      responseFormat: normalized === DEFAULT_TELEGRAM_RESPONSE_FORMAT ? undefined : normalized,
      prettyMode: existing?.prettyMode,
      responsePreviewMode: existing?.responsePreviewMode,
      toolActivityMode: existing?.toolActivityMode,
      finalResponseMode: existing?.finalResponseMode,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
    return normalized;
  }

  getPrettyMode(contextKey: TelegramContextKey): TelegramPrettyMode {
    return normalizeTelegramPrettyMode(this.metadata.get(contextKey)?.prettyMode);
  }

  setPrettyMode(
    contextKey: TelegramContextKey,
    prettyMode: TelegramPrettyMode,
    session?: CodexSessionService,
  ): TelegramPrettyMode {
    const normalized = normalizeTelegramPrettyMode(prettyMode);
    const info = session?.getInfo();
    const existing = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info?.threadId ?? existing?.threadId ?? null,
      workspace: info?.workspace ?? existing?.workspace ?? this.config.workspace,
      model: info?.model ?? existing?.model,
      reasoningEffort: info?.reasoningEffort ?? existing?.reasoningEffort,
      fastMode: info?.fastMode || existing?.fastMode || undefined,
      launchProfileId: info ? info.nextLaunchProfileId ?? info.launchProfileId : existing?.launchProfileId,
      responseFormat: existing?.responseFormat,
      prettyMode: normalized === "off" ? undefined : normalized,
      responsePreviewMode: existing?.responsePreviewMode,
      toolActivityMode: existing?.toolActivityMode,
      finalResponseMode: existing?.finalResponseMode,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
    return normalized;
  }

  getResponsePreviewMode(contextKey: TelegramContextKey): ResponsePreviewMode {
    return this.metadata.get(contextKey)?.responsePreviewMode ?? this.config.responsePreviewMode;
  }

  getToolActivityMode(contextKey: TelegramContextKey): ToolActivityMode {
    return this.metadata.get(contextKey)?.toolActivityMode ?? this.config.toolActivityMode;
  }

  getFinalResponseMode(contextKey: TelegramContextKey): FinalResponseMode {
    return this.metadata.get(contextKey)?.finalResponseMode ?? this.config.finalResponseMode;
  }

  setStreamingModes(
    contextKey: TelegramContextKey,
    modes: {
      responsePreviewMode?: ResponsePreviewMode;
      toolActivityMode?: ToolActivityMode;
      finalResponseMode?: FinalResponseMode;
    },
    session?: CodexSessionService,
  ): ContextMetadata {
    const info = session?.getInfo();
    const existing = this.metadata.get(contextKey);
    const next: ContextMetadata = {
      contextKey,
      threadId: info?.threadId ?? existing?.threadId ?? null,
      workspace: info?.workspace ?? existing?.workspace ?? this.config.workspace,
      model: info?.model ?? existing?.model,
      reasoningEffort: info?.reasoningEffort ?? existing?.reasoningEffort,
      fastMode: info?.fastMode || existing?.fastMode || undefined,
      launchProfileId: info ? info.nextLaunchProfileId ?? info.launchProfileId : existing?.launchProfileId,
      responseFormat: existing?.responseFormat,
      prettyMode: existing?.prettyMode,
      responsePreviewMode:
        modes.responsePreviewMode === this.config.responsePreviewMode
          ? undefined
          : modes.responsePreviewMode ?? existing?.responsePreviewMode,
      toolActivityMode:
        modes.toolActivityMode === this.config.toolActivityMode
          ? undefined
          : modes.toolActivityMode ?? existing?.toolActivityMode,
      finalResponseMode:
        modes.finalResponseMode === this.config.finalResponseMode
          ? undefined
          : modes.finalResponseMode ?? existing?.finalResponseMode,
      updatedAt: Date.now(),
    };
    this.metadata.set(contextKey, next);
    this.persistMetadata();
    return next;
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }

  private resolveMetadata(contextKey: TelegramContextKey): ContextMetadata | undefined {
    const meta = this.metadata.get(contextKey);
    if (!meta || existsSync(meta.workspace)) {
      return meta;
    }

    const fallback: ContextMetadata = {
      ...meta,
      threadId: null,
      workspace: this.config.workspace,
      updatedAt: Date.now(),
    };
    console.warn(
      `Persisted workspace "${meta.workspace}" for ${contextKey} does not exist. Falling back to ${this.config.workspace}.`,
    );
    this.metadata.set(contextKey, fallback);
    this.persistMetadata();
    return fallback;
  }
}

function getContextPersistPath(workspace: string): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim();
  if (!instance || instance === "default") {
    return path.join(workspace, ".telecodex", "contexts.json");
  }

  return path.join(workspace, ".telecodex", instance, "contexts.json");
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
