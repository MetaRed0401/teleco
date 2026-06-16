import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findWorkspaceFiles,
  grepWorkspaceText,
  listWorkspaceEntries,
  readWorkspaceFile,
  renderWorkspaceTree,
  resolveWorkspacePath,
} from "../src/workspace-browser.js";

describe("workspace browser", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "telecodex-workspace-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# TeleCodex\nhello workspace\n");
    await writeFile(path.join(root, "src", "bot.ts"), "export const marker = 'telegram';\n");
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps resolved paths inside the workspace", () => {
    expect(resolveWorkspacePath(root, "src/bot.ts").relativePath).toBe("src/bot.ts");
    expect(() => resolveWorkspacePath(root, "../outside")).toThrow("outside");
    expect(() => resolveWorkspacePath(root, "/tmp/outside")).toThrow("workspace-relative");
  });

  it("lists entries while filtering excluded directories", async () => {
    const result = await listWorkspaceEntries(root);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src", "README.md"]);
  });

  it("renders a bounded tree", async () => {
    const result = await renderWorkspaceTree(root, ".", 2);
    expect(result.lines.join("\n")).toContain("src/");
    expect(result.lines.join("\n")).toContain("bot.ts");
    expect(result.lines.join("\n")).not.toContain("node_modules");
  });

  it("finds files by name", async () => {
    const result = await findWorkspaceFiles(root, "bot");
    expect(result.matches.map((entry) => entry.relativePath)).toEqual(["src/bot.ts"]);
  });

  it("searches text with file and line metadata", async () => {
    const result = await grepWorkspaceText(root, "telegram");
    expect(result.matches).toEqual([
      {
        relativePath: "src/bot.ts",
        lineNumber: 1,
        line: "export const marker = 'telegram';",
      },
    ]);
  });

  it("views a line range from a text file", async () => {
    const result = await readWorkspaceFile(root, "README.md", { start: 2, end: 2 });
    expect(result.text).toBe("hello workspace");
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(2);
  });
});
