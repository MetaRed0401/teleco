import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { buildCodexAppServerEnvironment, CodexAppServerClient } from "../src/codex-app-server-client.js";

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

  it("maps Codex-only proxy settings without mutating Telegram process settings", () => {
    const base = {
      HTTP_PROXY: "http://telegram-proxy.invalid",
      CODEX_HTTP_PROXY: "http://codex-proxy.invalid",
      CODEX_HTTPS_PROXY: "https://codex-proxy.invalid",
      CODEX_NO_PROXY: "127.0.0.1,localhost",
      CODEX_NODE_EXTRA_CA_CERTS: "/run/secrets/codex-ca.pem",
    };

    const result = buildCodexAppServerEnvironment(base);
    expect(result).toMatchObject({
      HTTP_PROXY: "http://codex-proxy.invalid",
      HTTPS_PROXY: "https://codex-proxy.invalid",
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: "/run/secrets/codex-ca.pem",
    });
    expect(result.CODEX_HTTP_PROXY).toBeUndefined();
    expect(base.HTTP_PROXY).toBe("http://telegram-proxy.invalid");
  });
});
