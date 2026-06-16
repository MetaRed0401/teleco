import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIST_LIMIT = 80;
const DEFAULT_FIND_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_GREP_LIMIT = 40;
const DEFAULT_TREE_DEPTH = 2;
const DEFAULT_VIEW_LINES = 120;
const MAX_VIEW_CHARS = 3000;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_WALK_ENTRIES = 3000;
const SEARCH_TIMEOUT_MS = 3000;

const EXCLUDED_NAMES = new Set([
  ".codex",
  ".dart_tool",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".pnpm",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "tmp",
  "vendor",
]);

export type WorkspaceEntryType = "dir" | "file" | "symlink" | "other";

export type WorkspaceEntry = {
  name: string;
  relativePath: string;
  type: WorkspaceEntryType;
};

export type WorkspaceFileView = {
  relativePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
};

export type WorkspaceSearchMatch = {
  relativePath: string;
  lineNumber: number;
  line: string;
};

export type WorkspaceSendFile = {
  absolutePath: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
};

export function resolveWorkspacePath(workspace: string, requestedPath = "."): { absolutePath: string; relativePath: string } {
  const root = path.resolve(workspace);
  const requested = requestedPath.trim() || ".";

  if (path.isAbsolute(requested)) {
    throw new Error("Use a workspace-relative path.");
  }

  const absolutePath = path.resolve(root, requested);
  const relativePath = path.relative(root, absolutePath) || ".";

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path is outside the current workspace.");
  }

  if (relativePath !== "." && relativePath.split(path.sep).some((segment) => EXCLUDED_NAMES.has(segment))) {
    throw new Error("Path is excluded from Telegram browsing.");
  }

  return { absolutePath, relativePath: normalizeRelativePath(relativePath) };
}

export async function resolveWorkspaceFileForSend(
  workspace: string,
  requestedPath: string,
  maxFileSize: number,
): Promise<WorkspaceSendFile> {
  if (!requestedPath.trim()) {
    throw new Error("Usage: /sendfile <path>");
  }

  const target = resolveWorkspacePath(workspace, requestedPath);
  const fileStat = await stat(target.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Path is not a regular file.");
  }
  if (fileStat.size > maxFileSize) {
    throw new Error(`File too large (${formatBytes(fileStat.size)}, max ${formatBytes(maxFileSize)})`);
  }

  return {
    absolutePath: target.absolutePath,
    relativePath: target.relativePath,
    name: path.basename(target.absolutePath),
    sizeBytes: fileStat.size,
  };
}

export async function listWorkspaceEntries(
  workspace: string,
  requestedPath = ".",
  limit = DEFAULT_LIST_LIMIT,
): Promise<{ basePath: string; entries: WorkspaceEntry[]; truncated: boolean }> {
  const target = resolveWorkspacePath(workspace, requestedPath);
  const dirents = await readdir(target.absolutePath, { withFileTypes: true });
  const entries = dirents
    .filter((entry) => !EXCLUDED_NAMES.has(entry.name))
    .map((entry) => toWorkspaceEntry(target.relativePath, entry))
    .sort(compareEntries);

  return {
    basePath: target.relativePath,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

export async function renderWorkspaceTree(
  workspace: string,
  requestedPath = ".",
  depth = DEFAULT_TREE_DEPTH,
): Promise<{ basePath: string; lines: string[]; truncated: boolean }> {
  const target = resolveWorkspacePath(workspace, requestedPath);
  const maxDepth = Math.max(0, Math.min(depth, 5));
  const lines: string[] = [formatTreeRoot(target.relativePath)];
  let visited = 0;
  let truncated = false;

  const walk = async (absoluteDir: string, prefix: string, currentDepth: number): Promise<void> => {
    if (currentDepth >= maxDepth || truncated) {
      return;
    }

    const dirents = (await readdir(absoluteDir, { withFileTypes: true }))
      .filter((entry) => !EXCLUDED_NAMES.has(entry.name))
      .map((entry) => ({
        entry,
        type: direntType(entry),
      }))
      .sort((left, right) => compareEntryParts(left.entry.name, left.type, right.entry.name, right.type));

    for (const [index, { entry, type }] of dirents.entries()) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        truncated = true;
        lines.push(`${prefix}...`);
        return;
      }

      const last = index === dirents.length - 1;
      const connector = last ? "└── " : "├── ";
      const nextPrefix = `${prefix}${last ? "    " : "│   "}`;
      const label = type === "dir" ? `${entry.name}/` : entry.name;
      lines.push(`${prefix}${connector}${label}`);

      if (type === "dir") {
        await walk(path.join(absoluteDir, entry.name), nextPrefix, currentDepth + 1);
      }
    }
  };

  await walk(target.absolutePath, "", 0);
  return { basePath: target.relativePath, lines, truncated };
}

export async function findWorkspaceFiles(
  workspace: string,
  query: string,
  requestedPath = ".",
  limit = DEFAULT_FIND_LIMIT,
): Promise<{ matches: WorkspaceEntry[]; truncated: boolean }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new Error("Usage: /find <query> [path]");
  }

  const target = resolveWorkspacePath(workspace, requestedPath);
  const matches: WorkspaceEntry[] = [];
  let truncated = false;

  await walkWorkspace(target.absolutePath, target.relativePath, async (entry) => {
    if (!entry.name.toLowerCase().includes(normalizedQuery)) {
      return true;
    }

    matches.push(entry);
    if (matches.length >= limit) {
      truncated = true;
      return false;
    }
    return true;
  });

  return { matches, truncated };
}

export async function searchWorkspaceFiles(
  workspace: string,
  query: string,
  requestedPath = ".",
  limit = DEFAULT_SEARCH_LIMIT,
): Promise<{ matches: WorkspaceEntry[]; truncated: boolean; source: string }> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Usage: /search <query> [path]");
  }

  const target = resolveWorkspacePath(workspace, requestedPath);
  const boundedLimit = Math.max(1, Math.min(limit, DEFAULT_SEARCH_LIMIT));

  const fdResult = await searchWithFd("fd", target, normalizedQuery, boundedLimit);
  if (fdResult) {
    return fdResult;
  }

  const fdfindResult = await searchWithFd("fdfind", target, normalizedQuery, boundedLimit);
  if (fdfindResult) {
    return fdfindResult;
  }

  try {
    return { ...(await searchWithNode(target, normalizedQuery, boundedLimit)), source: "node" };
  } catch {
    const findResult = await searchWithFind(target, normalizedQuery, boundedLimit);
    if (findResult) {
      return findResult;
    }
    throw new Error("File search failed.");
  }
}

export async function grepWorkspaceText(
  workspace: string,
  query: string,
  requestedPath = ".",
  limit = DEFAULT_GREP_LIMIT,
): Promise<{ matches: WorkspaceSearchMatch[]; truncated: boolean }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new Error("Usage: /grep <text> [path]");
  }

  const target = resolveWorkspacePath(workspace, requestedPath);
  const matches: WorkspaceSearchMatch[] = [];
  let truncated = false;

  await walkWorkspace(target.absolutePath, target.relativePath, async (entry, absolutePath) => {
    if (entry.type !== "file") {
      return true;
    }

    const fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_TEXT_FILE_BYTES) {
      return true;
    }

    const contents = await readFile(absolutePath, "utf8").catch(() => "");
    if (!contents || looksBinary(contents)) {
      return true;
    }

    const lines = contents.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) {
        continue;
      }

      matches.push({
        relativePath: entry.relativePath,
        lineNumber: index + 1,
        line: trimForDisplay(line, 180),
      });

      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
    }

    return true;
  });

  return { matches, truncated };
}

export async function readWorkspaceFile(
  workspace: string,
  requestedPath: string,
  range?: { start?: number; end?: number },
): Promise<WorkspaceFileView> {
  if (!requestedPath.trim()) {
    throw new Error("Usage: /view <path> [start:end]");
  }

  const target = resolveWorkspacePath(workspace, requestedPath);
  const fileStat = await stat(target.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (fileStat.size > MAX_TEXT_FILE_BYTES && !range?.start && !range?.end) {
    throw new Error("File is large. Use /view <path> <start:end>.");
  }

  const contents = await readFile(target.absolutePath, "utf8");
  if (looksBinary(contents)) {
    throw new Error("Binary files cannot be viewed in Telegram.");
  }

  const lines = contents.split(/\r?\n/);
  const startLine = clampLine(range?.start ?? 1, lines.length);
  const requestedEnd = range?.end ?? startLine + DEFAULT_VIEW_LINES - 1;
  const endLine = Math.max(startLine, Math.min(requestedEnd, lines.length));
  let selectedText = lines.slice(startLine - 1, endLine).join("\n");
  let truncated = false;

  if (selectedText.length > MAX_VIEW_CHARS) {
    selectedText = selectedText.slice(0, MAX_VIEW_CHARS);
    truncated = true;
  }

  return {
    relativePath: target.relativePath,
    startLine,
    endLine,
    totalLines: lines.length,
    text: selectedText,
    truncated,
  };
}

function toWorkspaceEntry(basePath: string, entry: import("node:fs").Dirent): WorkspaceEntry {
  return {
    name: entry.name,
    relativePath: joinRelative(basePath, entry.name),
    type: direntType(entry),
  };
}

function direntType(entry: import("node:fs").Dirent): WorkspaceEntryType {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return compareEntryParts(left.name, left.type, right.name, right.type);
}

function compareEntryParts(leftName: string, leftType: WorkspaceEntryType, rightName: string, rightType: WorkspaceEntryType): number {
  if (leftType === "dir" && rightType !== "dir") return -1;
  if (leftType !== "dir" && rightType === "dir") return 1;
  return leftName.localeCompare(rightName);
}

async function walkWorkspace(
  absoluteRoot: string,
  relativeRoot: string,
  visitor: (entry: WorkspaceEntry, absolutePath: string) => Promise<boolean>,
): Promise<void> {
  let visited = 0;

  const walk = async (absoluteDir: string, relativeDir: string): Promise<boolean> => {
    const dirents = (await readdir(absoluteDir, { withFileTypes: true }))
      .filter((entry) => !EXCLUDED_NAMES.has(entry.name))
      .map((entry) => toWorkspaceEntry(relativeDir, entry))
      .sort(compareEntries);

    for (const entry of dirents) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        return false;
      }

      const absolutePath = path.join(absoluteRoot, path.relative(relativeRoot === "." ? "." : relativeRoot, entry.relativePath));
      const keepGoing = await visitor(entry, absolutePath);
      if (!keepGoing) {
        return false;
      }

      if (entry.type === "dir") {
        const childKeepGoing = await walk(absolutePath, entry.relativePath);
        if (!childKeepGoing) {
          return false;
        }
      }
    }

    return true;
  };

  await walk(absoluteRoot, relativeRoot);
}

function joinRelative(basePath: string, name: string): string {
  return normalizeRelativePath(basePath === "." ? name : path.join(basePath, name));
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function formatTreeRoot(relativePath: string): string {
  return relativePath === "." ? "./" : `${relativePath}/`;
}

function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

function trimForDisplay(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function clampLine(line: number, totalLines: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.max(1, Math.min(Math.floor(line), Math.max(totalLines, 1)));
}

async function searchWithFd(
  command: "fd" | "fdfind",
  target: { absolutePath: string; relativePath: string },
  query: string,
  limit: number,
): Promise<{ matches: WorkspaceEntry[]; truncated: boolean; source: string } | null> {
  const args = [
    "--color",
    "never",
    "--fixed-strings",
    "--type",
    "file",
    "--type",
    "symlink",
    "--max-results",
    String(limit + 1),
    ...excludedArgsForFd(),
    query,
    ".",
  ];
  const result = await runSearchCommand(command, args, target.absolutePath);
  if (!result) {
    return null;
  }

  return entriesFromRelativeLines(target, result.stdout.split(/\r?\n/), limit, command);
}

async function searchWithFind(
  target: { absolutePath: string; relativePath: string },
  query: string,
  limit: number,
): Promise<{ matches: WorkspaceEntry[]; truncated: boolean; source: string } | null> {
  const args = [
    ".",
    ...excludedArgsForFind(),
    "-type",
    "f",
    "-iname",
    `*${query}*`,
    "-print",
  ];
  const result = await runSearchCommand("find", args, target.absolutePath);
  if (!result) {
    return null;
  }

  return entriesFromRelativeLines(target, result.stdout.split(/\r?\n/).slice(0, limit + 1), limit, "find");
}

async function searchWithNode(
  target: { absolutePath: string; relativePath: string },
  query: string,
  limit: number,
): Promise<{ matches: WorkspaceEntry[]; truncated: boolean }> {
  const normalizedQuery = query.toLowerCase();
  const matches: WorkspaceEntry[] = [];
  let truncated = false;

  await walkWorkspace(target.absolutePath, target.relativePath, async (entry) => {
    if (entry.type === "file" && entry.relativePath.toLowerCase().includes(normalizedQuery)) {
      matches.push(entry);
      if (matches.length > limit) {
        truncated = true;
        return false;
      }
    }
    return true;
  });

  return { matches: matches.slice(0, limit), truncated };
}

async function runSearchCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, SEARCH_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 || stdout ? { stdout } : null);
    });
  });
}

function entriesFromRelativeLines(
  target: { relativePath: string },
  lines: string[],
  limit: number,
  source: string,
): { matches: WorkspaceEntry[]; truncated: boolean; source: string } {
  const matches = lines
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean)
    .map((relativeLine) => {
      const relativePath = normalizeRelativePath(target.relativePath === "." ? relativeLine : path.join(target.relativePath, relativeLine));
      return {
        name: path.basename(relativePath),
        relativePath,
        type: "file" as WorkspaceEntryType,
      };
    });

  return {
    matches: matches.slice(0, limit),
    truncated: matches.length > limit,
    source,
  };
}

function excludedArgsForFd(): string[] {
  return [...EXCLUDED_NAMES].flatMap((name) => ["--exclude", name]);
}

function excludedArgsForFind(): string[] {
  const args: string[] = ["("];
  for (const [index, name] of [...EXCLUDED_NAMES].entries()) {
    if (index > 0) {
      args.push("-o");
    }
    args.push("-name", name);
  }
  args.push(")", "-prune", "-o");
  return args;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
