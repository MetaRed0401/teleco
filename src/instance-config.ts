import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  parseEnvironmentText,
  readEnvironmentFile,
  serializeEnvironment,
  type EnvironmentRecord,
} from "./env-file.js";
import { getTelecoInstancesDirectory } from "./install-layout.js";

export interface InstanceConfig {
  name: string;
  filePath: string;
  values: EnvironmentRecord;
}

export interface LegacyMigrationEntry {
  name: string;
  sourcePath: string;
  destinationPath: string;
  backupPath: string;
  status: "ready" | "already-migrated";
}

export interface LegacyMigrationPlan {
  sourceDirectory: string;
  entries: LegacyMigrationEntry[];
}

export function validateInstanceName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalized) || normalized === "example") {
    throw new Error("Instance names must use 1-64 letters, numbers, underscores, or dashes.");
  }
  return normalized;
}

export function getInstanceConfigPath(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(getTelecoInstancesDirectory(environment), `${validateInstanceName(name)}.env`);
}

export function listInstanceConfigs(environment: NodeJS.ProcessEnv = process.env): InstanceConfig[] {
  const directory = getTelecoInstancesDirectory(environment);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".env"))
    .map((entry) => entry.name.slice(0, -4))
    .filter((name) => {
      try {
        validateInstanceName(name);
        return true;
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => readInstanceConfig(name, environment));
}

export function readInstanceConfig(name: string, environment: NodeJS.ProcessEnv = process.env): InstanceConfig {
  const normalized = validateInstanceName(name);
  const filePath = getInstanceConfigPath(normalized, environment);
  if (!existsSync(filePath)) throw new Error(`Instance does not exist: ${normalized}`);
  return { name: normalized, filePath, values: readEnvironmentFile(filePath) };
}

export function writeInstanceConfig(
  name: string,
  values: EnvironmentRecord,
  environment: NodeJS.ProcessEnv = process.env,
): InstanceConfig {
  const normalized = validateInstanceName(name);
  validateInstanceValues(values);
  assertUniqueBotToken(normalized, values.TELEGRAM_BOT_TOKEN, environment);
  return writeInstanceConfigContents(normalized, values, serializeEnvironment(values), environment);
}

export function planLegacyInstanceMigration(
  sourceDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): LegacyMigrationPlan {
  const resolvedDirectory = path.resolve(sourceDirectory);
  if (!existsSync(resolvedDirectory) || !statSync(resolvedDirectory).isDirectory()) {
    throw new Error(`Legacy configuration directory does not exist: ${resolvedDirectory}`);
  }

  const candidates = readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ entry, name: legacyInstanceName(entry.name) }))
    .filter((candidate): candidate is { entry: import("node:fs").Dirent; name: string } => candidate.name !== undefined)
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  const duplicateNames = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.name === candidate.name) !== index
  );
  if (duplicateNames.length > 0) {
    throw new Error(`Multiple legacy files map to instance: ${duplicateNames[0].name}`);
  }

  const tokenOwners = new Map<string, string>();
  for (const instance of listInstanceConfigs(environment)) {
    const token = instance.values.TELEGRAM_BOT_TOKEN;
    if (token) tokenOwners.set(token, instance.name);
  }

  const entries = candidates.map(({ entry, name }) => {
    const sourcePath = path.join(resolvedDirectory, entry.name);
    const values = readLegacyInstanceValues(sourcePath);
    validateInstanceValues(values);
    const tokenOwner = tokenOwners.get(values.TELEGRAM_BOT_TOKEN);
    if (tokenOwner && tokenOwner !== name) {
      throw new Error(`Telegram bot token is already used by instance: ${tokenOwner}`);
    }
    tokenOwners.set(values.TELEGRAM_BOT_TOKEN, name);

    const destinationPath = getInstanceConfigPath(name, environment);
    let status: LegacyMigrationEntry["status"] = "ready";
    if (existsSync(destinationPath)) {
      const existing = readEnvironmentFile(destinationPath);
      if (!environmentRecordsEqual(existing, values)) {
        throw new Error(`Instance already exists with different configuration: ${name}`);
      }
      status = "already-migrated";
    }
    return {
      name,
      sourcePath,
      destinationPath,
      backupPath: `${sourcePath}.teleco-backup`,
      status,
    };
  });

  return { sourceDirectory: resolvedDirectory, entries };
}

export function migrateLegacyInstanceConfigs(
  plan: LegacyMigrationPlan,
  environment: NodeJS.ProcessEnv = process.env,
): InstanceConfig[] {
  const ready = plan.entries.filter((entry) => entry.status === "ready");
  for (const entry of ready) {
    if (existsSync(entry.destinationPath)) throw new Error(`Instance already exists: ${entry.name}`);
    if (existsSync(entry.backupPath)) throw new Error(`Migration backup already exists: ${entry.backupPath}`);
  }

  const createdBackups: string[] = [];
  const createdDestinations: string[] = [];
  try {
    for (const entry of ready) {
      copyPrivateFileExclusive(entry.sourcePath, entry.backupPath);
      createdBackups.push(entry.backupPath);
    }

    const migrated: InstanceConfig[] = [];
    for (const entry of ready) {
      const contents = readFileSync(entry.backupPath, "utf8");
      const values = readLegacyInstanceValues(entry.backupPath);
      validateInstanceValues(values);
      assertUniqueBotToken(entry.name, values.TELEGRAM_BOT_TOKEN, environment);
      const saved = writeInstanceConfigContents(
        entry.name,
        values,
        appendWorkspaceIfMissing(contents, values.TELECODEX_WORKSPACE),
        environment,
      );
      createdDestinations.push(saved.filePath);
      migrated.push(saved);
    }
    return migrated;
  } catch (error) {
    for (const filePath of createdDestinations.reverse()) rmSync(filePath, { force: true });
    for (const filePath of createdBackups.reverse()) rmSync(filePath, { force: true });
    throw error;
  }
}

function writeInstanceConfigContents(
  normalizedName: string,
  values: EnvironmentRecord,
  contents: string,
  environment: NodeJS.ProcessEnv,
): InstanceConfig {
  const directory = getTelecoInstancesDirectory(environment);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filePath = getInstanceConfigPath(normalizedName, environment);
  const temporaryPath = path.join(directory, `.${normalizedName}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, contents, "utf8");
      fsyncSync(fd);
      chmodSync(temporaryPath, 0o600);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { name: normalizedName, filePath, values: { ...values } };
}

export function importInstanceConfig(
  sourcePath: string,
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): InstanceConfig {
  const resolvedSource = path.resolve(sourcePath);
  if (!existsSync(resolvedSource) || !statSync(resolvedSource).isFile()) {
    throw new Error(`Environment file does not exist: ${resolvedSource}`);
  }
  const values = readEnvironmentFile(resolvedSource);
  if (!values.TELECODEX_WORKSPACE?.trim()) {
    values.TELECODEX_WORKSPACE = path.dirname(resolvedSource);
  }
  return writeInstanceConfig(name, values, environment);
}

export function removeInstanceConfig(name: string, environment: NodeJS.ProcessEnv = process.env): void {
  const filePath = getInstanceConfigPath(name, environment);
  if (!existsSync(filePath)) throw new Error(`Instance does not exist: ${name}`);
  rmSync(filePath);
}

export function redactInstanceValues(values: EnvironmentRecord): EnvironmentRecord {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      /(?:TOKEN|KEY|SECRET|PASSWORD)/i.test(key) && value ? "***" : value,
    ]),
  );
}

function validateInstanceValues(values: EnvironmentRecord): void {
  const token = values.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[^\s]+$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN must use the BotFather token shape <bot-id>:<secret>.");
  }
  const allowedUsers = values.TELEGRAM_ALLOWED_USER_IDS?.trim();
  if (!allowedUsers || !allowedUsers.split(",").every((value) => /^\d+$/.test(value.trim()))) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain comma-separated numeric user IDs.");
  }
  const workspace = values.TELECODEX_WORKSPACE?.trim();
  if (workspace && !path.isAbsolute(workspace)) {
    throw new Error("TELECODEX_WORKSPACE must be an absolute path.");
  }
}

function assertUniqueBotToken(name: string, token: string, environment: NodeJS.ProcessEnv): void {
  const duplicate = listInstanceConfigs(environment).find(
    (instance) => instance.name !== name && instance.values.TELEGRAM_BOT_TOKEN === token,
  );
  if (duplicate) throw new Error(`Telegram bot token is already used by instance: ${duplicate.name}`);
}

function legacyInstanceName(fileName: string): string | undefined {
  if (fileName === ".env") return "default";
  if (!fileName.startsWith(".env.") || fileName === ".env.example" || fileName.endsWith(".teleco-backup")) {
    return undefined;
  }
  const name = fileName.slice(5);
  try {
    return validateInstanceName(name);
  } catch {
    return undefined;
  }
}

function readLegacyInstanceValues(sourcePath: string): EnvironmentRecord {
  const values = readEnvironmentFile(sourcePath);
  if (!values.TELECODEX_WORKSPACE?.trim()) values.TELECODEX_WORKSPACE = path.dirname(sourcePath);
  return values;
}

function appendWorkspaceIfMissing(contents: string, workspace: string): string {
  if (parseEnvironmentText(contents).TELECODEX_WORKSPACE?.trim()) return contents;
  const prefix = contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`;
  return `${prefix}${serializeEnvironment({ TELECODEX_WORKSPACE: workspace })}`;
}

function environmentRecordsEqual(left: EnvironmentRecord, right: EnvironmentRecord): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function copyPrivateFileExclusive(sourcePath: string, destinationPath: string): void {
  const contents = readFileSync(sourcePath);
  const fd = openSync(destinationPath, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
      chmodSync(destinationPath, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw error;
  }
}
