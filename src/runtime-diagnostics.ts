import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { escapeHTML } from "./format.js";

const COMMAND_TIMEOUT_MS = 1800;
const OUTPUT_LIMIT = 4000;
const MIN_RECOMMENDED_CODEX_CLI_VERSION = "0.144.1";
const APP_SERVER_APPROVAL_BRIDGE_DETAIL =
  "Codex app-server exposes approval server requests that TeleCodex can forward to Telegram inline buttons.";
const CODEX_BASELINE_REASON =
  "matches the supported canonical app-server protocol and includes the 0.142.5 trace-log privacy fix";

export type RuntimeDoctorReport = {
  instanceName: string;
  workspace: string;
  cwd: string;
  user: string;
  uid?: number;
  home?: string;
  shell?: string;
  pathEntries: string[];
  envPresence: Array<{ name: string; present: boolean }>;
  commands: CommandCheck[];
  project: {
    hasPackageJson: boolean;
    hasPnpmLock: boolean;
    hasNodeModules: boolean;
  };
  git: {
    available: boolean;
    insideWorkTree?: boolean;
    branch?: string;
    dirtySummary?: string;
    metadataWritable?: boolean;
    metadataDetail?: string;
    credentialHelper?: string;
    sshAgentPresent: boolean;
    detail?: string;
  };
  codex: {
    approvalBridgeSupported: boolean;
    approvalBridgeDetail: string;
    minimumVersionRequirement: {
      status: "ok" | "warn" | "unknown";
      detail: string;
    };
  };
};

export type RuntimeLockReport = {
  workspace: string;
  checkedAt: string;
  locks: RuntimeLock[];
  notes: string[];
};

type RuntimeLock = {
  name: string;
  path: string;
  exists: boolean;
  age?: string;
  detail?: string;
};

type CommandCheck = {
  name: string;
  available: boolean;
  path?: string;
  version?: string;
  detail?: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
};

export async function collectRuntimeDoctor(options: {
  workspace: string;
  instanceName: string;
}): Promise<RuntimeDoctorReport> {
  const [node, pnpm, corepack, git, codex] = await Promise.all([
    checkCommand("node", ["--version"]),
    checkCommand("pnpm", ["--version"]),
    checkCommand("corepack", ["--version"]),
    checkCommand("git", ["--version"]),
    checkCommand("codex", ["--version"]),
  ]);
  const [hasPackageJson, hasPnpmLock, hasNodeModules, gitInfo] = await Promise.all([
    pathExists(path.join(options.workspace, "package.json")),
    pathExists(path.join(options.workspace, "pnpm-lock.yaml")),
    pathExists(path.join(options.workspace, "node_modules")),
    collectGitDoctor(options.workspace, git.available),
  ]);

  const userInfo = safeUserInfo();
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  return {
    instanceName: options.instanceName,
    workspace: options.workspace,
    cwd: process.cwd(),
    user: userInfo.username,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    home: process.env.HOME,
    shell: process.env.SHELL,
    pathEntries,
    envPresence: [
      { name: "CODEX_API_KEY", present: Boolean(process.env.CODEX_API_KEY) },
      { name: "OPENAI_API_KEY", present: Boolean(process.env.OPENAI_API_KEY) },
      { name: "SSH_AUTH_SOCK", present: Boolean(process.env.SSH_AUTH_SOCK) },
      { name: "TELECODEX_INSTANCE", present: Boolean(process.env.TELECODEX_INSTANCE) },
      { name: "TELEGRAM_BOT_TOKEN", present: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
    ],
    commands: [node, pnpm, corepack, git, codex],
    project: {
      hasPackageJson,
      hasPnpmLock,
      hasNodeModules,
    },
    git: gitInfo,
    codex: {
      approvalBridgeSupported: true,
      approvalBridgeDetail: APP_SERVER_APPROVAL_BRIDGE_DETAIL,
      minimumVersionRequirement: getCodexVersionRequirement(codex.available, codex.version),
    },
  };
}

export async function collectRuntimeLocks(options: { workspace: string }): Promise<RuntimeLockReport> {
  const locks: RuntimeLock[] = [];
  const gitLockPath = await resolveGitIndexLockPath(options.workspace);
  if (gitLockPath) {
    locks.push(await inspectLock("Git index lock", gitLockPath));
  } else {
    locks.push({
      name: "Git index lock",
      path: path.join(options.workspace, ".git", "index.lock"),
      exists: false,
      detail: "Workspace is not a Git worktree or git is unavailable.",
    });
  }

  const serviceLockPaths = uniquePaths([
    path.join(process.cwd(), ".telecodex", "service-update.lock"),
    path.join(options.workspace, ".telecodex", "service-update.lock"),
  ]);
  for (const serviceLockPath of serviceLockPaths) {
    locks.push(await inspectServiceLock(serviceLockPath));
  }

  return {
    workspace: options.workspace,
    checkedAt: new Date().toISOString(),
    locks,
    notes: [
      "No lock is removed automatically.",
      "Remove Git locks only after confirming no git process is active.",
      "pnpm blocking is usually caused by an active process, store access, PATH, or auth state rather than a stable project lock file.",
    ],
  };
}

export function renderRuntimeDoctor(report: RuntimeDoctorReport): { html: string; plain: string } {
  const pathPreview = report.pathEntries.slice(0, 8);
  const hiddenPathCount = Math.max(0, report.pathEntries.length - pathPreview.length);
  const commandLines = report.commands.map((command) => {
    const status = command.available ? "ok" : "missing";
    const version = command.version ? ` ${command.version}` : "";
    const location = command.path ? ` (${command.path})` : "";
    const detail = command.detail ? ` - ${command.detail}` : "";
    return `${command.name}: ${status}${version}${location}${detail}`;
  });
  const envLines = report.envPresence.map((env) => `${env.name}: ${env.present ? "present" : "missing"}`);
  const projectLines = [
    `package.json: ${formatBoolean(report.project.hasPackageJson)}`,
    `pnpm-lock.yaml: ${formatBoolean(report.project.hasPnpmLock)}`,
    `node_modules: ${formatBoolean(report.project.hasNodeModules)}`,
  ];
  const codexVersionRequirement = formatCodexVersionRequirement(report.codex.minimumVersionRequirement);
  const gitLines = [
    `available: ${formatBoolean(report.git.available)}`,
    report.git.insideWorkTree !== undefined ? `worktree: ${formatBoolean(report.git.insideWorkTree)}` : undefined,
    report.git.branch ? `branch: ${report.git.branch}` : undefined,
    report.git.dirtySummary ? `status: ${report.git.dirtySummary}` : undefined,
    report.git.metadataWritable !== undefined ? `git metadata writable: ${formatBoolean(report.git.metadataWritable)}` : undefined,
    report.git.metadataDetail,
    report.git.credentialHelper ? `credential helper: ${report.git.credentialHelper}` : "credential helper: not configured",
    `SSH agent: ${report.git.sshAgentPresent ? "present" : "missing"}`,
    report.git.detail,
  ].filter((line): line is string => Boolean(line));
  const approvalLine = report.codex.approvalBridgeSupported
    ? `approval bridge: supported - ${report.codex.approvalBridgeDetail}`
    : `approval bridge: unsupported - ${report.codex.approvalBridgeDetail}`;

  const plain = [
    "TeleCodex doctor",
    `Instance: ${report.instanceName}`,
    `User: ${report.user}${report.uid !== undefined ? ` (${report.uid})` : ""}`,
    `CWD: ${report.cwd}`,
    `Workspace: ${report.workspace}`,
    `HOME: ${report.home ?? "(missing)"}`,
    `SHELL: ${report.shell ?? "(missing)"}`,
    "",
    "PATH:",
    ...pathPreview.map((entry) => `- ${entry}`),
    hiddenPathCount > 0 ? `- ... ${hiddenPathCount} more` : undefined,
    "",
    "Commands:",
    ...commandLines.map((line) => `- ${line}`),
    "",
    "Project:",
    ...projectLines.map((line) => `- ${line}`),
    "",
    "Git/auth:",
    ...gitLines.map((line) => `- ${line}`),
    "",
    "Secret env presence:",
    ...envLines.map((line) => `- ${line}`),
    "",
    "Codex app-server:",
    `- ${approvalLine}`,
    "",
    "Codex CLI baseline:",
    `- ${codexVersionRequirement}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const html = [
    "<b>TeleCodex doctor</b>",
    `<b>Instance:</b> <code>${escapeHTML(report.instanceName)}</code>`,
    `<b>User:</b> <code>${escapeHTML(`${report.user}${report.uid !== undefined ? ` (${report.uid})` : ""}`)}</code>`,
    `<b>CWD:</b> <code>${escapeHTML(report.cwd)}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(report.workspace)}</code>`,
    `<b>HOME:</b> <code>${escapeHTML(report.home ?? "(missing)")}</code>`,
    `<b>SHELL:</b> <code>${escapeHTML(report.shell ?? "(missing)")}</code>`,
    "",
    "<b>PATH</b>",
    `<pre>${escapeHTML([
      ...pathPreview.map((entry) => `- ${entry}`),
      hiddenPathCount > 0 ? `- ... ${hiddenPathCount} more` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n"))}</pre>`,
    "<b>Commands</b>",
    `<pre>${escapeHTML(commandLines.map((line) => `- ${line}`).join("\n"))}</pre>`,
    "<b>Project</b>",
    `<pre>${escapeHTML(projectLines.map((line) => `- ${line}`).join("\n"))}</pre>`,
    "<b>Git/auth</b>",
    `<pre>${escapeHTML(gitLines.map((line) => `- ${line}`).join("\n"))}</pre>`,
    "<b>Secret env presence</b>",
    `<pre>${escapeHTML(envLines.map((line) => `- ${line}`).join("\n"))}</pre>`,
    "<b>Codex app-server</b>",
    `<pre>${escapeHTML(`- ${approvalLine}`)}</pre>`,
    "",
    "<b>Codex CLI baseline</b>",
    `<pre>${escapeHTML(`- ${codexVersionRequirement}`)}</pre>`,
  ].join("\n");

  return { html, plain };
}

export function renderRuntimeLocks(report: RuntimeLockReport): { html: string; plain: string } {
  const lockLines = report.locks.map((lock) => {
    const status = lock.exists ? "present" : "clear";
    const age = lock.age ? ` age=${lock.age}` : "";
    const detail = lock.detail ? ` - ${lock.detail}` : "";
    return `${lock.name}: ${status}${age}\n  path: ${lock.path}${detail}`;
  });
  const plain = [
    "TeleCodex locks",
    `Workspace: ${report.workspace}`,
    `Checked at: ${report.checkedAt}`,
    "",
    ...lockLines,
    "",
    "Notes:",
    ...report.notes.map((note) => `- ${note}`),
  ].join("\n");
  const html = [
    "<b>TeleCodex locks</b>",
    `<b>Workspace:</b> <code>${escapeHTML(report.workspace)}</code>`,
    `<b>Checked at:</b> <code>${escapeHTML(report.checkedAt)}</code>`,
    "",
    `<pre>${escapeHTML(lockLines.join("\n\n"))}</pre>`,
    "<b>Notes</b>",
    `<pre>${escapeHTML(report.notes.map((note) => `- ${note}`).join("\n"))}</pre>`,
  ].join("\n");

  return { html, plain };
}

async function collectGitDoctor(workspace: string, gitAvailable: boolean): Promise<RuntimeDoctorReport["git"]> {
  if (!gitAvailable) {
    return {
      available: false,
      sshAgentPresent: Boolean(process.env.SSH_AUTH_SOCK),
      detail: "git command is not available in this service environment.",
    };
  }

  const inside = await runCommand("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      available: true,
      insideWorkTree: false,
      sshAgentPresent: Boolean(process.env.SSH_AUTH_SOCK),
      detail: firstLine(inside.stderr || inside.stdout) || "workspace is not a git worktree.",
    };
  }

  const [branch, status, helper, metadataWritable] = await Promise.all([
    runCommand("git", ["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"]),
    runCommand("git", ["-C", workspace, "status", "--porcelain=v1", "-uno"]),
    runCommand("git", ["config", "--global", "--get", "credential.helper"]),
    checkGitMetadataWritable(workspace),
  ]);
  const dirtyLines = status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : 0;

  return {
    available: true,
    insideWorkTree: true,
    branch: branch.ok ? firstLine(branch.stdout) : undefined,
    dirtySummary: status.ok ? `${dirtyLines} changed path(s), untracked hidden` : "status unavailable",
    metadataWritable: metadataWritable.writable,
    metadataDetail: metadataWritable.detail,
    credentialHelper: helper.ok ? firstLine(helper.stdout) : undefined,
    sshAgentPresent: Boolean(process.env.SSH_AUTH_SOCK),
    detail: status.ok ? undefined : firstLine(status.stderr || status.stdout) || "git status failed.",
  };
}

async function checkGitMetadataWritable(workspace: string): Promise<{ writable: boolean; detail?: string }> {
  const markerName = `telecodex-doctor-${process.pid}-${Date.now()}.tmp`;
  const gitPath = await runCommand("git", ["-C", workspace, "rev-parse", "--git-path", markerName]);
  if (!gitPath.ok) {
    return {
      writable: false,
      detail: firstLine(gitPath.stderr || gitPath.stdout) || "failed to resolve git metadata path.",
    };
  }

  const markerPath = path.isAbsolute(gitPath.stdout.trim())
    ? gitPath.stdout.trim()
    : path.resolve(workspace, gitPath.stdout.trim());

  try {
    await writeFile(markerPath, "telecodex doctor git metadata write test\n", { flag: "wx" });
    await unlink(markerPath).catch(() => undefined);
    return { writable: true };
  } catch (error) {
    return {
      writable: false,
      detail: `git metadata write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkCommand(name: string, versionArgs: string[]): Promise<CommandCheck> {
  const pathResult = await runCommand("sh", ["-lc", `command -v ${shellQuote(name)}`]);
  if (!pathResult.ok) {
    return {
      name,
      available: false,
      detail: pathResult.timedOut ? "lookup timed out" : firstLine(pathResult.stderr || pathResult.stdout || pathResult.error),
    };
  }

  const version = await runCommand(name, versionArgs);
  return {
    name,
    available: true,
    path: firstLine(pathResult.stdout),
    version: version.ok ? firstLine(version.stdout || version.stderr) : undefined,
    detail: version.ok ? undefined : firstLine(version.stderr || version.stdout || version.error),
  };
}

async function resolveGitIndexLockPath(workspace: string): Promise<string | undefined> {
  const result = await runCommand("git", ["-C", workspace, "rev-parse", "--git-path", "index.lock"]);
  if (!result.ok) {
    return undefined;
  }
  const gitPath = firstLine(result.stdout);
  if (!gitPath) {
    return undefined;
  }
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(workspace, gitPath);
}

async function inspectServiceLock(lockPath: string): Promise<RuntimeLock> {
  const lock = await inspectLock("TeleCodex service update lock", lockPath);
  if (!lock.exists) {
    return lock;
  }

  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const detailParts = ["target", "pid", "command", "startedAt"]
      .map((key) => (parsed[key] === undefined ? undefined : `${key}=${String(parsed[key])}`))
      .filter((part): part is string => Boolean(part));
    return {
      ...lock,
      detail: detailParts.length > 0 ? detailParts.join(", ") : lock.detail,
    };
  } catch {
    return {
      ...lock,
      detail: "present, but metadata could not be parsed.",
    };
  }
}

async function inspectLock(name: string, lockPath: string): Promise<RuntimeLock> {
  try {
    const fileStat = await stat(lockPath);
    return {
      name,
      path: lockPath,
      exists: true,
      age: formatAge(Date.now() - fileStat.mtimeMs),
    };
  } catch {
    return {
      name,
      path: lockPath,
      exists: false,
    };
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr,
        code: null,
        signal: null,
        timedOut,
        error: error.message,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code,
        signal,
        timedOut,
      });
    });
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  return combined.length > OUTPUT_LIMIT ? combined.slice(0, OUTPUT_LIMIT) : combined;
}

function firstLine(value?: string): string | undefined {
  const line = value?.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return line || undefined;
}

function getCodexVersionRequirement(
  available: boolean,
  rawVersion: string | undefined,
): { status: "ok" | "warn" | "unknown"; detail: string } {
  if (!available) {
    return {
      status: "unknown",
      detail: `Codex CLI not found. Install ${MIN_RECOMMENDED_CODEX_CLI_VERSION}+ for the WebSocket trace log privacy fix.`,
    };
  }

  const parsed = parseVersion(rawVersion);
  if (!parsed) {
    return {
      status: "unknown",
      detail:
        `Unable to parse codex --version output. Confirm ${MIN_RECOMMENDED_CODEX_CLI_VERSION}+ for a WebSocket trace log privacy fix.`,
    };
  }

  const current = toVersionParts(parsed);
  const minimum = toVersionParts(MIN_RECOMMENDED_CODEX_CLI_VERSION);
  if (isLessThan(current, minimum)) {
    return {
      status: "warn",
      detail:
        `Detected ${parsed}; upgrade to ${MIN_RECOMMENDED_CODEX_CLI_VERSION}+ to ${CODEX_BASELINE_REASON}.`,
    };
  }

  return {
    status: "ok",
    detail: `Detected ${parsed}; includes the WebSocket trace log privacy fix (${CODEX_BASELINE_REASON}).`,
  };
}

function parseVersion(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function toVersionParts(raw: string): [number, number, number] {
  const [major, minor, patch] = raw.split(".").map((entry) => Number.parseInt(entry, 10));
  return [major, minor, patch];
}

function isLessThan(left: [number, number, number], right: [number, number, number]): boolean {
  if (left[0] !== right[0]) {
    return left[0] < right[0];
  }
  if (left[1] !== right[1]) {
    return left[1] < right[1];
  }
  return left[2] < right[2];
}

function formatCodexVersionRequirement(requirement: {
  status: "ok" | "warn" | "unknown";
  detail: string;
}): string {
  const prefix =
    requirement.status === "warn" ? "warning" : requirement.status === "ok" ? "OK" : "info";
  return `${prefix}: ${requirement.detail}`;
}

function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeUserInfo(): { username: string } {
  try {
    return { username: os.userInfo().username };
  } catch {
    return { username: "(unknown)" };
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((entry) => path.resolve(entry))));
}
