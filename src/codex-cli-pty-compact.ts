import * as pty from "node-pty";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type { CodexSessionInfo } from "./codex-session.js";

const CLI_COMPACT_TIMEOUT_MS = 20 * 60 * 1000;
const CLI_READY_FALLBACK_MS = 2500;
const OUTPUT_PREVIEW_LIMIT = 4000;

export interface CliPtyCompactResult {
  threadId: string;
  elapsedMs: number;
  outputPreview: string;
}

export async function runCliPtyCompact(
  info: CodexSessionInfo,
  options: { signal?: AbortSignal } = {},
): Promise<CliPtyCompactResult> {
  if (!info.threadId) {
    throw new Error("No active Codex thread to compact.");
  }
  if (options.signal?.aborted) {
    throw new Error("CLI compact was aborted.");
  }

  const startedAt = Date.now();
  let output = "";
  let compactSent = false;
  let settled = false;
  let readyTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const resolvedCodexCli = resolveCodexCliPath();

  return await new Promise<CliPtyCompactResult>((resolve, reject) => {
    let child: pty.IPty;
    try {
      child = pty.spawn(resolvedCodexCli.command, ["resume", info.threadId!], {
        cwd: info.workspace,
        env: {
          ...process.env,
          PATH: resolvedCodexCli.path,
        },
        cols: 120,
        rows: 30,
        name: "xterm-256color",
      });
    } catch (error) {
      reject(new Error(formatSpawnFailure(error, resolvedCodexCli)));
      return;
    }

    const cleanup = (): void => {
      readyTimer && clearTimeout(readyTimer);
      timeoutTimer && clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        child.kill();
      } catch {
        // Ignore process cleanup failures.
      }
      fn();
    };

    const fail = (error: Error): void => {
      settle(() => reject(error));
    };

    const sendCompact = (): void => {
      if (settled || compactSent) {
        return;
      }
      compactSent = true;
      child.write("/compact\r");
    };

    const onAbort = (): void => {
      fail(new Error("CLI compact was aborted."));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      fail(new Error(`Timed out waiting for CLI compact completion. ${formatOutputPreview(output)}`.trim()));
    }, CLI_COMPACT_TIMEOUT_MS);
    readyTimer = setTimeout(sendCompact, CLI_READY_FALLBACK_MS);

    child.onData((data) => {
      output = appendOutput(output, data);
      const plain = stripAnsi(output);

      if (!compactSent && isCliReady(plain)) {
        sendCompact();
        return;
      }

      if (compactSent && isCompactComplete(plain)) {
        settle(() =>
          resolve({
            threadId: info.threadId!,
            elapsedMs: Date.now() - startedAt,
            outputPreview: formatOutputPreview(output),
          }),
        );
      }
    });

    child.onExit(({ exitCode, signal }) => {
      if (settled) {
        return;
      }
      if (!compactSent) {
        fail(new Error(`Codex CLI exited before /compact was sent (${exitCode ?? signal}).`));
        return;
      }
      fail(new Error(`Codex CLI exited before compact completion (${exitCode ?? signal}). ${formatOutputPreview(output)}`.trim()));
    });
  });
}

function isCliReady(output: string): boolean {
  return /OpenAI Codex|Session:|Context window|\/status|^\s*>/im.test(output);
}

function isCompactComplete(output: string): boolean {
  return /compacted|compaction complete|compact complete|context compacted|conversation compacted/i.test(output);
}

function appendOutput(current: string, next: string): string {
  const combined = current + next;
  return combined.length > OUTPUT_PREVIEW_LIMIT ? combined.slice(-OUTPUT_PREVIEW_LIMIT) : combined;
}

function formatOutputPreview(output: string): string {
  return stripAnsi(output).replace(/\r/g, "").trim().slice(-OUTPUT_PREVIEW_LIMIT);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function resolveCodexCliPath(): { command: string; path: string; checked: string[] } {
  const pathValue = buildCodexCliPath();
  const checked: string[] = [];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, "codex");
    checked.push(candidate);
    if (isExecutable(candidate)) {
      return { command: candidate, path: pathValue, checked };
    }
  }

  return { command: "codex", path: pathValue, checked };
}

function buildCodexCliPath(): string {
  const home = process.env.HOME;
  const candidates = [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    home ? path.join(home, ".local", "bin") : undefined,
    home ? path.join(home, "bin") : undefined,
    home ? path.join(home, ".bun", "bin") : undefined,
    home ? path.join(home, ".npm-global", "bin") : undefined,
  ];

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const candidate of candidates) {
    for (const dir of (candidate ?? "").split(path.delimiter)) {
      if (!dir || seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(path.delimiter);
}

function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) {
      return false;
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function formatSpawnFailure(error: unknown, resolved: { command: string; path: string; checked: string[] }): string {
  const message = error instanceof Error ? error.message : String(error);
  const checked = resolved.checked.slice(0, 20).map((item) => {
    try {
      return `${item} -> ${realpathSync(item)}`;
    } catch {
      return item;
    }
  });

  return [
    `Failed to start Codex CLI for compact: ${message}`,
    `command: ${resolved.command}`,
    `cwd PATH: ${resolved.path}`,
    process.env.HOME ? `HOME: ${process.env.HOME}` : undefined,
    process.env.SHELL ? `SHELL: ${process.env.SHELL}` : undefined,
    checked.length > 0 ? `checked: ${checked.join(", ")}` : undefined,
    "Install Codex CLI in a standard Homebrew/user bin path or make sure launchd/start.sh PATH includes it.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
