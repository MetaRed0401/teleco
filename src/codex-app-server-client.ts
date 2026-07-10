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

export type AppServerTransportMode = "persistent-websocket" | "direct-stdio";

const NOTIFICATION_BUFFER_LIMIT = 200;
const APP_SERVER_STDERR_PREVIEW_LIMIT = 6000;
const APP_SERVER_STDERR_REDACTED_VALUE = "[redacted:token]";

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
  private socket: WebSocket | null = null;
  private transportReady: Promise<void> | null = null;
  private transportMode: AppServerTransportMode = "direct-stdio";
  private transportDetail: string | undefined;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  start(): void {
    if (this.child || this.socket) {
      return;
    }

    this.closedReason = undefined;
    this.stdoutBuffer = "";
    if (shouldUsePersistentWebSocket()) {
      this.startPersistentWebSocket();
      return;
    }

    const resolvedCodexCli = resolveCodexCliPath();
    const childEnv = {
      ...process.env,
      PATH: resolvedCodexCli.path,
      TERM: process.env.TERM === "dumb" || !process.env.TERM ? "xterm-256color" : process.env.TERM,
    };
    const launch = resolveAppServerLaunch();
    this.transportMode = launch.mode;
    this.transportDetail = launch.detail;
    const child = spawn(resolvedCodexCli.command, launch.args, {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.transportReady = Promise.resolve();

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = trimTail(
        redactPotentialSecrets(this.stderrBuffer + chunk.toString("utf8")),
        APP_SERVER_STDERR_PREVIEW_LIMIT,
      );
    });
    child.on("error", (error) => {
      this.closedReason = formatSpawnFailure(error, resolvedCodexCli, this.options.cwd);
      this.failPending(new Error(this.closedReason));
      if (this.child === child) {
        this.child = null;
        this.transportReady = null;
      }
    });
    child.on("exit", (code, signal) => {
      this.closedReason ??= `Codex app-server exited (${code ?? signal}).`;
      this.failPending(new Error(this.closedReason));
      if (this.child === child) {
        this.child = null;
        this.transportReady = null;
      }
    });
  }

  private startPersistentWebSocket(): void {
    const url = resolvePersistentWebSocketUrl();
    this.transportMode = "persistent-websocket";
    this.transportDetail = `Codex turns are owned by the persistent app-server at ${url}.`;

    this.transportReady = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      let connected = false;

      const connect = () => {
        const socket = new WebSocket(url);
        this.socket = socket;
        let attemptFinished = false;
        let opened = false;
        const attemptTimer = setTimeout(() => {
          failAttempt();
          socket.close();
        }, Math.min(1_000, Math.max(1, deadline - Date.now())));

        const failAttempt = () => {
          if (attemptFinished || connected) {
            return;
          }
          attemptFinished = true;
          clearTimeout(attemptTimer);
          if (this.socket === socket) {
            this.socket = null;
          }
          if (Date.now() >= deadline) {
            const error = new Error(`Timed out connecting to persistent Codex app-server at ${url}.`);
            this.closedReason = error.message;
            this.transportReady = null;
            reject(error);
            return;
          }
          setTimeout(connect, 200);
        };

        socket.addEventListener("open", () => {
          if (attemptFinished || connected) {
            socket.close();
            return;
          }
          attemptFinished = true;
          opened = true;
          connected = true;
          clearTimeout(attemptTimer);
          this.closedReason = undefined;
          resolve();
        }, { once: true });

        socket.addEventListener("error", failAttempt, { once: true });
        socket.addEventListener("message", (event) => {
          if (opened) {
            this.handleWebSocketMessage(event.data);
          }
        });
        socket.addEventListener("close", (event) => {
          if (!opened) {
            failAttempt();
            return;
          }
          this.closedReason = `Persistent Codex app-server connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""}).`;
          this.failPending(new Error(this.closedReason));
          if (this.socket === socket) {
            this.socket = null;
            this.transportReady = null;
          }
        });
      };

      connect();
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
        mcpServerOpenaiFormElicitation: false,
      },
    });
    this.notify("initialized", {});
    return result;
  }

  async request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    this.start();
    await this.waitForTransport();
    const id = this.nextId++;
    const message = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.sendMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.start();
    void this.waitForTransport()
      .then(() => this.sendMessage({ method, params }))
      .catch((error) => {
        this.closedReason = error instanceof Error ? error.message : String(error);
      });
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
    return this.child !== null || this.socket !== null;
  }

  isHealthy(): boolean {
    return Boolean(
      (this.child && !this.child.killed && this.child.stdin.writable)
      || this.socket?.readyState === WebSocket.OPEN,
    );
  }

  getClosedReason(): string | undefined {
    return this.closedReason;
  }

  getTransportMode(): AppServerTransportMode {
    return this.transportMode;
  }

  getTransportDetail(): string | undefined {
    return this.transportDetail;
  }

  close(): void {
    this.closedReason = "Codex app-server client closed.";
    this.failPending(new Error("Codex app-server client closed."));
    this.socket?.close(1000, "TeleCodex client closed");
    this.socket = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.transportReady = null;
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

  private handleWebSocketMessage(data: unknown): void {
    if (typeof data === "string") {
      this.handleMessageLine(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handleMessageLine(Buffer.from(data).toString("utf8"));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.handleMessageLine(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
      return;
    }
    const text = (data as { text?: () => Promise<string> } | null)?.text;
    if (typeof text === "function") {
      void text.call(data).then((value) => this.handleMessageLine(value));
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
    try {
      this.sendMessage({ id, ...body });
    } catch (error) {
      this.closedReason = error instanceof Error ? error.message : String(error);
    }
  }

  private async waitForTransport(): Promise<void> {
    if (!this.transportReady) {
      throw new Error("Codex app-server transport is not available.");
    }
    await this.transportReady;
  }

  private sendMessage(message: unknown): void {
    const payload = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
      return;
    }
    if (this.child?.stdin.writable) {
      this.child.stdin.write(`${payload}\n`);
      return;
    }
    throw new Error("Codex app-server transport is not writable.");
  }
}

function resolveAppServerLaunch(): { args: string[]; mode: AppServerTransportMode; detail: string } {
  return {
    args: ["app-server", "--listen", "stdio://"],
    mode: "direct-stdio",
    detail: "This platform currently uses a bridge-owned direct stdio app-server.",
  };
}

function shouldUsePersistentWebSocket(): boolean {
  return process.platform === "linux";
}

function resolvePersistentWebSocketUrl(): string {
  return "ws://127.0.0.1:45123";
}

function defaultServerRequestResult(method: string): unknown {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "cancel", content: null, _meta: null };
  }
  if (method === "item/tool/call") {
    return { contentItems: [], success: false };
  }
  if (method === "currentTime/read") {
    return { currentTimeAt: Math.floor(Date.now() / 1000) };
  }
  throw new Error(`Unsupported app-server request: ${method}`);
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

function redactPotentialSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, APP_SERVER_STDERR_REDACTED_VALUE)
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, APP_SERVER_STDERR_REDACTED_VALUE)
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer)\b\s*(?::\s*|\=\s*|\s+))(["']?)([^"'\s]+)\2/gi,
      `$1$2${APP_SERVER_STDERR_REDACTED_VALUE}$2`,
    );
}
