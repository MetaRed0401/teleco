import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";

type ConsoleMethod = "log" | "warn" | "error";

let installed = false;

export function installRuntimeFileLogger(config: TeleCodexConfig): string | undefined {
  if (installed) {
    return undefined;
  }
  installed = true;

  const logPath = runtimeLogPath(config);
  mkdirSync(path.dirname(logPath), { recursive: true });

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  for (const method of ["log", "warn", "error"] as const) {
    console[method] = (...args: unknown[]): void => {
      writeLogLine(logPath, method, args);
      original[method](...args);
    };
  }

  return logPath;
}

function runtimeLogPath(config: TeleCodexConfig): string {
  const instance = process.env.TELECODEX_INSTANCE?.trim() || "default";
  const baseDir =
    instance === "default"
      ? path.join(config.workspace, ".telecodex")
      : path.join(config.workspace, ".telecodex", instance);
  return path.join(baseDir, "service.log");
}

function writeLogLine(logPath: string, method: ConsoleMethod, args: unknown[]): void {
  const level = method === "log" ? "INFO" : method.toUpperCase();
  const message = args.map(formatLogValue).join(" ");
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${message}\n`, "utf8");
  } catch {
    // Do not let logging failures break the Telegram bridge.
  }
}

function formatLogValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
