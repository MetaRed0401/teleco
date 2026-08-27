import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  listInstanceConfigs,
  readInstanceConfig,
  removeInstanceConfig,
  validateInstanceName,
} from "./instance-config.js";
import {
  getPackageRoot,
  getSystemdUserDirectory,
  getTelecoInstancesDirectory,
  isHomebrewInstall,
} from "./install-layout.js";

const RUNTIME_SERVICE = "telecodex-codex-app-server.service";

export function renderLinuxBridgeUnit(cliCommand: string[], instancesDirectory: string): string {
  return [
    "[Unit]",
    "Description=Teleco Telegram bridge (%i)",
    `Wants=${RUNTIME_SERVICE}`,
    `After=network-online.target ${RUNTIME_SERVICE}`,
    "",
    "[Service]",
    "Type=simple",
    `EnvironmentFile=${path.join(instancesDirectory, "%i.env")}`,
    "Environment=TELECO_MANAGED_SERVICE=1",
    `ExecStart=${cliCommand.map((part) => systemdQuote(part)).join(" ")} run --instance %i`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderLinuxRuntimeUnit(cliCommand: string[]): string {
  return [
    "[Unit]",
    "Description=Teleco persistent Codex app-server",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${cliCommand.map((part) => systemdQuote(part)).join(" ")} runtime`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function installLinuxServiceUnits(environment: NodeJS.ProcessEnv = process.env): void {
  const systemdDirectory = getSystemdUserDirectory(environment);
  mkdirSync(systemdDirectory, { recursive: true, mode: 0o700 });
  const command = resolveCliCommand(environment);
  const bridgeUnit = path.join(systemdDirectory, "telecodex@.service");
  const runtimeUnit = path.join(systemdDirectory, RUNTIME_SERVICE);
  writeFileSync(
    bridgeUnit,
    renderLinuxBridgeUnit(command, getTelecoInstancesDirectory(environment)),
    { mode: 0o644 },
  );
  writeFileSync(runtimeUnit, renderLinuxRuntimeUnit(command), { mode: 0o644 });
  chmodSync(bridgeUnit, 0o644);
  chmodSync(runtimeUnit, 0o644);
}

export function runLinuxServiceCommand(args: string[], environment: NodeJS.ProcessEnv = process.env): number {
  if (process.platform !== "linux") throw new Error("The current service manager supports Linux systemd only.");
  const [action = "status", target = "default", ...flags] = args;
  const force = flags.includes("--force");
  const deleteConfig = flags.includes("--delete-config");

  if (action === "list") {
    for (const instance of listInstanceConfigs(environment)) {
      const unit = serviceName(instance.name);
      const enabled = capture("systemctl", ["--user", "is-enabled", unit], environment) || "disabled";
      const active = capture("systemctl", ["--user", "is-active", unit], environment) || "inactive";
      console.log(`${instance.name}\t${enabled}\t${active}\t${instance.filePath}`);
    }
    return 0;
  }

  const targets = target === "--all"
    ? listInstanceConfigs(environment).map((instance) => instance.name)
    : [validateInstanceName(target)];
  if (targets.length === 0) throw new Error("No Teleco instances are configured.");
  for (const instance of targets) readInstanceConfig(instance, environment);

  if (["install", "start", "restart", "update"].includes(action)) {
    installLinuxServiceUnits(environment);
    run("systemctl", ["--user", "daemon-reload"], environment);
  }
  if (["restart", "update"].includes(action) && !force) {
    for (const instance of targets) assertInstanceIdle(instance, environment);
  }

  if (action === "update") {
    if (isHomebrewInstall(environment)) {
      run("brew", ["upgrade", "teleco"], environment);
    } else {
      run("pnpm", ["install", "--frozen-lockfile"], environment, getPackageRoot());
      run("pnpm", ["run", "build"], environment, getPackageRoot());
    }
  }

  if (action === "install" || action === "start") {
    run("systemctl", ["--user", "enable", "--now", RUNTIME_SERVICE], environment);
  }
  for (const instance of targets) {
    const unit = serviceName(instance);
    if (action === "install") run("systemctl", ["--user", "enable", unit], environment);
    else if (action === "start") run("systemctl", ["--user", "enable", "--now", unit], environment);
    else if (action === "stop") run("systemctl", ["--user", "stop", unit], environment);
    else if (action === "restart" || action === "update") run("systemctl", ["--user", "restart", unit], environment);
    else if (action === "status") run("systemctl", ["--user", "status", unit, "--no-pager"], environment);
    else if (action === "logs") run("journalctl", ["--user", "-u", unit, "-f"], environment);
    else if (action === "remove") {
      run("systemctl", ["--user", "disable", "--now", unit], environment, undefined, true);
      if (deleteConfig) removeInstanceConfig(instance, environment);
    } else {
      throw new Error(`Unknown service command: ${action}`);
    }
  }
  return 0;
}

function resolveCliCommand(environment: NodeJS.ProcessEnv): string[] {
  const executable = environment.TELECO_EXECUTABLE?.trim();
  if (executable) return [executable];
  const entry = environment.TELECO_CLI_ENTRY?.trim() || process.argv[1];
  return [process.execPath, path.resolve(entry)];
}

function serviceName(instance: string): string {
  return `telecodex@${validateInstanceName(instance)}.service`;
}

function systemdQuote(value: string, escapeSpecifier = true): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, escapeSpecifier ? "%%" : "%");
  return `"${escaped}"`;
}

function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  allowFailure = false,
): void {
  if (environment.TELECO_SERVICE_DRY_RUN === "1") {
    console.log([command, ...args].join(" "));
    return;
  }
  const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw result.error ?? new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

function capture(command: string, args: string[], environment: NodeJS.ProcessEnv): string {
  if (environment.TELECO_SERVICE_DRY_RUN === "1") return "dry-run";
  const result = spawnSync(command, args, { env: environment, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function assertInstanceIdle(instance: string, environment: NodeJS.ProcessEnv): void {
  const values = readInstanceConfig(instance, environment).values;
  const workspace = values.TELECODEX_WORKSPACE || process.cwd();
  const stateDirectory = instance === "default"
    ? path.join(workspace, ".telecodex")
    : path.join(workspace, ".telecodex", instance);
  const operationsPath = path.join(stateDirectory, "active-operations.json");
  if (!existsSync(operationsPath)) return;
  try {
    const records = JSON.parse(readFileSync(operationsPath, "utf8")) as Array<{
      status?: unknown;
      ownerPid?: unknown;
    }>;
    const active = Array.isArray(records) && records.some((record) => {
      if (record.status !== "running" || typeof record.ownerPid !== "number") return false;
      try {
        process.kill(record.ownerPid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (active) throw new Error(`Instance '${instance}' has active Codex work. Retry when idle or use --force.`);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}
