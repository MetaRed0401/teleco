import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type AppServerMessage = Record<string, unknown>;
export type AppServerNotification = { method: string; params?: unknown };
export type AppServerRequest = { id: string | number; method: string; params?: unknown };

export type AppServerRequestHandler = (
  request: AppServerRequest,
) => Promise<unknown> | unknown;
export type AppServerNotificationHandler = (notification: AppServerNotification) => void;

export interface CodexAppServerClientOptions {
  cwd: string;
  requestHandler?: AppServerRequestHandler;
}

const NOTIFICATION_BUFFER_LIMIT = 200;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: AppServerNotification[] = [];
  private readonly notificationHandlers = new Set<AppServerNotificationHandler>();
  private stderrBuffer = "";
  private closedReason: string | undefined;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  start(): void {
    if (this.child) {
      return;
    }

    const resolvedCodexCli = resolveCodexCliPath();
    this.closedReason = undefined;
    this.stdoutBuffer = "";
    const child = spawn(resolvedCodexCli.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        PATH: resolvedCodexCli.path,
        TERM: process.env.TERM === "dumb" || !process.env.TERM ? "xterm-256color" : process.env.TERM,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = trimTail(this.stderrBuffer + chunk.toString("utf8"), 6000);
    });
    child.on("error", (error) => {
      this.closedReason = formatSpawnFailure(error, resolvedCodexCli, this.options.cwd);
      this.failPending(new Error(this.closedReason));
      if (this.child === child) {
        this.child = null;
      }
    });
    child.on("exit", (code, signal) => {
      this.closedReason ??= `Codex app-server exited (${code ?? signal}).`;
      this.failPending(new Error(this.closedReason));
      if (this.child === child) {
        this.child = null;
      }
    });
  }

  async initialize(): Promise<unknown> {
    this.start();
    const result = await this.request("initialize", {
      clientInfo: {
        name: "telecodex",
        title: "TeleCodex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    if (!this.child) {
      this.start();
    }
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server stdin is not writable."));
    }

    const id = this.nextId++;
    const message = { method, id, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) {
      this.start();
    }
    if (!this.child?.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  getNotifications(): AppServerNotification[] {
    return [...this.notifications];
  }

  onNotification(handler: AppServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  getStderrPreview(): string {
    return this.stderrBuffer;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  isHealthy(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.stdin.writable);
  }

  getClosedReason(): string | undefined {
    return this.closedReason;
  }

  close(): void {
    this.closedReason = "Codex app-server client closed.";
    this.failPending(new Error("Codex app-server client closed."));
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessageLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleMessageLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch (error) {
      this.notifications.push({
        method: "parse/error",
        params: { line, error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.id === "number") {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params };
      this.notifications.push(notification);
      if (this.notifications.length > NOTIFICATION_BUFFER_LIMIT) {
        this.notifications.splice(0, this.notifications.length - NOTIFICATION_BUFFER_LIMIT);
      }
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private handleResponse(message: AppServerMessage): void {
    const id = message.id;
    if (typeof id !== "number") {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (message.error) {
      pending.reject(new Error(`${pending.method}: ${formatUnknown(message.error)}`));
      return;
    }

    pending.resolve(message.result ?? message);
  }

  private async handleServerRequest(request: AppServerRequest): Promise<void> {
    try {
      const result = this.options.requestHandler
        ? await this.options.requestHandler(request)
        : defaultServerRequestResult(request.method);
      this.writeResponse(request.id, { result });
    } catch (error) {
      this.writeResponse(request.id, {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private writeResponse(id: string | number, body: { result?: unknown; error?: unknown }): void {
    if (!this.child?.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
  }
}

function defaultServerRequestResult(method: string): unknown {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/tool/requestUserInput") {
    return { input: null };
  }
  return { decision: "cancel" };
}

function resolveCodexCliPath(): { command: string; path: string; checked: string[] } {
  const pathValue = buildCodexCliPath();
  const checked: string[] = [];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, "codex");
    checked.push(candidate);
    if (isExecutable(candidate)) {
      return { command: resolveRealPath(candidate), path: pathValue, checked };
    }
  }

  return { command: "codex", path: pathValue, checked };
}

function buildCodexCliPath(): string {
  const home = process.env.HOME;
  const candidates = [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    home ? path.join(home, ".local", "bin") : undefined,
    home ? path.join(home, "bin") : undefined,
    home ? path.join(home, ".bun", "bin") : undefined,
    home ? path.join(home, ".npm-global", "bin") : undefined,
  ];

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const candidate of candidates) {
    for (const dir of (candidate ?? "").split(path.delimiter)) {
      if (!dir || seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(path.delimiter);
}

function resolveRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) {
      return false;
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function formatSpawnFailure(
  error: unknown,
  resolved: { command: string; path: string; checked: string[] },
  cwd: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const checked = resolved.checked.slice(0, 20).map((item) => {
    try {
      return `${item} -> ${realpathSync(item)}`;
    } catch {
      return item;
    }
  });

  return [
    `Failed to start Codex app-server: ${message}`,
    `command: ${resolved.command}`,
    `cwd: ${cwd}`,
    `cwd PATH: ${resolved.path}`,
    process.env.HOME ? `HOME: ${process.env.HOME}` : undefined,
    process.env.SHELL ? `SHELL: ${process.env.SHELL}` : undefined,
    checked.length > 0 ? `checked: ${checked.join(", ")}` : undefined,
    "Install Codex CLI in a standard Homebrew/user bin path or set TELECODEX_LAUNCHD_PATH for the LaunchAgent.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatUnknown(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trimTail(value: string, limit: number): string {
  return value.length > limit ? value.slice(-limit) : value;
}
