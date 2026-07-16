import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readUnknownAppServerEvents,
  recordUnknownAppServerEvent,
} from "../src/app-server-observability.js";

describe("unknown app-server event observability", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "telecodex-unknown-events-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("stores bounded metadata without unsafe names or payload content", () => {
    const secretMarker = "payload secret marker";
    recordUnknownAppServerEvent({
      workspace,
      instanceName: "first",
      kind: "notification",
      name: secretMarker,
      codexVersion: "0.144.4",
    });
    for (let index = 0; index < 40; index += 1) {
      recordUnknownAppServerEvent({
        workspace,
        instanceName: "first",
        kind: "item",
        name: `futureItem${index}`,
        codexVersion: "0.144.4",
      });
    }

    const events = readUnknownAppServerEvents(workspace, "first");
    const filePath = path.join(workspace, ".telecodex", "first", "app-server-unknown-events.json");
    const stored = readFileSync(filePath, "utf8");
    expect(events).toHaveLength(32);
    expect(stored).not.toContain(secretMarker);
    expect(statSync(filePath).size).toBeLessThanOrEqual(16 * 1024);
  });

  it("increments a known metadata key without storing a second type", () => {
    const input = {
      workspace,
      instanceName: "first",
      kind: "request" as const,
      name: "future/request",
      codexVersion: "0.144.4",
    };
    recordUnknownAppServerEvent(input);
    recordUnknownAppServerEvent(input);

    expect(readUnknownAppServerEvents(workspace, "first")).toMatchObject([
      { kind: "request", name: "future/request", count: 2, codexVersion: "0.144.4" },
    ]);
  });
});
