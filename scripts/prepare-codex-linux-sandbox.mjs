import { chmod, copyFile, lstat, symlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform !== "linux") {
  process.exit(0);
}

const platform = {
  x64: {
    packageName: "@openai/codex-linux-x64",
    target: "x86_64-unknown-linux-musl",
  },
  arm64: {
    packageName: "@openai/codex-linux-arm64",
    target: "aarch64-unknown-linux-musl",
  },
}[process.arch];

if (!platform) {
  console.warn(
    `[telecodex] Skipping Codex sandbox helper preparation for unsupported architecture: ${process.arch}`,
  );
  process.exit(0);
}

const require = createRequire(import.meta.url);
let packageRoot;

try {
  const codexPackageJson = require.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackageJson);
  const packageJson = codexRequire.resolve(`${platform.packageName}/package.json`);
  packageRoot = path.dirname(packageJson);
} catch {
  console.warn(
    `[telecodex] ${platform.packageName} is unavailable; Codex sandbox helper was not prepared.`,
  );
  process.exit(0);
}

const binDirectory = path.join(packageRoot, "vendor", platform.target, "bin");
const codexPath = path.join(binDirectory, "codex");
const helperPath = path.join(binDirectory, "codex-linux-sandbox");

try {
  await lstat(helperPath);
  process.exit(0);
} catch {
  // Codex 0.145.x Linux packages omit this multicall helper entry.
}

try {
  await symlink("codex", helperPath);
} catch (error) {
  if (error?.code !== "EPERM" && error?.code !== "EACCES") {
    throw error;
  }
  await copyFile(codexPath, helperPath);
  await chmod(helperPath, 0o755);
}

console.log(`[telecodex] Prepared Codex Linux sandbox helper: ${helperPath}`);
