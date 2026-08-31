import { chmodSync, mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { collectInstallDoctor, renderInstallDoctor } from "../src/install-doctor.js";
import { writeInstanceConfig } from "../src/instance-config.js";
import { getTelecoVersion } from "../src/version.js";

describe("install doctor", () => {
  it("accepts private configuration and writable workspaces offline", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-doctor-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: path.join(root, "config") };
    writeInstanceConfig("first", {
      TELEGRAM_BOT_TOKEN: "123:secret",
      TELEGRAM_ALLOWED_USER_IDS: "1",
      TELECODEX_WORKSPACE: workspace,
    }, environment);

    const checks = await collectInstallDoctor({ offline: true, environment });
    expect(renderInstallDoctor(checks).exitCode).toBe(0);
    expect(checks.find((check) => check.name === "Instance first")?.detail).toContain("(600)");
  });

  it("reports unsafe permissions and missing workspaces without exposing secrets", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-doctor-"));
    const environment: NodeJS.ProcessEnv = { TELECO_CONFIG_HOME: path.join(root, "config") };
    const saved = writeInstanceConfig("first", {
      TELEGRAM_BOT_TOKEN: "123:secret",
      TELEGRAM_ALLOWED_USER_IDS: "1",
      TELECODEX_WORKSPACE: path.join(root, "missing"),
    }, environment);
    chmodSync(path.join(root, "config"), 0o755);
    chmodSync(saved.filePath, 0o644);

    const result = renderInstallDoctor(await collectInstallDoctor({ offline: true, environment }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAIL\tConfig");
    expect(result.output).toContain("FAIL\tInstance first");
    expect(result.output).toContain("FAIL\tWorkspace first");
    expect(result.output).not.toContain("123:secret");
  });

  it("checks Homebrew version, auth, app-server, service health, and duplicates online", async () => {
    const telecoVersion = getTelecoVersion();
    const root = mkdtempSync(path.join(os.tmpdir(), "teleco-doctor-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const environment: NodeJS.ProcessEnv = {
      TELECO_CONFIG_HOME: path.join(root, "config"),
      TELECO_INSTALL_MODE: "homebrew",
    };
    writeInstanceConfig("first", {
      TELEGRAM_BOT_TOKEN: "123:secret",
      TELEGRAM_ALLOWED_USER_IDS: "1",
      TELECODEX_WORKSPACE: workspace,
    }, environment);
    let codexCommand = "";
    let codexEnvironment: NodeJS.ProcessEnv | undefined;
    const runCommand = (command: string, args: string[], commandEnvironment?: NodeJS.ProcessEnv) => {
      const joined = `${command} ${args.join(" ")}`;
      if (args.join(" ") === "--version") {
        codexCommand = command;
        codexEnvironment = commandEnvironment;
        return { ok: true, output: "codex-cli 0.150.0" };
      }
      if (args.join(" ") === "app-server --help") return { ok: true, output: "usage" };
      if (joined === "brew list --versions teleco") return { ok: true, output: `teleco ${telecoVersion}` };
      if (joined === "systemctl --user show-environment") return { ok: true, output: "PATH=/usr/bin" };
      if (joined.includes("is-active")) return { ok: true, output: "active" };
      return { ok: false, output: "" };
    };

    const checks = await collectInstallDoctor({
      offline: false,
      environment,
      platform: "linux",
      runCommand,
      checkAuth: async () => ({ authenticated: true, method: "cli", detail: "account@example.com" }),
    });
    const result = renderInstallDoctor(checks);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`OK\tHomebrew version\tteleco ${telecoVersion}`);
    expect(result.output).toContain("FAIL\tDuplicate services");
    expect(result.output).toContain("codex-cli 0.150.0");
    expect(codexCommand).toContain("node_modules/.bin/codex");
    expect(codexEnvironment?.PATH).toContain("/home/linuxbrew/.linuxbrew/bin");
    expect(result.output).not.toContain("account@example.com");
  });
});
