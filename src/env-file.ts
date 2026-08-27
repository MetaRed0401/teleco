import { existsSync, readFileSync } from "node:fs";

export type EnvironmentRecord = Record<string, string>;

export function parseEnvironmentText(contents: string): EnvironmentRecord {
  const values: EnvironmentRecord = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex < 1) continue;
    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseEnvironmentValue(normalized.slice(separatorIndex + 1).trim());
  }
  return values;
}

export function readEnvironmentFile(filePath: string): EnvironmentRecord {
  return existsSync(filePath) ? parseEnvironmentText(readFileSync(filePath, "utf8")) : {};
}

export function loadEnvironmentFile(
  filePath: string,
  target: NodeJS.ProcessEnv = process.env,
  override = false,
): void {
  for (const [key, value] of Object.entries(readEnvironmentFile(filePath))) {
    if (override || target[key] === undefined) target[key] = value;
  }
}

export function serializeEnvironment(values: EnvironmentRecord): string {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${serializeEnvironmentValue(value)}`)
    .join("\n")}\n`;
}

function parseEnvironmentValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\\n/g, "\n");
}

function serializeEnvironmentValue(value: string): string {
  return /^[A-Za-z0-9_./,:@%+\-]*$/.test(value) ? value : JSON.stringify(value);
}
