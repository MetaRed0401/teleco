import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  importInstanceConfig,
  listInstanceConfigs,
  migrateLegacyInstanceConfigs,
  planLegacyInstanceMigration,
  readInstanceConfig,
  redactInstanceValues,
  writeInstanceConfig,
} from "../src/instance-config.js";

describe("instance configuration", () => {
  it("writes isolated atomic configurations with private permissions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-config-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: root };
    const saved = writeInstanceConfig("first", {
      TELEGRAM_BOT_TOKEN: "123:secret",
      TELEGRAM_ALLOWED_USER_IDS: "1,2",
      TELECODEX_WORKSPACE: "/workspace",
    }, environment);

    expect(statSync(saved.filePath).mode & 0o777).toBe(0o600);
    expect(readInstanceConfig("first", environment).values.TELEGRAM_BOT_TOKEN).toBe("123:secret");
    expect(listInstanceConfigs(environment).map((instance) => instance.name)).toEqual(["first"]);
  });

  it("rejects duplicate bot tokens across instances", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-config-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: root };
    const values = { TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_ALLOWED_USER_IDS: "1" };
    writeInstanceConfig("first", values, environment);
    expect(() => writeInstanceConfig("second", values, environment)).toThrow(/already used/);
  });

  it("preserves the legacy project directory as the imported workspace", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-config-"));
    const project = path.join(root, "project");
    mkdirSync(project);
    const source = path.join(project, ".env.first");
    writeFileSync(source, "TELEGRAM_BOT_TOKEN=123:secret\nTELEGRAM_ALLOWED_USER_IDS=1\n");

    const imported = importInstanceConfig(source, "first", {
      TELECO_CONFIG_HOME: path.join(root, "config"),
    });

    expect(imported.values.TELECODEX_WORKSPACE).toBe(project);
  });

  it("migrates legacy files with previews, backups, comments, and private permissions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-migration-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: path.join(root, "config") };
    writeFileSync(path.join(root, ".env"), "# default bot\nTELEGRAM_BOT_TOKEN=123:default\nTELEGRAM_ALLOWED_USER_IDS=1\n");
    writeFileSync(path.join(root, ".env.first"), "TELEGRAM_BOT_TOKEN=456:first\nTELEGRAM_ALLOWED_USER_IDS=2\n");
    writeFileSync(path.join(root, ".env.example"), "TELEGRAM_BOT_TOKEN=ignored\n");

    const plan = planLegacyInstanceMigration(root, environment);
    expect(plan.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["default", "ready"],
      ["first", "ready"],
    ]);

    const migrated = migrateLegacyInstanceConfigs(plan, environment);
    expect(migrated.map((instance) => instance.name)).toEqual(["default", "first"]);
    expect(readFileSync(getInstancePath(environment, "default"), "utf8")).toContain("# default bot");
    expect(readInstanceConfig("first", environment).values.TELECODEX_WORKSPACE).toBe(root);
    expect(readFileSync(path.join(root, ".env.teleco-backup"), "utf8")).toContain("123:default");
    expect(statSync(path.join(root, ".env.teleco-backup")).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(root, ".env"))).toBe(true);
    expect(planLegacyInstanceMigration(root, environment).entries.every(
      (entry) => entry.status === "already-migrated",
    )).toBe(true);
  });

  it("skips matching migrated instances while migrating remaining legacy files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-migration-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: path.join(root, "config") };
    const defaultValues = {
      TELEGRAM_BOT_TOKEN: "123:default",
      TELEGRAM_ALLOWED_USER_IDS: "1",
      TELECODEX_WORKSPACE: root,
    };
    writeFileSync(path.join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:default\nTELEGRAM_ALLOWED_USER_IDS=1\n");
    writeFileSync(path.join(root, ".env.second"), "TELEGRAM_BOT_TOKEN=456:second\nTELEGRAM_ALLOWED_USER_IDS=2\n");
    writeInstanceConfig("default", defaultValues, environment);

    const plan = planLegacyInstanceMigration(root, environment);
    expect(plan.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["default", "already-migrated"],
      ["second", "ready"],
    ]);
    expect(migrateLegacyInstanceConfigs(plan, environment).map((instance) => instance.name)).toEqual(["second"]);
    expect(existsSync(path.join(root, ".env.teleco-backup"))).toBe(false);
  });

  it("validates every legacy file before creating migration artifacts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-migration-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: path.join(root, "config") };
    writeFileSync(path.join(root, ".env"), "TELEGRAM_ALLOWED_USER_IDS=1\n");

    expect(() => planLegacyInstanceMigration(root, environment)).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(existsSync(path.join(root, ".env.teleco-backup"))).toBe(false);
    expect(listInstanceConfigs(environment)).toEqual([]);
  });

  it("rolls back backups when a planned migration cannot finish", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-migration-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: path.join(root, "config") };
    writeFileSync(path.join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:default\nTELEGRAM_ALLOWED_USER_IDS=1\n");
    writeFileSync(path.join(root, ".env.second"), "TELEGRAM_BOT_TOKEN=456:second\nTELEGRAM_ALLOWED_USER_IDS=2\n");
    const plan = planLegacyInstanceMigration(root, environment);
    rmSync(path.join(root, ".env.second"));

    expect(() => migrateLegacyInstanceConfigs(plan, environment)).toThrow();
    expect(existsSync(path.join(root, ".env.teleco-backup"))).toBe(false);
    expect(listInstanceConfigs(environment)).toEqual([]);
  });

  it("redacts secrets without mutating ordinary values", () => {
    expect(redactInstanceValues({ TELEGRAM_BOT_TOKEN: "123:secret", TELECODEX_WORKSPACE: "/work" })).toEqual({
      TELEGRAM_BOT_TOKEN: "***",
      TELECODEX_WORKSPACE: "/work",
    });
  });
});

function getInstancePath(environment: NodeJS.ProcessEnv, name: string): string {
  return path.join(environment.TELECO_CONFIG_HOME!, "instances", `${name}.env`);
}
