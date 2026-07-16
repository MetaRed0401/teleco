import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type UnknownAppServerEventKind = "request" | "notification" | "item" | "parse";

export type UnknownAppServerEvent = {
  kind: UnknownAppServerEventKind;
  name: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  codexVersion: string;
};

const MAX_UNKNOWN_EVENT_TYPES = 32;
const MAX_UNKNOWN_EVENT_FILE_BYTES = 16 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._:/-]+$/;

export function recordUnknownAppServerEvent(options: {
  workspace: string;
  instanceName: string;
  kind: UnknownAppServerEventKind;
  name: string;
  codexVersion?: string;
}): void {
  const name = sanitizeMetadata(options.name, "unknown");
  const codexVersion = sanitizeMetadata(options.codexVersion ?? "unknown", "unknown");
  const now = Date.now();
  const records = readUnknownAppServerEvents(options.workspace, options.instanceName);
  const existing = records.find((record) => record.kind === options.kind && record.name === name);
  if (existing) {
    existing.lastSeen = now;
    existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1);
    existing.codexVersion = codexVersion;
  } else {
    records.push({ kind: options.kind, name, firstSeen: now, lastSeen: now, count: 1, codexVersion });
  }
  writeUnknownAppServerEvents(options.workspace, options.instanceName, records);
}

export function readUnknownAppServerEvents(workspace: string, instanceName: string): UnknownAppServerEvent[] {
  const filePath = getUnknownEventPath(workspace, instanceName);
  try {
    if (!existsSync(filePath) || statSync(filePath).size > MAX_READ_BYTES) return [];
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const events = readRecord(parsed)?.events;
    return Array.isArray(events)
      ? events.filter(isUnknownAppServerEvent).sort((left, right) => right.lastSeen - left.lastSeen).slice(0, MAX_UNKNOWN_EVENT_TYPES)
      : [];
  } catch {
    return [];
  }
}

function writeUnknownAppServerEvents(workspace: string, instanceName: string, input: UnknownAppServerEvent[]): void {
  const filePath = getUnknownEventPath(workspace, instanceName);
  const events = [...input].sort((left, right) => right.lastSeen - left.lastSeen).slice(0, MAX_UNKNOWN_EVENT_TYPES);
  let payload = JSON.stringify({ version: 1, events }, null, 2);
  while (Buffer.byteLength(payload) > MAX_UNKNOWN_EVENT_FILE_BYTES && events.length > 0) {
    events.pop();
    payload = JSON.stringify({ version: 1, events }, null, 2);
  }

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch {
    // Observability must never interrupt the Codex protocol path.
  }
}

function getUnknownEventPath(workspace: string, instanceName: string): string {
  const root = path.join(workspace, ".telecodex");
  const safeInstance = sanitizeMetadata(instanceName, "default");
  return safeInstance === "default"
    ? path.join(root, "app-server-unknown-events.json")
    : path.join(root, safeInstance, "app-server-unknown-events.json");
}

function sanitizeMetadata(value: string, fallback: string): string {
  const trimmed = value.trim().slice(0, 120);
  return trimmed && SAFE_NAME_PATTERN.test(trimmed) ? trimmed : fallback;
}

function isUnknownAppServerEvent(value: unknown): value is UnknownAppServerEvent {
  const record = readRecord(value);
  return Boolean(
    record
    && ["request", "notification", "item", "parse"].includes(String(record.kind))
    && typeof record.name === "string"
    && SAFE_NAME_PATTERN.test(record.name)
    && typeof record.firstSeen === "number"
    && typeof record.lastSeen === "number"
    && typeof record.count === "number"
    && typeof record.codexVersion === "string",
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
