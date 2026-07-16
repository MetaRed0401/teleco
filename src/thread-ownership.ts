import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TelegramContextKey } from "./context-key.js";

type ThreadOwnershipRecord = {
  threadId: string;
  instanceName: string;
  contextKey: TelegramContextKey;
  createdAt: number;
};

export function claimThreadOwnership(
  workspace: string,
  contextKey: TelegramContextKey,
  threadId: string,
): boolean {
  const ownerPath = getOwnerPath(workspace, threadId);
  const instanceName = currentInstanceName();
  mkdirSync(path.dirname(ownerPath), { recursive: true, mode: 0o700 });

  try {
    const descriptor = openSync(ownerPath, "wx", 0o600);
    const record: ThreadOwnershipRecord = {
      threadId,
      instanceName,
      contextKey,
      createdAt: Date.now(),
    };
    writeFileSync(descriptor, JSON.stringify(record, null, 2), "utf8");
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }

  const owner = readThreadOwnership(ownerPath);
  if (owner?.threadId === threadId && owner.instanceName === instanceName && owner.contextKey === contextKey) {
    return false;
  }
  if (!owner) {
    throw new Error(`Thread ownership metadata is unreadable for ${threadId}. Refusing to attach.`);
  }
  throw new Error(
    `Thread ${threadId} is already attached to another Teleco instance or Telegram context. Use /handback there first.`,
  );
}

export function releaseThreadOwnership(
  workspace: string,
  contextKey: TelegramContextKey,
  threadId: string,
): void {
  const ownerPath = getOwnerPath(workspace, threadId);
  const owner = readThreadOwnership(ownerPath);
  if (owner?.threadId !== threadId || owner.instanceName !== currentInstanceName() || owner.contextKey !== contextKey) {
    return;
  }
  try {
    unlinkSync(ownerPath);
  } catch {
    // A concurrent handback or cleanup may already have removed the claim.
  }
}

function getOwnerPath(workspace: string, threadId: string): string {
  const name = createHash("sha256").update(threadId).digest("hex");
  return path.join(workspace, ".telecodex", "thread-owners", `${name}.json`);
}

function readThreadOwnership(ownerPath: string): ThreadOwnershipRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<ThreadOwnershipRecord>;
    if (
      typeof value.threadId === "string"
      && typeof value.instanceName === "string"
      && typeof value.contextKey === "string"
      && typeof value.createdAt === "number"
    ) {
      return value as ThreadOwnershipRecord;
    }
  } catch {
    // Invalid ownership metadata is handled fail-closed by the caller.
  }
  return undefined;
}

function currentInstanceName(): string {
  return process.env.TELECODEX_INSTANCE?.trim() || "default";
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
