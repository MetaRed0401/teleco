import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  projectId?: string;
  name?: string;
  title: string;
  preview?: string;
  cwd: string;
  model: string | null;
  reasoningEffort?: string;
  gitBranch?: string;
  isPinned?: boolean;
  section?: {
    id: string;
    name?: string;
    position?: number;
  };
  sectionEnteredAt?: Date;
  source?: string;
  cliVersion?: string;
  createdAt: Date;
  updatedAt: Date;
  recencyAt?: Date;
  firstUserMessage: string;
}

export type WorkspaceAvailability =
  | { available: true; reason: "available" }
  | { available: false; reason: "invalid" | "missing" | "not-directory" | "access-denied" | "unavailable" };

export interface CodexModelRecord {
  slug: string;
  displayName: string;
  contextWindow?: number;
  maxContextWindow?: number;
  effectiveContextWindowPercent?: number;
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.5", displayName: "GPT-5.5" },
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5.3-codex", displayName: "gpt-5.3-codex" },
  { slug: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark" },
  { slug: "gpt-5.2", displayName: "gpt-5.2" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  project_id: unknown;
  name: unknown;
  title: unknown;
  preview: unknown;
  cwd: unknown;
  model: unknown;
  reasoning_effort: unknown;
  git_branch: unknown;
  is_pinned: unknown;
  thread_section_id: unknown;
  section_name: unknown;
  section_position: unknown;
  section_entered_at_ms: unknown;
  source: unknown;
  thread_source: unknown;
  cli_version: unknown;
  created_at: unknown;
  created_at_ms: unknown;
  updated_at: unknown;
  updated_at_ms: unknown;
  recency_at: unknown;
  recency_at_ms: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};

type TableInfoRow = {
  name: unknown;
};

const require = createRequire(import.meta.url);
const BetterSqlite3 = loadBetterSqlite3();

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  const safeLimit = normalizeLimit(limit);
  return (
    withDatabase(
      (db) => {
        const columns = getThreadColumns(db);
        const userThreadFilter = buildUserThreadFilter(columns);
        const threadSelect = buildThreadSelect(columns);
        const recencyOrder = buildThreadRecencyOrder(columns);
        const query = db.prepare(`
          SELECT ${threadSelect}
          FROM threads
          WHERE (archived = 0 OR archived IS NULL)
            ${userThreadFilter}
          ORDER BY ${recencyOrder} DESC
          LIMIT ?
        `);

        const rows = query.all(safeLimit) as ThreadRow[];
        return rows.map(mapThreadRow);
      },
      (databasePath) => {
        const columns = getThreadColumnsWithSqliteCli(databasePath);
        const userThreadFilter = buildUserThreadFilter(columns);
        const threadSelect = buildThreadSelect(columns);
        const recencyOrder = buildThreadRecencyOrder(columns);
        const rows = queryJsonWithSqliteCli<ThreadRow>(
          databasePath,
          `
            SELECT ${threadSelect}
            FROM threads
            WHERE (archived = 0 OR archived IS NULL)
              ${userThreadFilter}
            ORDER BY ${recencyOrder} DESC
            LIMIT ${safeLimit}
          `,
        );
        return rows.map(mapThreadRow);
      },
    ) ?? []
  );
}

export function getThread(id: string): CodexThreadRecord | null {
  return (
    withDatabase(
      (db) => {
        const columns = getThreadColumns(db);
        const userThreadFilter = buildUserThreadFilter(columns);
        const threadSelect = buildThreadSelect(columns);
        const query = db.prepare(`
          SELECT ${threadSelect}
          FROM threads
          WHERE archived = 0
            ${userThreadFilter}
            AND id = ?
          LIMIT 1
        `);

        const row = query.get(id) as ThreadRow | undefined;
        return row ? mapThreadRow(row) : null;
      },
      (databasePath) => {
        const columns = getThreadColumnsWithSqliteCli(databasePath);
        const userThreadFilter = buildUserThreadFilter(columns);
        const threadSelect = buildThreadSelect(columns);
        const rows = queryJsonWithSqliteCli<ThreadRow>(
          databasePath,
          `
            SELECT ${threadSelect}
            FROM threads
            WHERE archived = 0
              ${userThreadFilter}
              AND id = ${sqlStringLiteral(id)}
            LIMIT 1
          `,
        );
        const row = rows[0];
        return row ? mapThreadRow(row) : null;
      },
    ) ?? null
  );
}

export function inspectWorkspace(workspace: string): WorkspaceAvailability {
  const candidate = workspace.trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    return { available: false, reason: "invalid" };
  }
  if (!existsSync(candidate)) {
    return { available: false, reason: "missing" };
  }

  try {
    if (!statSync(candidate).isDirectory()) {
      return { available: false, reason: "not-directory" };
    }
    accessSync(candidate, constants.R_OK | constants.X_OK);
    return { available: true, reason: "available" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      available: false,
      reason: code === "EACCES" || code === "EPERM" ? "access-denied" : "unavailable",
    };
  }
}

export function listWorkspaces(): string[] {
  return (
    withDatabase(
      (db) => {
        const userThreadFilter = buildUserThreadFilter(getThreadColumns(db));
        const query = db.prepare(`
          SELECT DISTINCT cwd
          FROM threads
          WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
            ${userThreadFilter}
          ORDER BY cwd ASC
        `);

        const rows = query.all() as WorkspaceRow[];
        return rows
          .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
          .filter(Boolean);
      },
      (databasePath) => {
        const userThreadFilter = buildUserThreadFilter(getThreadColumnsWithSqliteCli(databasePath));
        const rows = queryJsonWithSqliteCli<WorkspaceRow>(
          databasePath,
          `
            SELECT DISTINCT cwd
            FROM threads
            WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
              ${userThreadFilter}
            ORDER BY cwd ASC
          `,
        );
        return rows
          .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
          .filter(Boolean);
      },
    ) ?? []
  );
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
        context_window?: unknown;
        max_context_window?: unknown;
        effective_context_window_percent?: unknown;
      }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => !["hide", "hidden"].includes(String(model.visibility ?? "")))
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
        contextWindow: typeof model.context_window === "number" ? model.context_window : undefined,
        maxContextWindow: typeof model.max_context_window === "number" ? model.max_context_window : undefined,
        effectiveContextWindowPercent:
          typeof model.effective_context_window_percent === "number"
            ? model.effective_context_window_percent
            : undefined,
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  const projectId = typeof row.project_id === "string" ? row.project_id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const preview = typeof row.preview === "string" ? row.preview.trim() : "";
  const reasoningEffort = typeof row.reasoning_effort === "string" ? row.reasoning_effort.trim() : "";
  const gitBranch = typeof row.git_branch === "string" ? row.git_branch.trim() : "";
  const sectionId = typeof row.thread_section_id === "string" ? row.thread_section_id.trim() : "";
  const sectionName = typeof row.section_name === "string" ? row.section_name.trim() : "";
  const sectionPosition = typeof row.section_position === "number" ? row.section_position : undefined;
  const source = parseThreadSource(row.thread_source) ?? parseThreadSource(row.source);
  const cliVersion = typeof row.cli_version === "string" ? row.cli_version.trim() : "";
  const recencyAt = fromOptionalUnixMilliseconds(row.recency_at_ms) ?? fromOptionalUnixSeconds(row.recency_at);
  const sectionEnteredAt = fromOptionalUnixMilliseconds(row.section_entered_at_ms);

  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    ...(projectId ? { projectId } : {}),
    ...(name ? { name } : {}),
    title: typeof row.title === "string" ? row.title : "",
    ...(preview ? { preview } : {}),
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(row.is_pinned === 1 || row.is_pinned === true ? { isPinned: true } : {}),
    ...(sectionId
      ? { section: { id: sectionId, ...(sectionName ? { name: sectionName } : {}), ...(sectionPosition !== undefined ? { position: sectionPosition } : {}) } }
      : {}),
    ...(sectionEnteredAt ? { sectionEnteredAt } : {}),
    ...(source ? { source } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    createdAt: fromOptionalUnixMilliseconds(row.created_at_ms) ?? fromUnixSeconds(row.created_at),
    updatedAt: fromOptionalUnixMilliseconds(row.updated_at_ms) ?? fromUnixSeconds(row.updated_at),
    ...(recencyAt ? { recencyAt } : {}),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
}

function fromOptionalUnixSeconds(value: unknown): Date | undefined {
  return typeof value === "number" ? new Date(value * 1000) : undefined;
}

function fromOptionalUnixMilliseconds(value: unknown): Date | undefined {
  return typeof value === "number" && value > 0 ? new Date(value) : undefined;
}

function parseThreadSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim();
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>)[0] ?? normalized;
    }
  } catch {
    // Plain source names are expected for newer state database columns.
  }
  return normalized;
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T, fallback?: (databasePath: string) => T): T | null {
  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  if (BetterSqlite3) {
    let db: DatabaseInstance | null = null;
    try {
      db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
      return fn(db);
    } catch {
      // Fall through to sqlite3 CLI fallback.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close failures.
      }
    }
  }

  if (fallback) {
    try {
      return fallback(databasePath);
    } catch {
      return null;
    }
  }

  return null;
}

function getCodexDir(): string | null {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    return path.resolve(codexHome);
  }

  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".codex") : null;
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}

function loadBetterSqlite3(): DatabaseCtor | null {
  try {
    return require("better-sqlite3") as DatabaseCtor;
  } catch {
    return null;
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 20;
  }

  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function getThreadColumns(db: DatabaseInstance): Set<string> {
  const rows = db.prepare("PRAGMA table_info(threads)").all() as TableInfoRow[];
  return new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")).filter(Boolean));
}

function getThreadColumnsWithSqliteCli(databasePath: string): Set<string> {
  const rows = queryJsonWithSqliteCli<TableInfoRow>(databasePath, "PRAGMA table_info(threads)");
  return new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")).filter(Boolean));
}

function buildThreadSelect(columns: Set<string>): string {
  const optionalColumn = (name: string, fallback: string) =>
    columns.has(name) ? name : `${fallback} AS ${name}`;

  return [
    "id",
    optionalColumn("project_id", "NULL"),
    optionalColumn("name", "NULL"),
    "title",
    optionalColumn("preview", "''"),
    "cwd",
    "model",
    optionalColumn("reasoning_effort", "NULL"),
    optionalColumn("git_branch", "NULL"),
    optionalColumn("is_pinned", "0"),
    optionalColumn("thread_section_id", "NULL"),
    columns.has("thread_section_id")
      ? "(SELECT name FROM thread_sections WHERE id = threads.thread_section_id) AS section_name"
      : "NULL AS section_name",
    optionalColumn("section_position", "NULL"),
    optionalColumn("section_entered_at_ms", "NULL"),
    optionalColumn("source", "NULL"),
    optionalColumn("thread_source", "NULL"),
    optionalColumn("cli_version", "''"),
    "created_at",
    optionalColumn("created_at_ms", "NULL"),
    "updated_at",
    optionalColumn("updated_at_ms", "NULL"),
    optionalColumn("recency_at", "updated_at"),
    optionalColumn("recency_at_ms", "NULL"),
    "first_user_message",
  ].join(", ");
}

function buildThreadRecencyOrder(columns: Set<string>): string {
  return columns.has("recency_at_ms")
    ? "COALESCE(NULLIF(recency_at_ms, 0), recency_at * 1000, updated_at * 1000)"
    : columns.has("recency_at")
      ? "COALESCE(recency_at, updated_at)"
      : "updated_at";
}

function buildUserThreadFilter(columns: Set<string>): string {
  const conditions: string[] = [];
  if (columns.size === 0 || columns.has("source")) {
    conditions.push("(source IS NULL OR LOWER(CAST(source AS TEXT)) NOT LIKE '%subagent%')");
  }
  if (columns.has("thread_source")) {
    conditions.push(
      "(thread_source IS NULL OR LOWER(CAST(thread_source AS TEXT)) NOT LIKE '%subagent%')",
    );
  }
  return conditions.map((condition) => `AND ${condition}`).join("\n            ");
}

function queryJsonWithSqliteCli<T>(databasePath: string, sql: string): T[] {
  const sqliteCommand = findSqliteCommand();
  if (!sqliteCommand) {
    return [];
  }

  const output = execFileSync(sqliteCommand, ["-readonly", "-json", databasePath, sql], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function findSqliteCommand(): string | null {
  const candidates = [
    "sqlite3",
    "/home/linuxbrew/.linuxbrew/bin/sqlite3",
    "/usr/local/bin/sqlite3",
    "/usr/bin/sqlite3",
    "/bin/sqlite3",
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}
