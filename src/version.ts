import { readFileSync } from "node:fs";

let cachedVersion: string | undefined;

export function getTelecoVersion(): string {
  if (!cachedVersion) {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof manifest.version !== "string" || !manifest.version.trim()) {
      throw new Error("Teleco package version is unavailable.");
    }
    cachedVersion = manifest.version.trim();
  }
  return cachedVersion;
}
