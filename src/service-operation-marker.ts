import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";

export type ServiceOperationType = "restart" | "update";

export interface ServiceOperationMarker {
  id: string;
  type: ServiceOperationType;
  instance: string;
  chatId: number | string;
  messageThreadId?: number;
  workspace: string;
  startedAt: number;
  pid?: number;
}

export interface StartServiceOperationMarkerInput {
  type: ServiceOperationType;
  instance: string;
  chatId: number | string;
  messageThreadId?: number;
}

export function startServiceOperationMarker(
  config: TeleCodexConfig,
  input: StartServiceOperationMarkerInput,
): ServiceOperationMarker {
  const marker: ServiceOperationMarker = {
    id: randomUUID(),
    type: input.type,
    instance: input.instance,
    chatId: input.chatId,
    messageThreadId: input.messageThreadId,
    workspace: config.workspace,
    startedAt: Date.now(),
  };
  writeMarkers(config, input.instance, [...readMarkers(config, input.instance), marker]);
  return marker;
}

export function updateServiceOperationMarkerPid(
  config: TeleCodexConfig,
  instance: string,
  id: string,
  pid: number | undefined,
): void {
  if (!pid) {
    return;
  }

  const markers = readMarkers(config, instance).map((marker) =>
    marker.id === id ? { ...marker, pid } : marker,
  );
  writeMarkers(config, instance, markers);
}

export function consumeServiceOperationMarkers(config: TeleCodexConfig): ServiceOperationMarker[] {
  const instance = getCurrentServiceInstanceName();
  const markers = readMarkers(config, instance);
  const filePath = getMarkerPath(config, instance);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (error) {
    console.warn("Failed to clear service operation marker:", error instanceof Error ? error.message : String(error));
  }
  return markers;
}

export function getCurrentServiceInstanceName(): string {
  return process.env.TELECODEX_INSTANCE?.trim() || "default";
}

function readMarkers(config: TeleCodexConfig, instance: string): ServiceOperationMarker[] {
  const filePath = getMarkerPath(config, instance);
  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.filter(isServiceOperationMarker);
  } catch {
    return [];
  }
}

function writeMarkers(config: TeleCodexConfig, instance: string, markers: ServiceOperationMarker[]): void {
  const filePath = getMarkerPath(config, instance);
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(markers.slice(-20), null, 2), "utf8");
  } catch (error) {
    console.warn("Failed to persist service operation marker:", error instanceof Error ? error.message : String(error));
  }
}

function getMarkerPath(config: TeleCodexConfig, instance: string): string {
  if (!instance || instance === "default") {
    return path.join(config.workspace, ".telecodex", "service-operation-marker.json");
  }

  return path.join(config.workspace, ".telecodex", instance, "service-operation-marker.json");
}

function isServiceOperationMarker(value: unknown): value is ServiceOperationMarker {
  if (!value || typeof value !== "object") {
    return false;
  }

  const marker = value as Partial<ServiceOperationMarker>;
  return (
    typeof marker.id === "string" &&
    (marker.type === "restart" || marker.type === "update") &&
    typeof marker.instance === "string" &&
    (typeof marker.chatId === "number" || typeof marker.chatId === "string") &&
    typeof marker.workspace === "string" &&
    typeof marker.startedAt === "number"
  );
}
