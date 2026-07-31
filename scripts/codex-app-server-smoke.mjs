#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "telecodex-app-server-smoke-"));
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "workspace");
const schemaDir = path.join(root, "schema");
const codexBinary = process.env.CODEX_BIN?.trim() || "codex";
const expect0146 = process.env.CODEX_EXPECT_0146 === "true";
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
  await client.request("thread/read", { threadId, includeTurns: false });
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
    stage = "0.146 thread metadata";
    await client.request("thread/name/set", { threadId, name: "telecodex-ci" });
    await client.request("thread/metadata/update", { threadId, isPinned: false });
    stage = "0.146 MCP refresh";
    await client.request("config/mcpServer/reload", {});
    await client.request("mcpServerStatus/list", {});
  }

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
    await client.request("thread/resume", { threadId, cwd: workspace, sandbox: "read-only", excludeTurns: true });
  } catch (error) {
    if (typeof error?.rpcCode !== "number" || error.rpcCode === -32601) throw error;
  }
  console.log("Codex app-server compatibility smoke passed.");
} catch (error) {
  const rpcCode = typeof error?.rpcCode === "number" ? ` (RPC ${error.rpcCode})` : "";
  console.error(`Codex app-server compatibility smoke failed during ${stage}${rpcCode}.`);
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
