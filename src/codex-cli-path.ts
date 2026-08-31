import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { getPackageRoot } from "./install-layout.js";

export interface ResolvedCodexCli {
  command: string;
  path: string;
  checked: string[];
}

export function resolveCodexCliPath(environment: NodeJS.ProcessEnv = process.env): ResolvedCodexCli {
  const pathValue = buildCodexCliPath(environment);
  const checked: string[] = [];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "codex");
    checked.push(candidate);
    if (isExecutable(candidate)) {
      return { command: resolveRealPath(candidate), path: pathValue, checked };
    }
  }

  return { command: "codex", path: pathValue, checked };
}

export function buildCodexCliPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME;
  const candidates = [
    path.join(getPackageRoot(), "node_modules", ".bin"),
    path.join(process.cwd(), "node_modules", ".bin"),
    path.dirname(process.execPath),
    environment.PATH,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
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
    for (const directory of (candidate ?? "").split(path.delimiter)) {
      if (!directory || seen.has(directory)) continue;
      seen.add(directory);
      parts.push(directory);
    }
  }
  return parts.join(path.delimiter);
}

function resolveRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
