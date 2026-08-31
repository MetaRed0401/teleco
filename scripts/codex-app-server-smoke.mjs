#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "telecodex-app-server-smoke-"));
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "workspace");
const schemaDir = path.join(root, "schema");
const stableSchemaDir = path.join(root, "schema-stable");
const configuredCodexBinary = process.env.CODEX_BIN?.trim() || "codex";
const codexBinary = configuredCodexBinary.includes(path.sep)
  ? path.resolve(configuredCodexBinary)
  : configuredCodexBinary;
const compatVersion = process.env.CODEX_COMPAT_VERSION?.trim();
const compatMinor = readCodexMinor(compatVersion);
const expect0146 = compatMinor !== undefined && compatMinor >= 146;
const expect0147 = compatMinor !== undefined && compatMinor >= 147;
const expect0148 = compatMinor !== undefined && compatMinor >= 148;
const expect0149 = compatMinor !== undefined && compatMinor >= 149;
const expect0150 = compatMinor !== undefined && compatMinor >= 150;
const expect0151 = compatMinor !== undefined && compatMinor >= 151;
mkdirSync(codexHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
let stage = "schema generation";
let client;

try {
  const schema = spawnSync(codexBinary, ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: "ignore",
    timeout: 15_000,
  });
  if (schema.status !== 0) throw new Error("schema");
  const schemaText = readSchemaTree(schemaDir);
  for (const protocolName of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
    "thread/compact/start",
    "thread/unsubscribe",
    "thread/deleted",
    "thread/settings/updated",
    "account/rateLimits/updated",
    "item/started",
    "item/completed",
  ]) {
    if (!schemaText.includes(protocolName)) throw new Error("schema contract");
  }
  if (expect0146) {
    for (const protocolName of [
      "thread/turns/list",
      "thread/items/list",
      "thread/name/set",
      "thread/metadata/update",
      "config/mcpServer/reload",
      "mcpServerStatus/list",
    ]) {
      if (!schemaText.includes(protocolName)) throw new Error("0.146 schema contract");
    }
  }
  if (expect0147) {
    for (const protocolName of [
      "thread/section/move",
      "threadSection/create",
      "threadSection/list",
      "threadSection/update",
      "threadSection/delete",
      "thread/search",
      "plugin/search",
      "ThreadSectionCreateParams",
      "ThreadSectionListParams",
      "ThreadSectionUpdateParams",
      "ThreadSectionMoveParams",
      "ThreadSectionDeleteParams",
      "ThreadSearchSortKey",
      "PluginSearchResult",
      "PluginDisabledReason",
      "CommandExecutionRequestApprovalParams",
    ]) {
      if (!schemaText.includes(protocolName)) throw new Error("0.147 schema contract");
    }
  }
  if (expect0148) {
    for (const protocolName of [
      "thread/queue/add",
      "thread/queue/list",
      "thread/queue/update",
      "thread/queue/delete",
      "thread/queue/reorder",
      "thread/queue/start",
      "thread/queue/changed",
      "thread/revert",
      "thread/reverted",
      "ThreadUsage",
      "isBlocking",
      "hook/started",
      "hook/completed",
      "ThreadSectionAppearance",
      "ImageGenerationFailure",
    ]) {
      if (!schemaText.includes(protocolName)) throw new Error("0.148 schema contract");
    }
  }
  if (expect0149) {
    for (const protocolName of [
      "project/changed",
      "thread/project/updated",
      "autoApprovalReview/strictReviewRequired",
      "McpResourceReadParams",
      "originCallId",
      "connectorId",
      "appContext",
      "delivery",
    ]) {
      if (!schemaText.includes(protocolName)) throw new Error("0.149 schema contract");
    }
  }
  if (expect0150) {
    for (const protocolName of [
      "CommandExecutionApprovalKind",
      "writeStdin",
      "McpServerConnectionStatus",
      "runtimeStatus",
      "mcpServer/event/stream/start",
      "mcpServer/event/stream/stop",
      "mcpServer/event/stream/notification",
      "ThreadRealtimeItem",
      "thread/realtime/item/started",
      "thread/realtime/item/completed",
      "thread/realtime/item/transcript/delta",
      "ThreadTimelineEntry",
      "thread/timeline/list",
    ]) {
      if (!schemaText.includes(protocolName)) throw new Error("0.150 schema contract");
    }
  }
  if (expect0151) {
    stage = "0.151 stable schema generation";
    const stableSchema = spawnSync(codexBinary, ["app-server", "generate-json-schema", "--out", stableSchemaDir], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: "ignore",
      timeout: 15_000,
    });
    if (stableSchema.status !== 0) throw new Error("0.151 stable schema");
    assertSchemaFileContains(stableSchemaDir, "ClientRequest.json", [
      "thread/turns/list",
      "thread/items/list",
      "thread/revert",
    ]);
    assertSchemaFileContains(stableSchemaDir, "v2/ThreadReadResponse.json", ["ThreadHistoryMode", "historyMode"]);
    assertSchemaFileContains(stableSchemaDir, "v2/ThreadResumeParams.json", ["excludeTurns"]);
    assertSchemaFileContains(stableSchemaDir, "v2/ThreadForkParams.json", ["excludeTurns"]);
    assertSchemaFileContains(stableSchemaDir, "v2/RawResponseCompletedNotification.json", [
      "ResponseUsageMetadata",
      "usageMetadata",
    ]);
    assertSchemaFileContains(schemaDir, "v2/TurnSettingsUpdateParams.json", ["TurnSettingsUpdateParams"]);
  }

  stage = "initialize";
  client = createClient(codexHome, workspace);
  await client.request("initialize", {
    clientInfo: { name: "telecodex-ci", title: "TeleCodex CI", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
  });
  client.notify("initialized", {});

  stage = "thread start";
  const started = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("thread id");

  stage = "thread read";
  const threadRead = await client.request("thread/read", { threadId, includeTurns: false });
  if (expect0149 && !("projectId" in (threadRead?.thread ?? {}))) {
    throw new Error("0.149 thread project contract");
  }
  if (expect0146) {
    stage = "0.146 thread history";
    try {
      await client.request("thread/turns/list", {
        threadId,
        limit: 10,
        sortDirection: "desc",
        itemsView: "full",
      });
    } catch (error) {
      if (error?.rpcCode !== -32600) throw error;
    }
    if (!expect0147) {
      stage = "0.146 thread metadata";
      await client.request("thread/name/set", { threadId, name: "telecodex-ci" });
      await client.request("thread/metadata/update", { threadId, isPinned: false });
    }
    stage = "native MCP refresh";
    await client.request("config/mcpServer/reload", {});
    const mcpStatus = await client.request("mcpServerStatus/list", {});
    if (expect0150) {
      const knownRuntimeStatuses = new Set([
        "notStarted",
        "starting",
        "connected",
        "authenticationRequired",
        "failed",
        "cancelled",
        "disabled",
      ]);
      for (const status of Array.isArray(mcpStatus?.data) ? mcpStatus.data : []) {
        if (
          status?.runtimeStatus !== undefined
          && status.runtimeStatus !== null
          && !knownRuntimeStatuses.has(status.runtimeStatus)
        ) {
          throw new Error("0.150 MCP runtime status contract");
        }
      }
    }
  }
  if (expect0151) {
    stage = "0.151 thread items";
    try {
      await client.request("thread/items/list", {
        threadId,
        limit: 10,
        sortDirection: "desc",
      });
    } catch (error) {
      // 0.151.0 advertises the stable schema before enabling this runtime method.
      if (error?.rpcCode !== -32601) throw error;
    }
  }
  if (expect0147) {
    stage = "0.147 thread search";
    await client.request("thread/search", {
      searchTerm: "telecodex-ci",
      limit: 10,
      sortKey: "recency_at",
      sortDirection: "desc",
    });
    stage = "0.147 thread section create";
    const createdSection = await client.request("threadSection/create", { name: "telecodex-ci" });
    const sectionId = createdSection?.section?.id;
    if (typeof sectionId !== "string" || !sectionId) throw new Error("thread section id");
    stage = "0.147 thread section list";
    await client.request("threadSection/list", { limit: 10 });
    stage = "0.147 thread section update";
    await client.request("threadSection/update", { sectionId, name: "telecodex-ci-updated" });
    stage = "0.147 thread section delete";
    await client.request("threadSection/delete", { sectionId });
  }
  if (expect0148) {
    stage = "0.148 empty thread queue list";
    const queue = await client.request("thread/queue/list", { threadId, limit: 100 });
    if (!Array.isArray(queue?.data)) throw new Error("thread queue list response");
    stage = "0.148 thread usage";
    try {
      await client.request("account/usage/read", { threadId });
    } catch (error) {
      // A newly created empty thread may not have a persisted usage record yet.
      if (error?.rpcCode !== -32600) throw error;
    }
  }

  stage = "thread unsubscribe";
  const unsubscribeResult = await client.request("thread/unsubscribe", { threadId });
  if (unsubscribeResult?.status !== "unsubscribed") throw new Error("thread unsubscribe response");

  stage = "app-server restart";
  await client.close();
  client = createClient(codexHome, workspace);
  await client.request("initialize", {
    clientInfo: { name: "telecodex-ci", title: "TeleCodex CI", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
  });
  client.notify("initialized", {});
  stage = "thread resume after restart";
  try {
    await client.request("thread/resume", { threadId, excludeTurns: true });
  } catch (error) {
    if (typeof error?.rpcCode !== "number" || error.rpcCode === -32601) throw error;
  }
  console.log("Codex app-server compatibility smoke passed.");
} catch (error) {
  const rpcCode = typeof error?.rpcCode === "number" ? ` (RPC ${error.rpcCode})` : "";
  const rpcMessage = typeof error?.rpcMessage === "string" ? `: ${error.rpcMessage}` : "";
  console.error(`Codex app-server compatibility smoke failed during ${stage}${rpcCode}${rpcMessage}.`);
  process.exitCode = 1;
} finally {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
}

function createClient(home, cwd) {
  const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          const request = pending.get(message.id);
          if (request) {
            clearTimeout(request.timer);
            pending.delete(message.id);
            if (message.error) {
              const failure = new Error("app-server request failed");
              failure.rpcCode = typeof message.error.code === "number" ? message.error.code : undefined;
              failure.rpcMessage = typeof message.error.message === "string" ? message.error.message : undefined;
              request.reject(failure);
            } else {
              request.resolve(message.result);
            }
          }
        } catch {
          // Ignore non-protocol stdout without retaining it.
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.once("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("app-server exited"));
    }
    pending.clear();
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("app-server request timed out"));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

function readSchemaTree(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? readSchemaTree(entryPath) : entry.name.endsWith(".json") ? readFileSync(entryPath, "utf8") : "";
    })
    .join("\n");
}

function assertSchemaFileContains(rootDirectory, relativePath, expectedValues) {
  const content = readFileSync(path.join(rootDirectory, relativePath), "utf8");
  for (const expected of expectedValues) {
    if (!content.includes(expected)) throw new Error(`0.151 schema contract: ${relativePath}`);
  }
}

function readCodexMinor(version) {
  const match = /^(?:codex-cli\s+)?0\.(\d+)\./.exec(version ?? "");
  return match ? Number(match[1]) : undefined;
}
