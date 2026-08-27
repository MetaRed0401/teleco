#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = option("--version") || manifest.version;
const outputRoot = path.resolve(option("--output") || path.join(root, "release"));
const archiveName = `teleco-${version}.tar.gz`;
const archivePath = path.join(outputRoot, archiveName);
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "teleco-release-"));
const stagingRoot = path.join(temporaryRoot, `teleco-${version}`);

try {
  execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });
  mkdirSync(stagingRoot, { recursive: true });
  for (const entry of [
    "dist",
    "systemd",
    ".env.example",
    "codex-versions.json",
    "LICENSE",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) {
    cpSync(path.join(root, entry), path.join(stagingRoot, entry), { recursive: true });
  }
  const scriptsRoot = path.join(stagingRoot, "scripts");
  mkdirSync(scriptsRoot, { recursive: true });
  for (const script of [
    "codex-app-server-daemon.sh",
    "fix-node-pty-spawn-helper.mjs",
    "prepare-codex-linux-sandbox.mjs",
  ]) {
    cpSync(path.join(root, "scripts", script), path.join(scriptsRoot, script));
  }
  const docsRoot = path.join(stagingRoot, "docs");
  mkdirSync(docsRoot, { recursive: true });
  cpSync(path.join(root, "docs", "homebrew-linux.md"), path.join(docsRoot, "homebrew-linux.md"));
  mkdirSync(outputRoot, { recursive: true });
  execFileSync("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    archivePath,
    "-C",
    temporaryRoot,
    path.basename(stagingRoot),
  ]);

  const checksum = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const url = option("--url") || `file://${archivePath}`;
  const formula = readFileSync(path.join(root, "packaging", "homebrew", "teleco.rb.in"), "utf8")
    .replaceAll("@VERSION@", version)
    .replaceAll("@URL@", url)
    .replaceAll("@SHA256@", checksum);
  const formulaDirectory = path.join(outputRoot, "Formula");
  mkdirSync(formulaDirectory, { recursive: true });
  writeFileSync(path.join(formulaDirectory, "teleco.rb"), formula);
  writeFileSync(path.join(outputRoot, `${archiveName}.sha256`), `${checksum}  ${archiveName}\n`);
  console.log(`Archive: ${archivePath}`);
  console.log(`Formula: ${path.join(formulaDirectory, "teleco.rb")}`);
  console.log(`SHA-256: ${checksum}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
