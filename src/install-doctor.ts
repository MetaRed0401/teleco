import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

import { checkAuthStatus, type AuthStatus } from "./codex-auth.js";
import { getTelecoConfigRoot, isHomebrewInstall } from "./install-layout.js";
import { listInstanceConfigs } from "./instance-config.js";
import { getTelecoVersion } from "./version.js";

export interface InstallDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface CommandResult {
  ok: boolean;
  output: string;
}

interface InstallDoctorOptions {
  offline: boolean;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => CommandResult;
  checkAuth?: (apiKey?: string) => Promise<AuthStatus>;
}

export async function collectInstallDoctor(options: InstallDoctorOptions): Promise<InstallDoctorCheck[]> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? ((command, args) => run(command, args, environment));
  const checks: InstallDoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const version = getTelecoVersion();
  const homebrew = isHomebrewInstall(environment);
  checks.push({ name: "Node.js", ok: nodeMajor >= 20, detail: process.version });
  checks.push({ name: "Package", ok: true, detail: `teleco ${version} (${homebrew ? "homebrew" : "source"})` });

  const configRoot = getTelecoConfigRoot(environment);
  checks.push(inspectConfigRoot(configRoot));

  let instances: ReturnType<typeof listInstanceConfigs> = [];
  try {
    instances = listInstanceConfigs(environment);
    checks.push({
      name: "Instances",
      ok: options.offline || instances.length > 0,
      detail: `${instances.length} configured`,
    });
    for (const instance of instances) {
      checks.push(inspectInstanceFile(instance.name, instance.filePath));
      checks.push(inspectWorkspace(instance.name, instance.values.TELECODEX_WORKSPACE));
    }
  } catch {
    checks.push({ name: "Instances", ok: false, detail: "configuration could not be read or validated" });
  }

  if (options.offline) return checks;

  const codexVersion = runCommand("codex", ["--version"]);
  checks.push({ name: "Codex CLI", ok: codexVersion.ok, detail: codexVersion.ok ? codexVersion.output : "not available" });
  const appServer = runCommand("codex", ["app-server", "--help"]);
  checks.push({ name: "Codex app-server", ok: appServer.ok, detail: appServer.ok ? "available" : "unavailable" });
  const auth = await (options.checkAuth ?? checkAuthStatus)(environment.CODEX_API_KEY);
  checks.push({
    name: "Codex auth",
    ok: auth.authenticated,
    detail: auth.authenticated ? `authenticated via ${auth.method}` : "not authenticated",
  });

  if (homebrew) {
    const installed = runCommand("brew", ["list", "--versions", "teleco"]);
    const installedVersions = installed.output.trim().split(/\s+/).slice(1);
    checks.push({
      name: "Homebrew version",
      ok: installed.ok && installedVersions.includes(version),
      detail: installed.ok ? installed.output : "teleco Formula is not installed",
    });
  }

  if (platform === "linux") collectSystemdChecks(checks, instances.map((instance) => instance.name), runCommand);
  return checks;
}

export function renderInstallDoctor(checks: InstallDoctorCheck[]): { output: string; exitCode: number } {
  return {
    output: checks.map((check) => `${check.ok ? "OK" : "FAIL"}\t${check.name}\t${check.detail}`).join("\n"),
    exitCode: checks.every((check) => check.ok) ? 0 : 1,
  };
}

function inspectConfigRoot(configRoot: string): InstallDoctorCheck {
  if (!existsSync(configRoot)) {
    const parent = nearestExistingParent(configRoot);
    return {
      name: "Config",
      ok: canAccess(parent, constants.W_OK),
      detail: `${configRoot} (will be created under ${parent})`,
    };
  }
  const stat = statSync(configRoot);
  const mode = stat.mode & 0o777;
  return {
    name: "Config",
    ok: stat.isDirectory() && (mode & 0o077) === 0 && canAccess(configRoot, constants.R_OK | constants.W_OK),
    detail: `${configRoot} (${formatMode(mode)})`,
  };
}

function inspectInstanceFile(name: string, filePath: string): InstallDoctorCheck {
  const stat = statSync(filePath);
  const mode = stat.mode & 0o777;
  return {
    name: `Instance ${name}`,
    ok: stat.isFile() && (mode & 0o077) === 0 && canAccess(filePath, constants.R_OK),
    detail: `${filePath} (${formatMode(mode)})`,
  };
}

function inspectWorkspace(name: string, workspace: string | undefined): InstallDoctorCheck {
  const resolved = workspace?.trim();
  if (!resolved || !existsSync(resolved)) {
    return { name: `Workspace ${name}`, ok: false, detail: resolved || "not configured" };
  }
  const stat = statSync(resolved);
  return {
    name: `Workspace ${name}`,
    ok: stat.isDirectory() && canAccess(resolved, constants.R_OK | constants.W_OK),
    detail: resolved,
  };
}

function collectSystemdChecks(
  checks: InstallDoctorCheck[],
  instanceNames: string[],
  runCommand: (command: string, args: string[]) => CommandResult,
): void {
  const userBus = runCommand("systemctl", ["--user", "show-environment"]);
  checks.push({ name: "systemd user", ok: userBus.ok, detail: userBus.ok ? "available" : "unavailable" });
  if (!userBus.ok) return;

  const runtime = runCommand("systemctl", ["--user", "is-active", "telecodex-codex-app-server.service"]);
  checks.push({ name: "Codex runtime service", ok: runtime.ok, detail: runtime.ok ? "active" : "inactive" });
  let templatedActive = false;
  for (const name of instanceNames) {
    const service = runCommand("systemctl", ["--user", "is-active", `telecodex@${name}.service`]);
    templatedActive ||= service.ok;
    checks.push({ name: `Service ${name}`, ok: service.ok, detail: service.ok ? "active" : "inactive" });
  }
  const legacy = runCommand("systemctl", ["--user", "is-active", "telecodex.service"]);
  checks.push({
    name: "Duplicate services",
    ok: !(legacy.ok && templatedActive),
    detail: legacy.ok && templatedActive ? "legacy and instance services are both active" : "none detected",
  });
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, { env: environment, encoding: "utf8", timeout: 5_000 });
  return {
    ok: !result.error && result.status === 0,
    output: (result.stdout || "").trim(),
  };
}

function canAccess(filePath: string, mode: number): boolean {
  try {
    accessSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingParent(filePath: string): string {
  let current = path.resolve(filePath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function formatMode(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}
