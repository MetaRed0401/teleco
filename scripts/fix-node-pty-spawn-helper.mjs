import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

if (process.platform !== "darwin") {
  process.exit(0);
}

let nodePtyRoot;
try {
  nodePtyRoot = path.dirname(require.resolve("node-pty/package.json"));
} catch {
  process.exit(0);
}

const prebuildsDir = path.join(nodePtyRoot, "prebuilds");
let entries;
try {
  entries = readdirSync(prebuildsDir, { withFileTypes: true });
} catch {
  process.exit(0);
}

for (const entry of entries) {
  if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) {
    continue;
  }

  const helperPath = path.join(prebuildsDir, entry.name, "spawn-helper");
  try {
    const stats = statSync(helperPath);
    const nextMode = stats.mode | 0o111;
    if ((stats.mode & 0o111) === 0o111) {
      continue;
    }
    chmodSync(helperPath, nextMode);
    console.log(`fixed node-pty spawn-helper permissions: ${helperPath}`);
  } catch {
    // Missing optional prebuilds are harmless on other architectures.
  }
}
