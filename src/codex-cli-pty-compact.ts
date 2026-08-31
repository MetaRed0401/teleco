import * as pty from "node-pty";
import { realpathSync } from "node:fs";

import { resolveCodexCliPath, type ResolvedCodexCli } from "./codex-cli-path.js";
import type { CodexSessionInfo } from "./codex-session.js";

const CLI_COMPACT_TIMEOUT_MS = 20 * 60 * 1000;
const CLI_READY_FALLBACK_MS = 2500;
const CLI_READY_RETRY_MS = 1000;
const CLI_RESUME_MAX_WAIT_MS = 30_000;
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
  let phaseOutput = "";
  let compactSent = false;
  let trustPromptHandled = false;
  let settled = false;
  let readyWaitStartedAt = startedAt;
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
      phaseOutput = "";
      child.write("/compact\r");
    };

    const scheduleCompact = (delayMs: number): void => {
      readyTimer && clearTimeout(readyTimer);
      readyTimer = setTimeout(() => {
        readyTimer = undefined;
        const plain = stripTerminalControlSequences(phaseOutput);
        if (!trustPromptHandled && isWorkspaceTrustPrompt(plain)) {
          trustPromptHandled = true;
          phaseOutput = "";
          readyWaitStartedAt = Date.now();
          child.write("\r");
          scheduleCompact(CLI_READY_FALLBACK_MS);
          return;
        }
        if (isResumePending(plain) && Date.now() - readyWaitStartedAt < CLI_RESUME_MAX_WAIT_MS) {
          scheduleCompact(CLI_READY_RETRY_MS);
          return;
        }
        sendCompact();
      }, delayMs);
    };

    const onAbort = (): void => {
      fail(new Error("CLI compact was aborted."));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      fail(new Error(`Timed out waiting for CLI compact completion. ${formatOutputPreview(output)}`.trim()));
    }, CLI_COMPACT_TIMEOUT_MS);
    scheduleCompact(CLI_READY_FALLBACK_MS);

    child.onData((data) => {
      output = appendOutput(output, data);
      phaseOutput = appendOutput(phaseOutput, data);
      const plain = stripTerminalControlSequences(phaseOutput);

      if (!compactSent && !trustPromptHandled && isWorkspaceTrustPrompt(plain)) {
        trustPromptHandled = true;
        phaseOutput = "";
        readyWaitStartedAt = Date.now();
        child.write("\r");
        scheduleCompact(CLI_READY_FALLBACK_MS);
        return;
      }

      if (!compactSent && isCliReady(plain) && !isResumePending(plain)) {
        scheduleCompact(500);
        return;
      }

      if (compactSent && isCompactFailure(plain)) {
        fail(new Error(`Codex CLI compact failed. ${formatOutputPreview(output)}`.trim()));
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
  return lastCliReadyIndex(output) >= 0;
}

function isCompactComplete(output: string): boolean {
  if (/compacted|compaction complete|compact complete|context compacted|conversation compacted/i.test(output)) {
    return true;
  }
  const commandIndex = output.toLowerCase().lastIndexOf("/compact");
  return commandIndex >= 0 && lastCliReadyIndex(output) > commandIndex;
}

function isCompactFailure(output: string): boolean {
  return /compact(?:ion)? failed|failed to compact|unable to compact/i.test(output);
}

function isWorkspaceTrustPrompt(output: string): boolean {
  return normalizeTerminalText(output).includes("doyoutrustthecontentsofthisdirectory");
}

function isResumePending(output: string): boolean {
  const normalized = normalizeTerminalText(output);
  const resumeIndex = normalized.lastIndexOf("resumingsession");
  if (resumeIndex < 0) {
    return false;
  }
  const readyIndex = Math.max(
    normalized.lastIndexOf("askcodextodoanything"),
    normalized.lastIndexOf("forshortcuts"),
  );
  return readyIndex <= resumeIndex;
}

function lastCliReadyIndex(output: string): number {
  const indexes = [
    output.toLowerCase().lastIndexOf("ask codex to do anything"),
    output.toLowerCase().lastIndexOf("for shortcuts"),
    output.toLowerCase().lastIndexOf("/status"),
  ];
  const promptMatches = [...output.matchAll(/^\s*[>›]/gim)];
  if (promptMatches.length > 0) {
    indexes.push(promptMatches.at(-1)?.index ?? -1);
  }
  return Math.max(...indexes);
}

function normalizeTerminalText(output: string): string {
  return output.toLowerCase().replace(/\s+/g, "");
}

function appendOutput(current: string, next: string): string {
  const combined = current + next;
  return combined.length > OUTPUT_PREVIEW_LIMIT ? combined.slice(-OUTPUT_PREVIEW_LIMIT) : combined;
}

function formatOutputPreview(output: string): string {
  return stripTerminalControlSequences(output)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(-OUTPUT_PREVIEW_LIMIT);
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function formatSpawnFailure(error: unknown, resolved: ResolvedCodexCli): string {
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
