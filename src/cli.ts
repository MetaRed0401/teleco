#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { loadEnvironmentFile, serializeEnvironment, type EnvironmentRecord } from "./env-file.js";
import {
  getInstanceConfigPath,
  importInstanceConfig,
  listInstanceConfigs,
  migrateLegacyInstanceConfigs,
  planLegacyInstanceMigration,
  readInstanceConfig,
  redactInstanceValues,
  removeInstanceConfig,
  writeInstanceConfig,
} from "./instance-config.js";
import { getPackageRoot, getTelecoConfigRoot, isHomebrewInstall } from "./install-layout.js";
import { collectInstallDoctor, renderInstallDoctor } from "./install-doctor.js";
import { runLinuxServiceCommand } from "./linux-service.js";
import { readHiddenInput } from "./secret-input.js";
import { getTelecoVersion } from "./version.js";

await main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(args: string[]): Promise<void> {
  const [command = "help", ...rest] = args;
  if (command === "--version" || command === "version") return void console.log(`teleco ${getTelecoVersion()}`);
  if (command === "help" || command === "--help" || command === "-h") return void printHelp();
  if (command === "config" && rest[0] === "path") return void console.log(getTelecoConfigRoot());
  if (command === "instance") return runInstanceCommand(rest);
  if (command === "service") return void (process.exitCode = runLinuxServiceCommand(rest));
  if (command === "doctor") return void (process.exitCode = await runDoctor(rest.includes("--offline")));
  if (command === "runtime") return runRuntime();
  if (command === "run") return runBridge(rest);
  throw new Error(`Unknown command: ${command}. Run teleco help.`);
}

async function runInstanceCommand(args: string[]): Promise<void> {
  const [action = "list", name, ...flags] = args;
  if (action === "list") {
    for (const instance of listInstanceConfigs()) console.log(`${instance.name}\t${instance.filePath}`);
    return;
  }
  if (action === "show") {
    if (!name) throw new Error("Usage: teleco instance show <name>");
    console.log(serializeEnvironment(redactInstanceValues(readInstanceConfig(name).values)).trimEnd());
    return;
  }
  if (action === "import") {
    if (!name || !flags[0]) throw new Error("Usage: teleco instance import <env-file> <name>");
    const imported = importInstanceConfig(name, flags[0]);
    console.log(`Imported ${imported.name}: ${imported.filePath}`);
    return;
  }
  if (action === "migrate") {
    const migrationArgs = [name, ...flags].filter((value): value is string => value !== undefined);
    const sourceDirectory = path.resolve(migrationArgs.find((value) => !value.startsWith("--")) || process.cwd());
    const plan = planLegacyInstanceMigration(sourceDirectory);
    if (plan.entries.length === 0) {
      console.log(`No legacy .env files found in ${sourceDirectory}`);
      return;
    }
    for (const entry of plan.entries) {
      const label = entry.status === "ready" ? "MIGRATE" : "SKIP";
      console.log(`${label}\t${entry.name}\t${entry.sourcePath} -> ${entry.destinationPath}`);
      if (entry.status === "ready") console.log(`BACKUP\t${entry.backupPath}`);
    }
    const ready = plan.entries.filter((entry) => entry.status === "ready");
    if (ready.length === 0) {
      console.log("All detected instances are already migrated.");
      return;
    }
    if (!migrationArgs.includes("--yes")) {
      if (!process.stdin.isTTY) throw new Error("Non-interactive migration requires --yes.");
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await readline.question(`Migrate ${ready.length} instance(s)? [y/N]: `);
        if (!/^(?:y|yes)$/i.test(answer.trim())) {
          console.log("Migration cancelled.");
          return;
        }
      } finally {
        readline.close();
      }
    }
    const migrated = migrateLegacyInstanceConfigs(plan);
    console.log(`Migrated ${migrated.length} instance(s). Legacy files were retained.`);
    return;
  }
  if (action === "remove") {
    if (!name || !flags.includes("--force")) throw new Error("Usage: teleco instance remove <name> --force");
    removeInstanceConfig(name);
    console.log(`Removed instance configuration: ${name}`);
    return;
  }
  if (action !== "add" && action !== "edit") throw new Error(`Unknown instance command: ${action}`);
  if (!name) throw new Error(`Usage: teleco instance ${action} <name>`);

  const existing = action === "edit" ? readInstanceConfig(name).values : {};
  const tokenFromStdin = flags.includes("--token-stdin");
  if (!process.stdin.isTTY && !tokenFromStdin) {
    throw new Error("Non-interactive token input requires --token-stdin.");
  }
  const token = await readHiddenInput("Telegram bot token");
  const allowedUsersOption = optionValue(flags, "--allowed-users");
  const workspaceOption = optionValue(flags, "--workspace");
  let allowedUsers = allowedUsersOption;
  let workspace = workspaceOption;
  if (tokenFromStdin) {
    if (!allowedUsers) throw new Error("--token-stdin requires --allowed-users <ids>.");
  } else {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      allowedUsers = await readline.question(
        `Allowed Telegram user IDs${existing.TELEGRAM_ALLOWED_USER_IDS ? ` [${existing.TELEGRAM_ALLOWED_USER_IDS}]` : ""}: `,
      );
      workspace = await readline.question(`Workspace [${existing.TELECODEX_WORKSPACE || process.cwd()}]: `);
    } finally {
      readline.close();
    }
  }
  const values: EnvironmentRecord = {
    ...existing,
    TELEGRAM_BOT_TOKEN: token || existing.TELEGRAM_BOT_TOKEN || "",
    TELEGRAM_ALLOWED_USER_IDS: allowedUsers?.trim() || existing.TELEGRAM_ALLOWED_USER_IDS || "",
    TELECODEX_WORKSPACE: path.resolve(workspace?.trim() || existing.TELECODEX_WORKSPACE || process.cwd()),
    ENABLE_CODEX_APP_SERVER_RUNTIME: existing.ENABLE_CODEX_APP_SERVER_RUNTIME || "true",
  };
  const saved = writeInstanceConfig(name, values);
  console.log(`Saved ${saved.name}: ${saved.filePath}`);
}

async function runBridge(args: string[]): Promise<void> {
  const instance = optionValue(args, "--instance") || "default";
  const explicitEnv = optionValue(args, "--env-file");
  let envPath = explicitEnv ? path.resolve(explicitEnv) : getInstanceConfigPath(instance);
  if (!existsSync(envPath)) {
    const legacyPath = path.resolve(process.cwd(), instance === "default" ? ".env" : `.env.${instance}`);
    if (!existsSync(legacyPath)) throw new Error(`Instance configuration not found: ${envPath}`);
    envPath = legacyPath;
  }
  loadEnvironmentFile(envPath, process.env, true);
  process.env.TELECODEX_ENV_FILE = envPath;
  process.env.TELECODEX_INSTANCE = instance;
  process.env.TELECO_CLI_ENTRY = path.resolve(process.argv[1]);
  if (isHomebrewInstall()) process.env.TELECO_INSTALL_MODE = "homebrew";
  const workspace = process.env.TELECODEX_WORKSPACE?.trim();
  if (workspace) process.chdir(path.resolve(workspace));
  await import("./index.js");
}

async function runRuntime(): Promise<void> {
  const script = path.join(getPackageRoot(), "scripts", "codex-app-server-daemon.sh");
  if (!existsSync(script)) throw new Error(`Codex runtime script is missing: ${script}`);
  const child = spawn(script, [], { cwd: getPackageRoot(), env: process.env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (status !== 0) throw new Error(`Codex runtime exited with status ${status}.`);
}

async function runDoctor(offline: boolean): Promise<number> {
  const result = renderInstallDoctor(await collectInstallDoctor({ offline }));
  console.log(result.output);
  return result.exitCode;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`Teleco ${getTelecoVersion()}

Usage:
  teleco run [--instance <name>] [--env-file <path>]
  teleco instance add|edit <name> [--token-stdin --allowed-users <ids> --workspace <path>]
  teleco instance import <env-file> <name>
  teleco instance migrate [directory] [--yes]
  teleco instance list
  teleco instance show <name>
  teleco instance remove <name> --force
  teleco service install|start|stop|restart|status|logs|update|remove [name|--all]
  teleco doctor [--offline]
  teleco config path
  teleco --version`);
}
