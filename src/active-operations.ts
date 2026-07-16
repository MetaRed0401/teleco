import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";

export type ActiveOperationType = "compact" | "turn";
export type ActiveOperationStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";
export type ActiveOperationDeliveryState =
  | "pending"
  | "completed-undelivered"
  | "delivery-in-progress"
  | "delivered"
  | "delivery-failed"
  | "cancelled";

export interface ActiveOperationRecord {
  id: string;
  contextKey: TelegramContextKey;
  chatId: number | string;
  messageThreadId?: number;
  operation: ActiveOperationType;
  status: ActiveOperationStatus;
  deliveryState: ActiveOperationDeliveryState;
  deliveryKey: string;
  deliveryAttempts: number;
  deliveryError?: string;
  deliveryStartedAt?: number;
  deliveredAt?: number;
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
    deliveryState: "pending",
    deliveryKey: "",
    deliveryAttempts: 0,
    ownerPid: process.pid,
    threadId: input.threadId,
    workspace: input.workspace,
    promptSummary: input.promptSummary,
    startedAt: now,
    updatedAt: now,
  };
  record.deliveryKey = buildDeliveryKey(record);
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

  const updated = {
    ...records[index]!,
    ...patch,
    updatedAt: Date.now(),
  };
  updated.deliveryKey = buildDeliveryKey(updated);
  records[index] = updated;
  writeOperations(config, records);
}

export function claimActiveOperationRecovery(
  config: TeleCodexConfig,
  id: string,
): (() => void) | undefined {
  const lockDir = path.join(getInstanceStateDir(config), "recovery-locks");
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockName = createHash("sha256").update(id).digest("hex").slice(0, 24);
  const lockPath = path.join(lockDir, `${lockName}.lock`);

  const acquire = (): boolean => {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, operationId: id, createdAt: Date.now() }), "utf8");
      closeSync(descriptor);
      return true;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      const ownerPid = readRecoveryLockOwner(lockPath);
      if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
      return acquire();
    }
  };

  if (!acquire()) {
    return undefined;
  }

  return () => {
    if (readRecoveryLockOwner(lockPath) !== process.pid) {
      return;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock may already have been cleaned up during shutdown.
    }
  };
}

export function setActiveOperationDeliveryState(
  config: TeleCodexConfig,
  id: string | undefined,
  deliveryState: ActiveOperationDeliveryState,
  error?: string,
): void {
  if (!id) {
    return;
  }

  const records = readOperations(config);
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) {
    return;
  }

  const now = Date.now();
  const record = records[index]!;
  records[index] = {
    ...record,
    deliveryState,
    deliveryAttempts:
      deliveryState === "delivery-in-progress" ? (record.deliveryAttempts ?? 0) + 1 : (record.deliveryAttempts ?? 0),
    deliveryError: deliveryState === "delivery-failed" ? error?.slice(0, 500) : undefined,
    deliveryStartedAt: deliveryState === "delivery-in-progress" ? now : record.deliveryStartedAt,
    deliveredAt: deliveryState === "delivered" ? now : record.deliveredAt,
    updatedAt: now,
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
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(temporaryPath, JSON.stringify(records.slice(-50), null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    console.warn("Failed to persist active operation state:", error instanceof Error ? error.message : String(error));
  }
}

function getOperationsPath(config: TeleCodexConfig): string {
  return path.join(getInstanceStateDir(config), "active-operations.json");
}

function getInstanceStateDir(config: TeleCodexConfig): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim();
  if (!instance || instance === "default") {
    return path.join(config.workspace, ".telecodex");
  }

  return path.join(config.workspace, ".telecodex", instance);
}

function buildDeliveryKey(record: Pick<ActiveOperationRecord, "contextKey" | "threadId" | "turnId">): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim() || "default";
  return [instance, record.contextKey, record.threadId ?? "pending-thread", record.turnId ?? "pending-turn"].join(":");
}

function readRecoveryLockOwner(lockPath: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? value.pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
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
