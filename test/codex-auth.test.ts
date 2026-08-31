import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "../src/codex-auth.js";

// Helper to make mockExecFile call its callback with success
function mockExecSuccess(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, stdout, stderr);
  });
}

// Helper to make mockExecFile call its callback with a non-zero exit error
function mockExecFailure(stderr: string, stdout = "", code?: string): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const error = new Error("Command failed") as Error & { stderr?: string; stdout?: string; code?: string };
    error.stderr = stderr;
    error.stdout = stdout;
    if (code) {
      error.code = code;
    }
    cb(error, stdout, stderr);
  });
}

// Helper to make mockExecFile throw (ENOENT — command not found)
function mockExecNotFound(): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    cb(error, "", "");
  });
}

interface MockLoginChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function createLoginChild(): MockLoginChild {
  const child = new EventEmitter() as MockLoginChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    process.nextTick(() => child.emit("exit", null, "SIGTERM"));
    return true;
  });
  return child;
}

function mockLoginOutput(chunks: string[], exitCode: number | null = 0): MockLoginChild {
  const child = createLoginChild();
  mockSpawn.mockReturnValue(child);
  process.nextTick(() => {
    for (const chunk of chunks) child.stdout.write(chunk);
    if (exitCode !== null) child.emit("exit", exitCode, null);
  });
  return child;
}

function mockLoginError(code = "ENOENT"): MockLoginChild {
  const child = createLoginChild();
  mockSpawn.mockReturnValue(child);
  process.nextTick(() => {
    child.emit("error", Object.assign(new Error(`spawn codex ${code}`), { code }));
  });
  return child;
}

describe("codex-auth", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockSpawn.mockReset();
    clearAuthCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("checkAuthStatus", () => {
    it("reports authenticated when API key is provided", async () => {
      const status = await checkAuthStatus("sk-test-key");
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("api-key");
      expect(status.detail).toContain("CODEX_API_KEY");
      // Should not call CLI when API key is present
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("reports authenticated when CLI auth succeeds", async () => {
      mockExecSuccess("Logged in as user@example.com");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toContain("user@example.com");
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.stringContaining("node_modules/.bin/codex"),
        ["login", "status"],
        expect.objectContaining({
          env: expect.objectContaining({ PATH: expect.stringContaining("/home/linuxbrew/.linuxbrew/bin") }),
        }),
        expect.any(Function),
      );
    });

    it("reports unauthenticated when CLI auth fails", async () => {
      mockExecFailure("Not logged in");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("Not logged in");
    });

    it("reports unauthenticated when CLI is not found", async () => {
      mockExecNotFound();

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("not found");
    });

    it("handles command timeout (signal termination)", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const error = new Error("Command timed out") as Error & { signal?: string; stderr?: string; stdout?: string };
        error.signal = "SIGTERM";
        error.stderr = "";
        error.stdout = "";
        cb(error, "", "");
      });

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("SIGTERM");
    });

    it("handles empty CLI output gracefully", async () => {
      mockExecSuccess("");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toBe("Authenticated via Codex CLI");
    });

    it("caches results across calls", async () => {
      mockExecSuccess("Logged in");

      const first = await checkAuthStatus();
      const second = await checkAuthStatus();

      expect(first).toEqual(second);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("refreshes after clearAuthCache", async () => {
      mockExecSuccess("Logged in");
      await checkAuthStatus();

      clearAuthCache();
      mockExecSuccess("Still logged in");
      await checkAuthStatus();

      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("startLogin", () => {
    it("returns the device prompt without waiting for the login process to exit", async () => {
      const child = mockLoginOutput([
        "Sign in with a device ",
        "code at https://auth.openai.com/device\nABCD-1234",
      ], null);

      const result = await startLogin();
      expect(result.success).toBe(true);
      expect(result.message).toContain("https://auth.openai.com");
      expect(child.kill).not.toHaveBeenCalled();

      mockExecSuccess("Successfully logged out");
      await startLogout();
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("returns failure when CLI login fails", async () => {
      mockLoginOutput(["Login not supported in this environment"], 1);

      const result = await startLogin();
      expect(result.success).toBe(false);
      expect(result.message).toContain("not supported");
    });

    it("returns failure when CLI is not available", async () => {
      mockLoginError();

      const result = await startLogin();
      expect(result.success).toBe(false);
      expect(result.message).toContain("ENOENT");
    });

    it("reuses an in-progress device prompt", async () => {
      const child = mockLoginOutput([
        "Open https://auth.openai.com/device and enter code ABCD-1234",
      ], null);

      const first = await startLogin();
      const second = await startLogin();

      expect(second).toEqual(first);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      mockExecSuccess("Successfully logged out");
      await startLogout();
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("stops login when no device prompt is produced", async () => {
      vi.useFakeTimers();
      const child = mockLoginOutput([], null);

      const pending = startLogin();
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toMatchObject({ success: false });
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("clears the auth cache", async () => {
      mockExecSuccess("Logged in");
      await checkAuthStatus(); // populate cache
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      mockLoginOutput(["Open https://auth.openai.com/device and enter code ABCD-1234"]);
      await startLogin();

      // After login, cache is cleared so next check should hit CLI
      mockExecSuccess("Logged in as new-user");
      await checkAuthStatus();
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("startLogout", () => {
    it("returns success when CLI logout succeeds", async () => {
      mockExecSuccess("Successfully logged out");

      const result = await startLogout();
      expect(result.success).toBe(true);
      expect(result.message).toContain("logged out");
    });

    it("returns failure when CLI logout fails", async () => {
      mockExecFailure("No session to log out");

      const result = await startLogout();
      expect(result.success).toBe(false);
    });

    it("returns failure when CLI is not available", async () => {
      mockExecNotFound();

      const result = await startLogout();
      expect(result.success).toBe(false);
      expect(result.message).toContain("ENOENT");
    });
  });
});
