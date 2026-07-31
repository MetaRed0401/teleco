import { chmod, copyFile, lstat, realpath, stat, symlink } from "node:fs/promises";
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
let codexVersion;

try {
  const codexPackageJson = require.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackageJson);
  codexVersion = codexRequire(codexPackageJson).version;
  const packageJson = codexRequire.resolve(`${platform.packageName}/package.json`);
  packageRoot = path.dirname(packageJson);
} catch {
  console.warn(
    `[telecodex] ${platform.packageName} is unavailable; Codex sandbox helper was not prepared.`,
  );
  process.exit(0);
}

const packageRootPath = path.resolve(packageRoot);
const binDirectory = path.join(packageRoot, "vendor", platform.target, "bin");
const codexPath = path.join(binDirectory, "codex");
const helperPath = path.join(binDirectory, "codex-linux-sandbox");

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

for (const candidate of [binDirectory, codexPath, helperPath]) {
  if (!isWithinRoot(packageRootPath, path.resolve(candidate))) {
    throw new Error(`[telecodex] Refusing unsafe Codex sandbox path outside package root: ${candidate}`);
  }
}

try {
  await lstat(helperPath);
  console.log(`[telecodex] Codex Linux sandbox helper already exists: ${helperPath}`);
  process.exit(0);
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

if (!/^0\.145\.\d+(?:[-+].*)?$/.test(codexVersion ?? "")) {
  console.log(
    `[telecodex] Skipping Codex Linux sandbox helper preparation for Codex ${codexVersion ?? "unknown"}.`,
  );
  process.exit(0);
}

let sourceStats;
try {
  sourceStats = await lstat(codexPath);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.warn(`[telecodex] Codex source binary is unavailable: ${codexPath}`);
    process.exit(0);
  }
  throw error;
}

if (sourceStats.isSymbolicLink()) {
  const sourceTarget = await realpath(codexPath);
  if (!isWithinRoot(packageRootPath, sourceTarget)) {
    throw new Error(`[telecodex] Refusing Codex source symlink outside package root: ${codexPath}`);
  }
  sourceStats = await stat(codexPath);
}

if (!sourceStats.isFile()) {
  throw new Error(`[telecodex] Refusing non-regular Codex source binary: ${codexPath}`);
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
