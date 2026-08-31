import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { resolveCodexCliPath } from "./codex-cli-path.js";

export interface AuthStatus {
  authenticated: boolean;
  method: "api-key" | "cli" | "none";
  detail: string;
}

export interface LoginResult {
  success: boolean;
  message: string;
}

interface ActiveLoginState {
  child: ChildProcessWithoutNullStreams;
  prompt?: string;
  startResult: Promise<LoginResult>;
}

const COMMAND_TIMEOUT_MS = 10_000;
const AUTH_CACHE_TTL_MS = 30_000;
const LOGIN_PROMPT_TIMEOUT_MS = 15_000;
const LOGIN_LIFECYCLE_TIMEOUT_MS = 15 * 60_000;
const LOGIN_OUTPUT_LIMIT = 8_000;

let cachedAuthStatus: { status: AuthStatus; expiresAt: number } | undefined;
let activeLogin: ActiveLoginState | undefined;

/**
 * Check whether Codex is currently authenticated.
 *
 * Priority:
 * 1. If CODEX_API_KEY is set in the environment, report authenticated via API key.
 * 2. Otherwise, shell out to `codex login status` to check CLI auth.
 * 3. If the CLI command fails or is unavailable, report unauthenticated.
 *
 * Results are cached for 30 seconds to avoid per-message CLI invocations.
 */
export async function checkAuthStatus(
  apiKey?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AuthStatus> {
  if (apiKey) {
    return {
      authenticated: true,
      method: "api-key",
      detail: "Authenticated via CODEX_API_KEY",
    };
  }

  if (cachedAuthStatus && Date.now() < cachedAuthStatus.expiresAt) {
    return cachedAuthStatus.status;
  }

  try {
    const { stdout } = await runCodexCommand(["login", "status"], environment);
    const output = stdout.trim();
    const status: AuthStatus = {
      authenticated: true,
      method: "cli",
      detail: output || "Authenticated via Codex CLI",
    };
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return status;
  } catch (error) {
    const status = parseCommandError(error);
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return status;
  }
}

/**
 * Clear the cached auth status so the next check hits the CLI.
 */
export function clearAuthCache(): void {
  cachedAuthStatus = undefined;
}

/**
 * Attempt to start a login flow via the Codex CLI.
 * Uses --device-auth to get a device code flow suitable for headless/remote hosts.
 */
export async function startLogin(environment: NodeJS.ProcessEnv = process.env): Promise<LoginResult> {
  clearAuthCache();

  if (activeLogin?.prompt) {
    return { success: true, message: activeLogin.prompt };
  }
  if (activeLogin) {
    return activeLogin.startResult;
  }

  const resolved = resolveCodexCliPath(environment);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(resolved.command, ["login", "--device-auth"], {
      env: { ...environment, PATH: resolved.path },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      success: false,
      message: extractErrorMessage(error) || "Login command failed. Try running 'codex login' on the host.",
    };
  }

  let loginState: ActiveLoginState;
  const startResult = new Promise<LoginResult>((resolve) => {
    let output = "";
    let startSettled = false;

    const settleStart = (result: LoginResult): void => {
      if (startSettled) return;
      startSettled = true;
      clearTimeout(promptTimer);
      resolve(result);
    };

    const publishPrompt = (): void => {
      const prompt = cleanLoginOutput(output);
      if (!prompt) return;
      loginState.prompt = prompt;
      settleStart({ success: true, message: prompt });
    };

    const appendOutput = (chunk: Buffer): void => {
      output = trimTail(output + chunk.toString("utf8"), LOGIN_OUTPUT_LIMIT);
      const cleaned = cleanLoginOutput(output);
      if (hasDeviceLoginInstructions(cleaned)) {
        publishPrompt();
      }
    };

    const promptTimer = setTimeout(() => {
      const detail = cleanLoginOutput(output);
      settleStart({
        success: false,
        message: detail || "Codex login did not provide a device authorization prompt. Try running 'codex login' on the host.",
      });
      child.kill();
    }, LOGIN_PROMPT_TIMEOUT_MS);
    promptTimer.unref();

    const lifecycleTimer = setTimeout(() => {
      child.kill();
    }, LOGIN_LIFECYCLE_TIMEOUT_MS);
    lifecycleTimer.unref();

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => {
      clearTimeout(lifecycleTimer);
      settleStart({
        success: false,
        message: extractErrorMessage(error) || "Login command failed. Try running 'codex login' on the host.",
      });
      if (activeLogin === loginState) activeLogin = undefined;
    });
    child.on("exit", (code, signal) => {
      clearTimeout(lifecycleTimer);
      const detail = cleanLoginOutput(output);
      if (!startSettled) {
        settleStart(code === 0
          ? { success: true, message: detail || "Codex login completed." }
          : {
            success: false,
            message: detail || `Codex login exited before authorization (${code ?? signal ?? "unknown"}).`,
          });
      }
      clearAuthCache();
      if (activeLogin === loginState) activeLogin = undefined;
    });
  });

  loginState = { child, startResult };
  activeLogin = loginState;
  return startResult;
}

/**
 * Attempt to logout via the Codex CLI.
 */
export async function startLogout(environment: NodeJS.ProcessEnv = process.env): Promise<LoginResult> {
  clearAuthCache();
  await cancelActiveLogin();

  try {
    const { stdout } = await runCodexCommand(["logout"], environment);
    const output = stdout.trim();
    return {
      success: true,
      message: output || "Logged out successfully.",
    };
  } catch (error) {
    const detail = extractErrorMessage(error);
    return {
      success: false,
      message: detail || "Logout command failed. Try running 'codex logout' on the host.",
    };
  }
}

function runCodexCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveCodexCliPath(environment);
  return new Promise((resolve, reject) => {
    execFile(
      resolved.command,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        env: { ...environment, PATH: resolved.path },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Attach stdout/stderr to the error for richer diagnostics
          const enriched = error as Error & { stdout?: string; stderr?: string };
          enriched.stdout = typeof stdout === "string" ? stdout : "";
          enriched.stderr = typeof stderr === "string" ? stderr : "";
          reject(enriched);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

async function cancelActiveLogin(): Promise<void> {
  const login = activeLogin;
  activeLogin = undefined;
  if (!login) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    timer.unref();
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    login.child.once("exit", finish);
    login.child.once("error", finish);
    try {
      if (!login.child.kill()) finish();
    } catch {
      finish();
    }
  });
}

function hasDeviceLoginInstructions(output: string): boolean {
  return /https?:\/\/\S+/i.test(output) && /\b(code|device|login|sign[ -]?in)\b/i.test(output);
}

function cleanLoginOutput(output: string): string {
  return output
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function trimTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(-maxLength);
}

function parseCommandError(error: unknown): AuthStatus {
  const errno = (error as NodeJS.ErrnoException)?.code;
  if (errno === "ENOENT") {
    return {
      authenticated: false,
      method: "none",
      detail: "Codex CLI not found. Install it or set CODEX_API_KEY.",
    };
  }

  const detail = extractErrorMessage(error) || "Not authenticated";
  return {
    authenticated: false,
    method: "none",
    detail,
  };
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const enriched = error as { stderr?: string; stdout?: string; message?: string; signal?: string };
    const stderr = enriched.stderr?.trim();
    if (stderr) {
      return stderr;
    }
    const stdout = enriched.stdout?.trim();
    if (stdout) {
      return stdout;
    }
    if (enriched.signal) {
      return `Command terminated with signal ${enriched.signal}.`;
    }
    if (enriched.message) {
      return enriched.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
