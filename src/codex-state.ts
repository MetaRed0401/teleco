import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

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
  title: unknown;
  cwd: unknown;
  model: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
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
        const query = db.prepare(`
          SELECT id, title, cwd, model, created_at, updated_at, first_user_message
          FROM threads
          WHERE (archived = 0 OR archived IS NULL)
          ORDER BY updated_at DESC
          LIMIT ?
        `);

        const rows = query.all(safeLimit) as ThreadRow[];
        return rows.map(mapThreadRow);
      },
      (databasePath) => {
        const rows = queryJsonWithSqliteCli<ThreadRow>(
          databasePath,
          `
            SELECT id, title, cwd, model, created_at, updated_at, first_user_message
            FROM threads
            WHERE (archived = 0 OR archived IS NULL)
            ORDER BY updated_at DESC
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
        const query = db.prepare(`
          SELECT id, title, cwd, model, created_at, updated_at, first_user_message
          FROM threads
          WHERE archived = 0 AND id = ?
          LIMIT 1
        `);

        const row = query.get(id) as ThreadRow | undefined;
        return row ? mapThreadRow(row) : null;
      },
      (databasePath) => {
        const rows = queryJsonWithSqliteCli<ThreadRow>(
          databasePath,
          `
            SELECT id, title, cwd, model, created_at, updated_at, first_user_message
            FROM threads
            WHERE archived = 0 AND id = ${sqlStringLiteral(id)}
            LIMIT 1
          `,
        );
        const row = rows[0];
        return row ? mapThreadRow(row) : null;
      },
    ) ?? null
  );
}

export function listWorkspaces(): string[] {
  return (
    withDatabase(
      (db) => {
        const query = db.prepare(`
          SELECT DISTINCT cwd
          FROM threads
          WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
          ORDER BY cwd ASC
        `);

        const rows = query.all() as WorkspaceRow[];
        return rows
          .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
          .filter(Boolean);
      },
      (databasePath) => {
        const rows = queryJsonWithSqliteCli<WorkspaceRow>(
          databasePath,
          `
            SELECT DISTINCT cwd
            FROM threads
            WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
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
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
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
