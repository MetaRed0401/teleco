import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";

export type ActiveOperationType = "compact" | "turn";
export type ActiveOperationStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";

export interface ActiveOperationRecord {
  id: string;
  contextKey: TelegramContextKey;
  chatId: number | string;
  messageThreadId?: number;
  operation: ActiveOperationType;
  status: ActiveOperationStatus;
  ownerPid?: number;
  threadId: string | null;
  turnId?: string;
  workspace: string;
  promptSummary?: string;
  deliveredItemIds?: string[];
  responseMessageId?: number;
  statusMessageId?: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  interruptedAt?: number;
}

export interface StartActiveOperationInput {
  contextKey: TelegramContextKey;
  chatId: number | string;
  messageThreadId?: number;
  operation: ActiveOperationType;
  threadId: string | null;
  workspace: string;
  promptSummary?: string;
}

export function startActiveOperation(
  config: TeleCodexConfig,
  input: StartActiveOperationInput,
): ActiveOperationRecord {
  const now = Date.now();
  const record: ActiveOperationRecord = {
    id: randomUUID(),
    contextKey: input.contextKey,
    chatId: input.chatId,
    messageThreadId: input.messageThreadId,
    operation: input.operation,
    status: "running",
    ownerPid: process.pid,
    threadId: input.threadId,
    workspace: input.workspace,
    promptSummary: input.promptSummary,
    startedAt: now,
    updatedAt: now,
  };
  writeOperations(config, [...readOperations(config).filter((item) => item.status === "running"), record]);
  return record;
}

export function updateActiveOperation(
  config: TeleCodexConfig,
  id: string | undefined,
  patch: Partial<Pick<ActiveOperationRecord, "deliveredItemIds" | "responseMessageId" | "statusMessageId" | "threadId" | "turnId" | "workspace">>,
): void {
  if (!id) {
    return;
  }

  const records = readOperations(config);
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) {
    return;
  }

  records[index] = {
    ...records[index]!,
    ...patch,
    updatedAt: Date.now(),
  };
  writeOperations(config, records);
}

export function acknowledgeActiveOperationItem(
  config: TeleCodexConfig,
  id: string | undefined,
  itemId: string | undefined,
): void {
  if (!id || !itemId) {
    return;
  }

  const records = readOperations(config);
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) {
    return;
  }

  const record = records[index]!;
  const deliveredItemIds = record.deliveredItemIds ?? [];
  if (deliveredItemIds.includes(itemId)) {
    return;
  }
  records[index] = {
    ...record,
    deliveredItemIds: [...deliveredItemIds, itemId].slice(-200),
    updatedAt: Date.now(),
  };
  writeOperations(config, records);
}

export function finishActiveOperation(
  config: TeleCodexConfig,
  id: string | undefined,
  status: Exclude<ActiveOperationStatus, "interrupted" | "running">,
): void {
  if (!id) {
    return;
  }

  const now = Date.now();
  const records = readOperations(config).map((record) =>
    record.id === id
      ? {
          ...record,
          status,
          completedAt: now,
          updatedAt: now,
        }
      : record,
  );
  writeOperations(config, records.filter((record) => record.status === "running" || record.status === "interrupted"));
}

export function markInterruptedOperations(config: TeleCodexConfig): ActiveOperationRecord[] {
  const now = Date.now();
  const records = readOperations(config);
  const interrupted: ActiveOperationRecord[] = [];
  const next = records.map((record) => {
    if (record.status === "interrupted") {
      interrupted.push(record);
      return record;
    }
    if (record.status !== "running") {
      return record;
    }

    const updated = {
      ...record,
      status: "interrupted" as const,
      interruptedAt: now,
      updatedAt: now,
    };
    interrupted.push(updated);
    return updated;
  });
  writeOperations(config, next.filter((record) => record.status === "running" || record.status === "interrupted"));
  return interrupted;
}

function readOperations(config: TeleCodexConfig): ActiveOperationRecord[] {
  const filePath = getOperationsPath(config);
  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ActiveOperationRecord[];
    return Array.isArray(parsed) ? parsed.filter(isActiveOperationRecord) : [];
  } catch {
    return [];
  }
}

function writeOperations(config: TeleCodexConfig, records: ActiveOperationRecord[]): void {
  const filePath = getOperationsPath(config);
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(records.slice(-50), null, 2), "utf8");
  } catch (error) {
    console.warn("Failed to persist active operation state:", error instanceof Error ? error.message : String(error));
  }
}

function getOperationsPath(config: TeleCodexConfig): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim();
  if (!instance || instance === "default") {
    return path.join(config.workspace, ".telecodex", "active-operations.json");
  }

  return path.join(config.workspace, ".telecodex", instance, "active-operations.json");
}

function isActiveOperationRecord(value: unknown): value is ActiveOperationRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<ActiveOperationRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.contextKey === "string" &&
    (typeof record.chatId === "number" || typeof record.chatId === "string") &&
    (record.operation === "compact" || record.operation === "turn") &&
    typeof record.startedAt === "number"
  );
}
