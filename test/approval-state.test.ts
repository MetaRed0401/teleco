import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPROVAL_REQUEST_TTL_MS,
  findPersistedApprovalState,
  finishPersistedApproval,
  persistPendingApproval,
} from "../src/approval-state.js";
import { fingerprintApprovalRequest } from "../src/bot.js";
import type { TeleCodexConfig } from "../src/config.js";
import type { TelegramContextKey } from "../src/context-key.js";

describe("approval state isolation", () => {
  let workspace: string;
  let previousInstance: string | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "telecodex-approval-"));
    previousInstance = process.env.TELECODEX_INSTANCE;
    process.env.TELECODEX_INSTANCE = "approval-test";
  });

  afterEach(() => {
    if (previousInstance === undefined) {
      delete process.env.TELECODEX_INSTANCE;
    } else {
      process.env.TELECODEX_INSTANCE = previousInstance;
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps protocol identity stable while separating meaningful fields", () => {
    const base = {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-a",
        command: "printf safe",
        cwd: "/workspace/a",
        reason: "network access",
        startedAtMs: 100,
      },
    };
    const reordered = {
      method: base.method,
      params: {
        startedAtMs: 200,
        reason: "network access",
        cwd: "/workspace/a",
        command: "printf safe",
        itemId: "item-a",
        turnId: "turn-a",
        threadId: "thread-a",
      },
    };

    expect(fingerprintApprovalRequest(base, "first")).toBe(fingerprintApprovalRequest(reordered, "first"));
    expect(fingerprintApprovalRequest(base, "first")).not.toBe(
      fingerprintApprovalRequest({ ...base, params: { ...base.params, turnId: "turn-b" } }, "first"),
    );
    expect(fingerprintApprovalRequest(base, "first")).not.toBe(fingerprintApprovalRequest(base, "second"));
  });

  it("keeps persisted records scoped to their Telegram context", () => {
    const config = { workspace } as TeleCodexConfig;
    const contextKey = "chat:1" as TelegramContextKey;
    const now = Date.now();
    persistPendingApproval(config, {
      id: "approval-a",
      fingerprint: "fingerprint-a",
      contextKey,
      chatId: 1,
      messageId: 2,
      method: "item/fileChange/requestApproval",
      createdAt: now,
      expiresAt: now + APPROVAL_REQUEST_TTL_MS,
    });

    expect(findPersistedApprovalState(config, "approval-a", contextKey)?.status).toBe("pending");
    expect(findPersistedApprovalState(config, "approval-a", "chat:2" as TelegramContextKey)).toBeUndefined();

    finishPersistedApproval(config, "approval-a", "resolved", "decline");
    expect(findPersistedApprovalState(config, "approval-a", contextKey)).toMatchObject({
      status: "resolved",
      decision: "decline",
    });
  });

  it("uses a bounded five-minute approval lifetime", () => {
    expect(APPROVAL_REQUEST_TTL_MS).toBe(5 * 60 * 1000);
  });
});
