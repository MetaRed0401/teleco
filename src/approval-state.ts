import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";

export type PersistedApprovalStatus = "pending" | "interrupted" | "resolved" | "expired";

export interface PersistedApprovalState {
  id: string;
  fingerprint: string;
  contextKey: TelegramContextKey | null;
  chatId: number | string;
  messageThreadId?: number;
  messageId: number;
  method: string;
  status: PersistedApprovalStatus;
  ownerPid: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  decision?: string;
}

export function markRestartedApprovalsInterrupted(config: TeleCodexConfig): PersistedApprovalState[] {
  const now = Date.now();
  const interrupted: PersistedApprovalState[] = [];
  const records = readApprovalStates(config).map((record) => {
    if (record.status !== "pending" || record.ownerPid === process.pid) {
      return record;
    }
    const updated: PersistedApprovalState = {
      ...record,
      status: record.expiresAt > now ? "interrupted" : "expired",
      updatedAt: now,
    };
    if (updated.expiresAt > now) {
      interrupted.push(updated);
    }
    return updated;
  });
  writeApprovalStates(config, records);
  return interrupted;
}

export function findInterruptedApproval(
  config: TeleCodexConfig,
  fingerprint: string,
  contextKey: TelegramContextKey | null,
): PersistedApprovalState | undefined {
  const now = Date.now();
  return readApprovalStates(config)
    .filter((record) =>
      record.status === "interrupted"
      && record.fingerprint === fingerprint
      && record.contextKey === contextKey
      && record.expiresAt > now,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

export function persistPendingApproval(
  config: TeleCodexConfig,
  input: Omit<PersistedApprovalState, "status" | "ownerPid" | "updatedAt">,
): void {
  const now = Date.now();
  const record: PersistedApprovalState = {
    ...input,
    status: "pending",
    ownerPid: process.pid,
    updatedAt: now,
  };
  const records = readApprovalStates(config).filter((item) => item.id !== record.id);
  writeApprovalStates(config, [...records, record]);
}

export function finishPersistedApproval(
  config: TeleCodexConfig,
  id: string,
  status: "resolved" | "expired",
  decision?: string,
): void {
  const now = Date.now();
  const records = readApprovalStates(config).map((record) =>
    record.id === id
      ? {
          ...record,
          status,
          decision,
          updatedAt: now,
        }
      : record,
  );
  writeApprovalStates(config, records);
}

function readApprovalStates(config: TeleCodexConfig): PersistedApprovalState[] {
  const filePath = getApprovalStatePath(config);
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPersistedApprovalState) : [];
  } catch {
    return [];
  }
}

function writeApprovalStates(config: TeleCodexConfig, records: PersistedApprovalState[]): void {
  const filePath = getApprovalStatePath(config);
  const now = Date.now();
  const retained = records
    .filter((record) =>
      record.status === "pending"
      || (record.status === "interrupted" && record.expiresAt > now)
      || record.updatedAt > now - 24 * 60 * 60 * 1000,
    )
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-50);

  try {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(retained, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    console.warn("Failed to persist approval state:", error instanceof Error ? error.message : String(error));
  }
}

function getApprovalStatePath(config: TeleCodexConfig): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim();
  if (!instance || instance === "default") {
    return path.join(config.workspace, ".telecodex", "approval-states.json");
  }
  return path.join(config.workspace, ".telecodex", instance, "approval-states.json");
}

function isPersistedApprovalState(value: unknown): value is PersistedApprovalState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<PersistedApprovalState>;
  return (
    typeof record.id === "string"
    && typeof record.fingerprint === "string"
    && (typeof record.chatId === "number" || typeof record.chatId === "string")
    && typeof record.messageId === "number"
    && typeof record.method === "string"
    && typeof record.ownerPid === "number"
    && typeof record.createdAt === "number"
    && typeof record.updatedAt === "number"
    && typeof record.expiresAt === "number"
    && ["pending", "interrupted", "resolved", "expired"].includes(record.status ?? "")
  );
}
