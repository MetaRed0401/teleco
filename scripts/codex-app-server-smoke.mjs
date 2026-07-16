#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "telecodex-app-server-smoke-"));
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "workspace");
const schemaDir = path.join(root, "schema");
mkdirSync(codexHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
let stage = "schema generation";
let client;

try {
  const schema = spawnSync("codex", ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir], {
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
    "item/started",
    "item/completed",
  ]) {
    if (!schemaText.includes(protocolName)) throw new Error("schema contract");
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
} catch {
  console.error(`Codex app-server compatibility smoke failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
}

function createClient(home, cwd) {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
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
