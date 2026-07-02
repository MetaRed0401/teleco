import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { CodexAppServerClient } from "../src/codex-app-server-client.js";

describe("CodexAppServerClient", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects initialize when the Codex app-server process cannot spawn", async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn();

      process.nextTick(() => {
        child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
      });

      return child;
    });

    const client = new CodexAppServerClient({ cwd: "/workspace" });

    await expect(client.initialize()).rejects.toThrow("Failed to start Codex app-server: spawn codex ENOENT");
    expect(client.isRunning()).toBe(false);
    expect(client.getClosedReason()).toContain("TELECODEX_LAUNCHD_PATH");
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expect.stringContaining("/opt/homebrew/bin"),
        }),
      }),
    );
  });
});
