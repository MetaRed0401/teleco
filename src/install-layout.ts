import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function getTelecoConfigRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.TELECO_CONFIG_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome ? path.resolve(xdgConfigHome) : path.join(homedir(), ".config"), "teleco");
}

export function getTelecoInstancesDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(getTelecoConfigRoot(environment), "instances");
}

export function getTelecoDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.TELECO_DATA_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  return path.join(xdgDataHome ? path.resolve(xdgDataHome) : path.join(homedir(), ".local", "share"), "teleco");
}

export function getSystemdUserDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.TELECO_SYSTEMD_USER_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome ? path.resolve(xdgConfigHome) : path.join(homedir(), ".config"), "systemd", "user");
}

export function isHomebrewInstall(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.TELECO_INSTALL_MODE === "homebrew") return true;
  return /(?:^|\/)Cellar\/teleco\//.test(getPackageRoot());
}
