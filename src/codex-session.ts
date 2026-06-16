import {
  Codex,
  type ApprovalMode,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type UserInput,
} from "@openai/codex-sdk";

import type { TeleCodexConfig } from "./config.js";
import {
  getThread,
  listModels,
  listThreads,
  listWorkspaces,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
  type CodexSafetyPolicy,
} from "./codex-launch.js";
import {
  CodexAppServerClient,
  type AppServerNotification,
  type AppServerRequest,
} from "./codex-app-server-client.js";

export interface CodexApprovalRequest {
  method: string;
  params?: unknown;
}

export type CodexApprovalResponse = { decision: "accept" | "acceptForSession" | "decline" | "cancel" };

export interface CodexSessionCallbacks {
  onTextDelta: (delta: string, metadata?: { agentMessageId: string; startsNewMessage: boolean }) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalResponse>;
  onContextCompaction?: () => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
}

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  fastMode: boolean;
  fastOnce: boolean;
  serviceTier?: string;
  launchProfileId: string;
  launchProfileLabel: string;
  launchProfileBehavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionTokens?: {
    input: number;
    cached: number;
    output: number;
  };
  lastTurnTokens?: {
    input: number;
    cached: number;
    output: number;
  };
  contextWindow?: {
    model: string;
    limit: number;
    effectiveLimit: number;
    used?: number;
    remaining?: number;
    percentUsed?: number;
  };
}

export interface CodexCompactResult {
  threadId: string;
  turnId?: string;
  elapsedMs: number;
}

export interface CodexRuntimeStatus {
  backend: "app-server" | "sdk-fallback";
  appServerEnabled: boolean;
  appServerRunning: boolean;
  appServerInitialized: boolean;
  currentTurnId: string | null;
  recentNotificationCount: number;
  recentProblem?: string;
}

export interface CodexStatusDetails {
  account?: {
    type: string;
    email?: string;
    planType?: string;
    requiresOpenaiAuth?: boolean;
  };
  accountUsage?: {
    lifetimeTokens?: number;
    currentStreakDays?: number;
    longestStreakDays?: number;
    peakDailyTokens?: number;
    longestRunningTurnSec?: number;
  };
  rateLimits: Array<{
    limitId?: string;
    limitName?: string;
    planType?: string;
    primary?: CodexRateLimitWindow;
    secondary?: CodexRateLimitWindow;
  }>;
  thread?: {
    sessionId?: string;
    status?: string;
    cliVersion?: string;
    source?: string;
    modelProvider?: string;
    serviceTier?: string;
    instructionSources: string[];
    activePermissionProfile?: string;
    approvalsReviewer?: string;
    collaborationMode?: string;
  };
  config?: {
    model?: string;
    modelContextWindow?: number;
    autoCompactTokenLimit?: number;
  };
  error?: string;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  leftPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CreateOptions {
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  launchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
}

export type CodexPromptInput = string | { text?: string; imagePaths?: string[]; stagedFileInstructions?: string };

export class CodexSessionService {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private currentWorkspace: string;
  private abortController: AbortController | null = null;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoningEffort: string | undefined;
  private currentFastMode = false;
  private fastOnce = false;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private sessionTokens = { input: 0, cached: 0, output: 0 };
  private lastTurnTokens: { input: number; cached: number; output: number } | undefined;
  private contextTokensUsed: number | undefined;
  private appServerModelContextWindow: number | undefined;
  private appServerClient: CodexAppServerClient | null = null;
  private appServerInitialized = false;
  private appServerThreadLoaded = false;
  private appServerCurrentTurnId: string | null = null;
  private appServerCallbacks: CodexSessionCallbacks | undefined;
  private readonly appServerStartedToolIds = new Set<string>();
  private appServerInstructionSources: string[] = [];
  private appServerActivePermissionProfile: string | undefined;
  private appServerApprovalsReviewer: string | undefined;
  private appServerModelProvider: string | undefined;
  private appServerServiceTier: string | undefined;

  private constructor(private readonly config: TeleCodexConfig) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: TeleCodexConfig, options?: CreateOptions): Promise<CodexSessionService> {
    const service = new CodexSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.codexModel;
    service.currentReasoningEffort = options?.reasoningEffort as ModelReasoningEffort | undefined;
    service.currentFastMode = options?.fastMode ?? false;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );
    service.resetCodexClient();

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(): CodexSessionInfo {
    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const info: CodexSessionInfo = {
      threadId: this.thread?.id ?? this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      fastMode: this.currentFastMode,
      fastOnce: this.fastOnce,
      serviceTier: this.getRequestedServiceTier() ?? this.appServerServiceTier,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode: effectiveLaunchProfile.sandboxMode,
      approvalPolicy: effectiveLaunchProfile.approvalPolicy,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
    };

    if (this.currentReasoningEffort) {
      info.reasoningEffort = this.currentReasoningEffort;
    }

    if (
      this.activeThreadLaunchProfile &&
      this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id
    ) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }

    if (this.sessionTokens.input > 0 || this.sessionTokens.cached > 0 || this.sessionTokens.output > 0) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    if (this.lastTurnTokens) {
      info.lastTurnTokens = { ...this.lastTurnTokens };
    }

    const contextWindow = this.getContextWindowInfo(info.model);
    if (contextWindow) {
      info.contextWindow = contextWindow;
    }

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null;
  }

  hasActiveThread(): boolean {
    return this.thread !== null || (this.config.enableCodexAppServerRuntime && this.currentThreadId !== null);
  }

  getRuntimeStatus(): CodexRuntimeStatus {
    const notifications = this.appServerClient?.getNotifications() ?? [];
    const recentProblem = [...notifications]
      .reverse()
      .find((notification) => notification.method === "error" || notification.method === "warning");
    const closedReason = this.appServerClient?.getClosedReason();
    return {
      backend: this.config.enableCodexAppServerRuntime ? "app-server" : "sdk-fallback",
      appServerEnabled: this.config.enableCodexAppServerRuntime,
      appServerRunning: this.appServerClient?.isRunning() ?? false,
      appServerInitialized: this.appServerInitialized,
      currentTurnId: this.appServerCurrentTurnId,
      recentNotificationCount: notifications.length,
      recentProblem: closedReason ?? (recentProblem ? summarizeAppServerProblem(recentProblem) : undefined),
    };
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async getStatusDetails(): Promise<CodexStatusDetails> {
    if (!this.config.enableCodexAppServerRuntime) {
      return { rateLimits: [] };
    }

    try {
      await this.ensureAppServerInitialized();
      const client = this.getAppServerClient();
      const [accountResponse, usageResponse, rateLimitResponse, configResponse, threadResponse] = await Promise.all([
        client.request("account/read", { refreshToken: false }, 5000).catch((error) => ({ error })),
        client.request("account/usage/read", undefined, 5000).catch((error) => ({ error })),
        client.request("account/rateLimits/read", undefined, 5000).catch((error) => ({ error })),
        client.request("config/read", {}, 5000).catch((error) => ({ error })),
        this.currentThreadId
          ? client.request("thread/read", { threadId: this.currentThreadId, includeTurns: false }, 5000).catch((error) => ({ error }))
          : Promise.resolve(undefined),
      ]);

      const details: CodexStatusDetails = {
        account: parseAccountStatus(accountResponse),
        accountUsage: parseAccountUsageStatus(usageResponse),
        rateLimits: parseRateLimitStatus(rateLimitResponse),
      };
      details.config = parseConfigStatus(configResponse);
      if (details.config?.model && !this.currentModel) {
        this.currentModel = details.config.model;
      }
      if (details.config?.modelContextWindow) {
        this.appServerModelContextWindow = details.config.modelContextWindow;
      }
      const thread = parseThreadStatus(threadResponse);
      if (thread) {
        details.thread = {
          ...thread,
          modelProvider: this.appServerModelProvider,
          serviceTier: this.appServerServiceTier,
          instructionSources: this.appServerInstructionSources,
          activePermissionProfile: this.appServerActivePermissionProfile,
          approvalsReviewer: this.appServerApprovalsReviewer,
        };
      }
      return details;
    } catch (error) {
      return {
        rateLimits: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (this.config.enableCodexAppServerRuntime) {
      await this.promptViaAppServer(input, callbacks);
      return;
    }

    if (!this.thread) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    let hasEmittedAgentText = false;
    const lastAgentTextByItemId = new Map<string, string>();

    // Track cumulative aggregated_output per command item to compute deltas.
    const lastCommandOutput = new Map<string, string>();

    const emitAgentTextDelta = (item: Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }>["item"]): void => {
      if (item.type !== "agent_message") {
        return;
      }

      const previousText = lastAgentTextByItemId.get(item.id);
      const delta = previousText === undefined ? item.text : computeTextDelta(previousText, item.text);
      lastAgentTextByItemId.set(item.id, item.text);

      if (!delta) {
        return;
      }

      const startsNewMessage = previousText === undefined && hasEmittedAgentText;
      const prefix = startsNewMessage ? "\n\n" : "";
      callbacks.onTextDelta(`${prefix}${delta}`, {
        agentMessageId: item.id,
        startsNewMessage,
      });
      hasEmittedAgentText = true;
    };

    try {
      const { events } = await this.thread.runStreamed(this.buildSdkInput(input), { signal: controller.signal });

      for await (const event of events) {
        this.handleThreadEvent(event);

        switch (event.type) {
          case "item.started":
          case "item.updated": {
            const item = event.item;
            if (item.type === "agent_message") {
              emitAgentTextDelta(item);
            } else if (item.type === "command_execution") {
              if (event.type === "item.started") {
                // Record baseline so the first item.updated delta is computed correctly.
                lastCommandOutput.set(item.id, item.aggregated_output);
                callbacks.onToolStart(item.command, item.id);
              } else {
                // aggregated_output grows monotonically; pass only the new portion.
                const prev = lastCommandOutput.get(item.id) ?? "";
                const delta = computeTextDelta(prev, item.aggregated_output);
                lastCommandOutput.set(item.id, item.aggregated_output);
                if (delta) {
                  callbacks.onToolUpdate(item.id, delta);
                }
              }
            } else if (item.type === "web_search") {
              if (event.type === "item.started") {
                const label = truncate(item.query, 60);
                callbacks.onToolStart(`🔍 ${label}`, item.id);
                callbacks.onToolUpdate(item.id, item.query);
              }
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              emitAgentTextDelta(item);
            } else if (item.type === "command_execution") {
              // Pass any output that arrived only in the completion event (e.g. fast
              // commands that never fired item.updated).
              const prev = lastCommandOutput.get(item.id) ?? "";
              const delta = computeTextDelta(prev, item.aggregated_output);
              if (delta) {
                callbacks.onToolUpdate(item.id, delta);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "file_change") {
              const toolId = item.id;
              const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              callbacks.onToolEnd(toolId, item.status === "failed");
            } else if (item.type === "mcp_tool_call") {
              callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
              if (item.error) {
                callbacks.onToolUpdate(item.id, item.error.message);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "web_search") {
              callbacks.onToolEnd(item.id, false);
            } else if (item.type === "error") {
              callbacks.onToolStart("⚠️ error", item.id);
              callbacks.onToolUpdate(item.id, item.message);
              callbacks.onToolEnd(item.id, true);
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "turn.completed": {
            // Accumulate and deliver usage BEFORE onAgentEnd so that
            // finalizeResponse() can read lastTurnUsage when building the
            // final message text.
            const u = event.usage;
            this.sessionTokens.input += u.input_tokens;
            this.sessionTokens.cached += u.cached_input_tokens;
            this.sessionTokens.output += u.output_tokens;
            this.lastTurnTokens = {
              input: u.input_tokens,
              cached: u.cached_input_tokens,
              output: u.output_tokens,
            };
            callbacks.onTurnComplete?.({
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              outputTokens: u.output_tokens,
            });
            callbacks.onAgentEnd();
            break;
          }
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  canSteer(): boolean {
    return Boolean(
      this.config.enableCodexAppServerRuntime &&
        this.currentThreadId &&
        this.appServerCurrentTurnId &&
        this.abortController,
    );
  }

  async steer(input: CodexPromptInput): Promise<void> {
    if (!this.config.enableCodexAppServerRuntime) {
      throw new Error("Active-turn steering requires Codex app-server runtime.");
    }

    const threadId = this.currentThreadId;
    if (!threadId) {
      throw new Error("No active Codex thread to steer.");
    }

    const turnId = this.appServerCurrentTurnId;
    if (!turnId || !this.abortController) {
      throw new Error("No active Codex turn to steer. Use /queue to run guidance after the current turn.");
    }

    const response = await this.getAppServerClient().request(
      "turn/steer",
      {
        threadId,
        clientUserMessageId: `telecodex-steer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        input: this.buildAppServerInput(input),
        expectedTurnId: turnId,
      },
      10000,
    );
    const steeredTurnId = readString(readRecord(response)?.turnId);
    if (steeredTurnId) {
      this.appServerCurrentTurnId = steeredTurnId;
    }
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
    if (this.config.enableCodexAppServerRuntime && this.currentThreadId && this.appServerCurrentTurnId) {
      await this.getAppServerClient().request("turn/interrupt", {
        threadId: this.currentThreadId,
        turnId: this.appServerCurrentTurnId,
      }).catch(() => undefined);
    }
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    if (this.config.enableCodexAppServerRuntime) {
      await this.ensureAppServerInitialized();
      const effectiveWorkspace = workspace ?? this.currentWorkspace;
      const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
      const response = await this.requestAppServerThreadStart({
        model: effectiveModel ?? null,
        cwd: effectiveWorkspace,
        runtimeWorkspaceRoots: [effectiveWorkspace],
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
        serviceName: "telecodex",
        config: this.buildAppServerConfig(),
      });
      const threadId = readString(readRecord(readRecord(response)?.thread)?.id);
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      this.captureAppServerThreadResumeState(response);
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentWorkspace = effectiveWorkspace;
      this.currentThreadId = threadId;
      this.appServerThreadLoaded = true;
      this.resetUsageState();
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    this.thread = this.getCodex().startThread(this.buildThreadOptions(effectiveWorkspace, effectiveModel));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = this.thread.id ?? null;
    this.resetUsageState();
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || this.currentModel;

    if (this.config.enableCodexAppServerRuntime) {
      this.resetAppServerClient();
      await this.ensureAppServerInitialized();
      const response = await this.requestAppServerThreadResume({
        threadId,
        cwd: workspace,
        model: model ?? this.config.codexModel ?? null,
        runtimeWorkspaceRoots: [workspace],
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
        excludeTurns: true,
        config: this.buildAppServerConfig(),
      });
      this.captureAppServerThreadResumeState(response);
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentWorkspace = workspace;
      this.currentThreadId = threadId;
      this.appServerThreadLoaded = true;
      this.lastTurnTokens = undefined;
      this.contextTokensUsed = undefined;
      this.appServerModelContextWindow = undefined;
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    this.thread = null;
    this.resetCodexClient();
    this.thread = this.getCodex().resumeThread(
      threadId,
      this.buildThreadOptions(workspace, model),
    );
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    this.lastTurnTokens = undefined;
    this.contextTokensUsed = undefined;
    this.appServerModelContextWindow = undefined;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || undefined;

    if (this.config.enableCodexAppServerRuntime) {
      await this.ensureAppServerInitialized();
      const response = await this.requestAppServerThreadResume({
        threadId,
        cwd: workspace,
        model: model ?? this.currentModel ?? this.config.codexModel ?? null,
        runtimeWorkspaceRoots: [workspace],
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
        excludeTurns: true,
        config: this.buildAppServerConfig(),
      });
      this.captureAppServerThreadResumeState(response);
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentWorkspace = workspace;
      this.currentThreadId = threadId;
      this.appServerThreadLoaded = true;
      this.resetUsageState();
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    this.resetUsageState();
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async compactCurrentThread(options: { signal?: AbortSignal } = {}): Promise<CodexCompactResult> {
    this.ensureIdle("compact a thread");
    if (!this.currentThreadId) {
      throw new Error("No active Codex thread to compact.");
    }
    if (!this.config.enableCodexAppServerRuntime) {
      throw new Error("App-server runtime is required for native compact.");
    }
    if (options.signal?.aborted) {
      throw new Error("Native compact was aborted.");
    }

    const threadId = this.currentThreadId;
    const startedAt = Date.now();
    await this.ensureAppServerThreadReady();
    const client = this.getAppServerClient();

    const controller = new AbortController();
    this.abortController = controller;

    let turnId: string | undefined;
    let finish: (result: { turnId?: string }) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const completed = new Promise<{ turnId?: string }>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const timeout = setTimeout(() => {
      fail(new Error("Timed out waiting for native context compaction completion."));
    }, 20 * 60 * 1000);

    const abort = (): void => {
      controller.abort();
    };
    const interrupt = (): void => {
      const activeTurnId = turnId ?? this.appServerCurrentTurnId;
      if (!activeTurnId) {
        fail(new Error("Native compact was aborted."));
        return;
      }
      client
        .request("turn/interrupt", { threadId, turnId: activeTurnId }, 5000)
        .catch(() => undefined);
      fail(new Error("Native compact was aborted."));
    };
    const unsubscribe = client.onNotification((notification) => {
      const params = readRecord(notification.params);
      const notificationThreadId = readString(params?.threadId);
      if (notificationThreadId && notificationThreadId !== threadId) {
        return;
      }

      if (notification.method === "turn/started") {
        turnId = readString(readRecord(params?.turn)?.id) ?? readString(params?.turnId);
        this.appServerCurrentTurnId = turnId ?? this.appServerCurrentTurnId;
        return;
      }

      if (notification.method === "item/completed") {
        const item = readRecord(params?.item);
        if (readString(item?.type) === "contextCompaction") {
          finish({
            turnId: turnId ?? readString(params?.turnId),
          });
        }
        return;
      }

      if (notification.method === "thread/compacted") {
        finish({
          turnId: readString(params?.turnId) ?? turnId,
        });
        return;
      }

      if (notification.method === "error") {
        const message =
          readString(readRecord(params?.error)?.message) ??
          readString(params?.message) ??
          "Codex app-server compact failed.";
        fail(new Error(message));
      }
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", interrupt, { once: true });

    try {
      await client.request("thread/compact/start", { threadId });
      const result = await completed;
      this.lastTurnTokens = undefined;
      this.contextTokensUsed = undefined;
      return {
        threadId,
        turnId: result.turnId,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new Error("Native compact was aborted.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", interrupt);
      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.appServerCurrentTurnId === turnId) {
        this.appServerCurrentTurnId = null;
      }
    }
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    return listThreads(limit ?? 20);
  }

  listWorkspaces(): string[] {
    return listWorkspaces();
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  async listReasoningEfforts(): Promise<string[]> {
    if (!this.config.enableCodexAppServerRuntime) {
      return [];
    }

    try {
      await this.ensureAppServerInitialized();
      const response = await this.getAppServerClient().request("model/list", { includeHidden: false }, 5000);
      return parseReasoningEfforts(response, this.currentModel ?? this.config.codexModel);
    } catch {
      return [];
    }
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setReasoningEffort(effort: string | undefined): void {
    this.currentReasoningEffort = effort;
  }

  setFastMode(enabled: boolean): void {
    this.currentFastMode = enabled;
    this.fastOnce = false;
  }

  async setFastModeAndReattach(enabled: boolean): Promise<CodexSessionInfo> {
    this.ensureIdle("change fast mode");
    this.setFastMode(enabled);

    const threadId = this.currentThreadId ?? this.thread?.id ?? null;
    if (!threadId || !this.config.enableCodexAppServerRuntime) {
      return this.getInfo();
    }

    return this.resumeThread(threadId);
  }

  setFastOnce(): void {
    this.fastOnce = true;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    this.resetCodexClient();
    return this.currentLaunchProfile;
  }

  async setLaunchProfileAndReattach(profileId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("change launch profile");
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);

    const threadId = this.currentThreadId ?? this.thread?.id ?? null;
    if (!threadId) {
      this.resetCodexClient();
      return this.getInfo();
    }

    return this.resumeThread(threadId);
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.resetAppServerClient();
  }

  async reconnectAppServer(callbacks?: CodexSessionCallbacks): Promise<CodexSessionInfo> {
    this.ensureIdle("reconnect app-server");
    if (!this.config.enableCodexAppServerRuntime) {
      throw new Error("App-server runtime is disabled.");
    }

    this.resetAppServerClient();
    await this.ensureAppServerThreadReady(callbacks);
    return this.getInfo();
  }

  private buildSdkInput(input: CodexPromptInput): Input {
    const safetyInstructions = buildSafetyInstructions(this.activeThreadLaunchProfile ?? this.currentLaunchProfile);
    if (typeof input === "string") {
      return safetyInstructions ? `${safetyInstructions}\n\n${input}` : input;
    }

    const parts: UserInput[] = [];
    const textParts: string[] = [];

    if (safetyInstructions) {
      textParts.push(safetyInstructions);
    }
    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "local_image", path: imagePath });
    }

    if (parts.length === 0) {
      return "";
    }
    if (parts.length === 1 && parts[0]?.type === "text") {
      return parts[0].text;
    }
    return parts;
  }

  private buildThreadOptions(workspace: string, model?: string): {
    model?: string;
    sandboxMode: SandboxMode;
    workingDirectory: string;
    approvalPolicy: ApprovalMode;
    skipGitRepoCheck: true;
    modelReasoningEffort?: ModelReasoningEffort;
  } {
    const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
    const options = {
      model: effectiveModel,
      sandboxMode: this.currentLaunchProfile.sandboxMode,
      workingDirectory: workspace,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      skipGitRepoCheck: true as const,
    };

    if (this.currentReasoningEffort) {
      return {
        ...options,
        modelReasoningEffort: this.currentReasoningEffort as ModelReasoningEffort,
      };
    }

    return options;
  }

  private ensureIdle(action: string): void {
    if (this.abortController) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private handleThreadEvent(event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.currentThreadId = event.thread_id;
    }
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.resetCodexClient();
    }

    return this.codex!;
  }

  private resetCodexClient(): void {
    this.codex = new Codex({
      apiKey: this.config.codexApiKey,
      config: {
        approval_policy: this.currentLaunchProfile.approvalPolicy,
      },
      env: buildCodexEnv(this.config.codexApiKey),
    });
  }

  private resetAppServerClient(): void {
    this.appServerClient?.close();
    this.appServerClient = null;
    this.appServerInitialized = false;
    this.appServerThreadLoaded = false;
    this.appServerCurrentTurnId = null;
    this.appServerCallbacks = undefined;
  }

  private resetUsageState(): void {
    this.sessionTokens = { input: 0, cached: 0, output: 0 };
    this.lastTurnTokens = undefined;
    this.contextTokensUsed = undefined;
    this.appServerModelContextWindow = undefined;
  }

  private buildAppServerConfig(serviceTier = this.getRequestedServiceTier(false)): Record<string, unknown> | undefined {
    const config: Record<string, unknown> = {};
    if (this.currentReasoningEffort) {
      config.model_reasoning_effort = this.currentReasoningEffort;
    }
    if (serviceTier) {
      config.service_tier = serviceTier;
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  private getRequestedServiceTier(includeFastOnce = true): string | undefined {
    if (this.currentFastMode || (includeFastOnce && this.fastOnce)) {
      return "fast";
    }
    return undefined;
  }

  private consumeTurnServiceTier(): string | undefined {
    const serviceTier = this.getRequestedServiceTier();
    if (this.fastOnce && !this.currentFastMode) {
      this.fastOnce = false;
    }
    return serviceTier;
  }

  private captureAppServerThreadResumeState(response: unknown): void {
    const record = readRecord(response);
    this.appServerInstructionSources = readStringArray(record?.instructionSources);
    this.appServerActivePermissionProfile = summarizeUnknownValue(record?.activePermissionProfile);
    this.appServerApprovalsReviewer = summarizeUnknownValue(record?.approvalsReviewer);
    this.appServerModelProvider = readString(record?.modelProvider);
    this.appServerServiceTier = readString(record?.serviceTier);
    this.currentModel = readString(record?.model) ?? this.currentModel;
  }

  private async promptViaAppServer(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("Codex app-server thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    await this.ensureAppServerThreadReady(callbacks);

    const controller = new AbortController();
    this.abortController = controller;
    let client = this.getAppServerClient(callbacks);
    this.appServerStartedToolIds.clear();
    let unsubscribe = client.onNotification((notification) => {
      this.handleAppServerNotification(notification, callbacks);
    });

    try {
      const turnServiceTier = this.consumeTurnServiceTier();
      const turnStartParams = {
        threadId: this.currentThreadId,
        input: this.buildAppServerInput(input),
        cwd: this.currentWorkspace,
        runtimeWorkspaceRoots: [this.currentWorkspace],
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandboxPolicy: this.buildAppServerSandboxPolicy(),
        model: this.currentModel ?? this.config.codexModel ?? null,
        effort: this.currentReasoningEffort ?? null,
        serviceTier: turnServiceTier ?? null,
        config: this.buildAppServerConfig(turnServiceTier),
        summary: "auto",
      };
      let response: unknown;
      try {
        response = await this.requestAppServerTurnStart(client, turnStartParams);
      } catch (error) {
        if (!isRecoverableAppServerError(error) || client.isHealthy()) {
          throw error;
        }

        this.resetAppServerClient();
        await this.ensureAppServerThreadReady(callbacks);
        unsubscribe();
        client = this.getAppServerClient(callbacks);
        unsubscribe = client.onNotification((notification) => {
          this.handleAppServerNotification(notification, callbacks);
        });
        response = await this.requestAppServerTurnStart(client, turnStartParams);
      }
      this.appServerCurrentTurnId = readString(readRecord(readRecord(response)?.turn)?.id) ?? null;

      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new Error("Codex turn was aborted."));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        const done = client.onNotification((notification) => {
          const params = readRecord(notification.params);
          if (notification.method === "error") {
            controller.signal.removeEventListener("abort", onAbort);
            done();
            reject(
              new Error(
                readString(readRecord(params?.error)?.message) ??
                  readString(params?.message) ??
                  "Codex app-server turn failed.",
              ),
            );
            return;
          }

          if (notification.method !== "turn/completed") {
            return;
          }

          if (readString(params?.threadId) !== this.currentThreadId) {
            return;
          }

          const turn = readRecord(params?.turn);
          const status = readString(turn?.status);
          controller.signal.removeEventListener("abort", onAbort);
          done();
          if (status === "failed") {
            reject(new Error(readString(readRecord(turn?.error)?.message) ?? "Codex app-server turn failed."));
            return;
          }
          resolve();
        });
      });
    } catch (error) {
      if (isRecoverableAppServerError(error)) {
        this.resetAppServerClient();
      }
      throw error;
    } finally {
      unsubscribe();
      this.appServerCurrentTurnId = null;
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private getAppServerClient(callbacks?: CodexSessionCallbacks): CodexAppServerClient {
    if (!this.appServerClient) {
      this.appServerClient = new CodexAppServerClient({
        cwd: this.currentWorkspace,
        requestHandler: async (request) => this.handleAppServerRequest(request, this.appServerCallbacks),
      });
    }
    if (callbacks) {
      this.appServerCallbacks = callbacks;
    }
    return this.appServerClient;
  }

  private async ensureAppServerInitialized(callbacks?: CodexSessionCallbacks): Promise<void> {
    if (this.appServerInitialized && this.appServerClient?.isHealthy()) {
      return;
    }
    if (this.appServerInitialized || (this.appServerClient && !this.appServerClient.isHealthy())) {
      this.resetAppServerClient();
    }
    await this.getAppServerClient(callbacks).initialize();
    this.appServerInitialized = true;
  }

  private async ensureAppServerThreadReady(callbacks?: CodexSessionCallbacks): Promise<void> {
    await this.ensureAppServerInitialized(callbacks);
    if (!this.currentThreadId || this.appServerThreadLoaded) {
      return;
    }

    const response = await this.requestAppServerThreadResume({
      threadId: this.currentThreadId,
      cwd: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel ?? null,
      runtimeWorkspaceRoots: [this.currentWorkspace],
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      sandbox: this.currentLaunchProfile.sandboxMode,
      excludeTurns: true,
      config: this.buildAppServerConfig(),
    });
    this.captureAppServerThreadResumeState(response);
    this.thread = null;
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.appServerThreadLoaded = true;
  }

  private async requestAppServerThreadStart(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.getAppServerClient().request("thread/start", params);
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in params)) {
        throw error;
      }
      const retryParams = { ...params };
      delete retryParams.runtimeWorkspaceRoots;
      return this.getAppServerClient().request("thread/start", retryParams);
    }
  }

  private async requestAppServerThreadResume(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.getAppServerClient().request("thread/resume", params);
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in params)) {
        throw error;
      }
      const retryParams = { ...params };
      delete retryParams.runtimeWorkspaceRoots;
      return this.getAppServerClient().request("thread/resume", retryParams);
    }
  }

  private async requestAppServerTurnStart(client: CodexAppServerClient, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await client.request("turn/start", params);
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in params)) {
        throw error;
      }
      const retryParams = { ...params };
      delete retryParams.runtimeWorkspaceRoots;
      return client.request("turn/start", retryParams);
    }
  }

  private async handleAppServerRequest(
    request: AppServerRequest,
    callbacks?: CodexSessionCallbacks,
  ): Promise<unknown> {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval"
    ) {
      console.log(`App-server approval request: ${request.method}`);
      const response = await callbacks?.onApprovalRequest?.({
        method: request.method,
        params: request.params,
      });
      return response ?? { decision: "decline" };
    }

    return { decision: "cancel" };
  }

  private handleAppServerNotification(
    notification: AppServerNotification,
    callbacks: CodexSessionCallbacks,
  ): void {
    const params = readRecord(notification.params);
    switch (notification.method) {
      case "thread/started": {
        const threadId = readString(readRecord(params?.thread)?.id);
        if (threadId) {
          this.currentThreadId = threadId;
          this.appServerThreadLoaded = true;
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = readString(params?.delta);
        const itemId = readString(params?.itemId) ?? "agent-message";
        if (delta) {
          callbacks.onTextDelta(delta, { agentMessageId: itemId, startsNewMessage: false });
        }
        break;
      }
      case "item/started": {
        const item = readRecord(params?.item);
        const id = readString(item?.id) ?? randomItemId();
        const type = readString(item?.type);
        if (type === "commandExecution") {
          this.emitAppServerToolStart(callbacks, readString(item?.command) ?? "shell", id);
        } else if (type === "mcpToolCall") {
          this.emitAppServerToolStart(callbacks, `mcp:${readString(item?.server) ?? "unknown"}/${readString(item?.tool) ?? "tool"}`, id);
        } else if (type === "dynamicToolCall") {
          this.emitAppServerToolStart(callbacks, `dynamic:${readString(item?.namespace) ?? "tool"}/${readString(item?.tool) ?? "call"}`, id);
        } else if (type === "fileChange") {
          this.emitAppServerToolStart(callbacks, "file_change", id);
        } else if (type === "contextCompaction") {
          callbacks.onContextCompaction?.();
          this.emitAppServerToolStart(callbacks, "context_compaction", id);
        }
        break;
      }
      case "item/plan/delta": {
        const delta = readString(params?.delta);
        const itemId = readString(params?.itemId) ?? "plan";
        if (delta) {
          callbacks.onTextDelta(delta, { agentMessageId: itemId, startsNewMessage: false });
        }
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const delta = readString(params?.delta);
        const itemId = readString(params?.itemId) ?? "reasoning";
        if (delta) {
          this.emitAppServerToolStart(callbacks, "reasoning", itemId);
          callbacks.onToolUpdate(itemId, delta);
        }
        break;
      }
      case "item/commandExecution/outputDelta": {
        const itemId = readString(params?.itemId);
        const delta = readString(params?.delta);
        if (itemId && delta) {
          callbacks.onToolUpdate(itemId, delta);
        }
        break;
      }
      case "item/fileChange/outputDelta": {
        const itemId = readString(params?.itemId);
        const delta = readString(params?.delta);
        if (itemId && delta) {
          callbacks.onToolUpdate(itemId, delta);
        }
        break;
      }
      case "item/completed": {
        const item = readRecord(params?.item);
        const id = readString(item?.id) ?? randomItemId();
        const type = readString(item?.type);
        if (type === "commandExecution") {
          const output = readString(item?.aggregatedOutput);
          if (output) {
            callbacks.onToolUpdate(id, output);
          }
          callbacks.onToolEnd(id, readString(item?.status) === "failed");
        } else if (type === "fileChange") {
          callbacks.onToolEnd(id, readString(item?.status) === "failed");
        } else if (type === "mcpToolCall") {
          const error = readRecord(item?.error);
          if (error) {
            callbacks.onToolUpdate(id, readString(error?.message) ?? JSON.stringify(error));
          }
          callbacks.onToolEnd(id, Boolean(error) || readString(item?.status) === "failed");
        } else if (type === "dynamicToolCall") {
          callbacks.onToolEnd(id, readString(item?.status) === "failed" || item?.success === false);
        } else if (type === "contextCompaction") {
          callbacks.onToolEnd(id, false);
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = readRecord(params?.tokenUsage);
        const last = readRecord(usage?.last);
        const total = readRecord(usage?.total);
        const input = readNumber(last?.inputTokens) ?? 0;
        const cached = readNumber(last?.cachedInputTokens) ?? 0;
        const output = readNumber(last?.outputTokens) ?? 0;
        this.lastTurnTokens = { input, cached, output };
        this.sessionTokens = {
          input: readNumber(total?.inputTokens) ?? this.sessionTokens.input,
          cached: readNumber(total?.cachedInputTokens) ?? this.sessionTokens.cached,
          output: readNumber(total?.outputTokens) ?? this.sessionTokens.output,
        };
        this.contextTokensUsed = undefined;
        this.appServerModelContextWindow =
          readNumber(usage?.modelContextWindow) ?? this.appServerModelContextWindow;
        callbacks.onTurnComplete?.({
          inputTokens: input,
          cachedInputTokens: cached,
          outputTokens: output,
        });
        break;
      }
      case "turn/moderationMetadata":
        break;
      case "turn/completed":
        callbacks.onAgentEnd();
        break;
      case "warning": {
        const message = readString(params?.message);
        if (message) {
          const id = `app-server-warning-${Date.now()}`;
          this.emitAppServerToolStart(callbacks, "app_server_warning", id);
          callbacks.onToolUpdate(id, message);
          callbacks.onToolEnd(id, false);
        }
        break;
      }
      case "error": {
        const message = readString(readRecord(params?.error)?.message) ?? readString(params?.message) ?? "Codex app-server error";
        const id = `app-server-error-${Date.now()}`;
        this.emitAppServerToolStart(callbacks, "app_server_error", id);
        callbacks.onToolUpdate(id, message);
        callbacks.onToolEnd(id, true);
        break;
      }
      default:
        break;
    }
  }

  private buildAppServerInput(input: CodexPromptInput): Array<Record<string, unknown>> {
    if (typeof input === "string") {
      return [{ type: "text", text: input, text_elements: [] }];
    }

    const items: Array<Record<string, unknown>> = [];
    const text = [input.stagedFileInstructions, input.text].filter(Boolean).join("\n\n");
    if (text) {
      items.push({ type: "text", text, text_elements: [] });
    }
    for (const imagePath of input.imagePaths ?? []) {
      items.push({ type: "localImage", path: imagePath });
    }
    return items.length > 0 ? items : [{ type: "text", text: "", text_elements: [] }];
  }

  private emitAppServerToolStart(callbacks: CodexSessionCallbacks, toolName: string, toolCallId: string): void {
    if (this.appServerStartedToolIds.has(toolCallId)) {
      return;
    }
    this.appServerStartedToolIds.add(toolCallId);
    callbacks.onToolStart(toolName, toolCallId);
  }

  private buildAppServerSandboxPolicy(): Record<string, unknown> {
    if (this.currentLaunchProfile.sandboxMode === "workspace-write") {
      return {
        type: "workspaceWrite",
        writableRoots: [this.currentWorkspace],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    if (this.currentLaunchProfile.sandboxMode === "danger-full-access") {
      return { type: "dangerFullAccess" };
    }
    return { type: "readOnly", networkAccess: false };
  }

  private getContextWindowInfo(model?: string): CodexSessionInfo["contextWindow"] | undefined {
    const modelSlug = model ?? this.config.codexModel;
    if (!modelSlug) {
      return undefined;
    }

    const modelRecord = listModels().find((candidate) => candidate.slug === modelSlug);
    const rawLimit = this.appServerModelContextWindow ?? modelRecord?.contextWindow ?? modelRecord?.maxContextWindow;
    if (!rawLimit) {
      return undefined;
    }

    const percent = this.appServerModelContextWindow ? 100 : modelRecord?.effectiveContextWindowPercent ?? 100;
    const effectiveLimit = Math.floor(rawLimit * (percent / 100));
    const rawUsed = this.contextTokensUsed ?? this.lastTurnTokens?.input;
    const used = rawUsed !== undefined && rawUsed <= effectiveLimit ? rawUsed : undefined;
    const remaining = used === undefined ? undefined : Math.max(0, effectiveLimit - used);
    const percentUsed = used === undefined ? undefined : Math.round((used / effectiveLimit) * 100);

    return {
      model: modelSlug,
      limit: rawLimit,
      effectiveLimit,
      used,
      remaining,
      percentUsed,
    };
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecoverableAppServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /app-server.*exited|stdin is not writable|client closed|channel.*closed|closed channel|EPIPE|ECONNRESET/i.test(message);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseAccountStatus(value: unknown): CodexStatusDetails["account"] | undefined {
  const record = readRecord(value);
  if (readRecord(record?.error)) {
    return undefined;
  }

  const account = readRecord(record?.account);
  if (!account) {
    return {
      type: "none",
      requiresOpenaiAuth: readBoolean(record?.requiresOpenaiAuth),
    };
  }

  return {
    type: readString(account?.type) ?? "unknown",
    email: readString(account?.email),
    planType: readString(account?.planType),
    requiresOpenaiAuth: readBoolean(record?.requiresOpenaiAuth),
  };
}

function parseRateLimitStatus(value: unknown): CodexStatusDetails["rateLimits"] {
  const record = readRecord(value);
  if (!record || readRecord(record?.error)) {
    return [];
  }

  const byLimitId = readRecord(record?.rateLimitsByLimitId);
  if (byLimitId) {
    return Object.values(byLimitId)
      .map(parseRateLimitSnapshot)
      .filter((entry): entry is CodexStatusDetails["rateLimits"][number] => Boolean(entry));
  }

  const single = parseRateLimitSnapshot(record?.rateLimits);
  return single ? [single] : [];
}

function parseAccountUsageStatus(value: unknown): CodexStatusDetails["accountUsage"] | undefined {
  const record = readRecord(value);
  if (!record || readRecord(record?.error)) {
    return undefined;
  }

  const summary = readRecord(record?.summary);
  if (!summary) {
    return undefined;
  }

  return {
    lifetimeTokens: readNumber(summary?.lifetimeTokens),
    currentStreakDays: readNumber(summary?.currentStreakDays),
    longestStreakDays: readNumber(summary?.longestStreakDays),
    peakDailyTokens: readNumber(summary?.peakDailyTokens),
    longestRunningTurnSec: readNumber(summary?.longestRunningTurnSec),
  };
}

function parseRateLimitSnapshot(value: unknown): CodexStatusDetails["rateLimits"][number] | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    limitId: readString(record?.limitId),
    limitName: readString(record?.limitName),
    planType: readString(record?.planType),
    primary: parseRateLimitWindow(record?.primary),
    secondary: parseRateLimitWindow(record?.secondary),
  };
}

function parseRateLimitWindow(value: unknown): CodexRateLimitWindow | undefined {
  const record = readRecord(value);
  const usedPercent = readNumber(record?.usedPercent);
  if (!record || usedPercent === undefined) {
    return undefined;
  }

  return {
    usedPercent,
    leftPercent: Math.max(0, 100 - usedPercent),
    windowDurationMins: readNumber(record?.windowDurationMins),
    resetsAt: readNumber(record?.resetsAt),
  };
}

function parseThreadStatus(value: unknown): CodexStatusDetails["thread"] | undefined {
  const record = readRecord(value);
  if (!record || readRecord(record?.error)) {
    return undefined;
  }

  const thread = readRecord(record?.thread);
  if (!thread) {
    return undefined;
  }

  return {
    sessionId: readString(thread?.sessionId),
    status: summarizeUnknownValue(thread?.status),
    cliVersion: readString(thread?.cliVersion),
    source: summarizeUnknownValue(thread?.source),
    instructionSources: [],
  };
}

function parseConfigStatus(value: unknown): CodexStatusDetails["config"] | undefined {
  const record = readRecord(value);
  if (!record || readRecord(record?.error)) {
    return undefined;
  }

  const config = readRecord(record?.config);
  if (!config) {
    return undefined;
  }

  return {
    model: readString(config?.model),
    modelContextWindow: readNumeric(config?.model_context_window),
    autoCompactTokenLimit: readNumeric(config?.model_auto_compact_token_limit),
  };
}

function readNumeric(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function summarizeUnknownValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseReasoningEfforts(value: unknown, currentModel?: string): string[] {
  const record = readRecord(value);
  if (!record || readRecord(record?.error)) {
    return [];
  }

  const models = Array.isArray(record?.models) ? record.models.map(readRecord) : [];
  const selected =
    models.find((model) => {
      const slug = readString(model?.slug) ?? readString(model?.id) ?? readString(model?.model);
      return Boolean(currentModel && slug === currentModel);
    }) ?? models.find((model) => Array.isArray(model?.supportedReasoningEfforts));
  const efforts = Array.isArray(selected?.supportedReasoningEfforts) ? selected.supportedReasoningEfforts : [];
  return efforts
    .map(readString)
    .filter((effort): effort is string => Boolean(effort && effort.trim()))
    .filter((effort, index, all) => all.indexOf(effort) === index);
}

function isRuntimeWorkspaceRootsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /runtimeWorkspaceRoots|experimentalApi|experimental api|unknown field|invalid params/i.test(message);
}

function summarizeAppServerProblem(notification: AppServerNotification): string {
  const params = readRecord(notification.params);
  const message =
    readString(readRecord(params?.error)?.message) ??
    readString(params?.message) ??
    readString(params?.reason) ??
    notification.method;
  return `${notification.method}: ${message}`;
}

function randomItemId(): string {
  return `item-${Math.random().toString(36).slice(2)}`;
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function buildSafetyInstructions(profile: CodexLaunchProfile): string | undefined {
  if (!profile.safetyPolicy) {
    return undefined;
  }

  return profile.safetyPolicy === "full"
    ? buildFullSafetyInstructions()
    : buildRestrictSafetyInstructions();
}

function buildFullSafetyInstructions(): string {
  return buildSafetyInstructionBlock(
    "full",
    [
      "You are running in TeleCodex FULL mode with danger-full-access and approval_policy=never.",
      "Root or sudo commands are pre-authorized when they are necessary for the user's request.",
      "Before destructive deletion, create a practical backup first. If a backup is not practical, stop and ask the user for explicit confirmation before deleting.",
      "Treat destructive deletion broadly: rm/unlink, recursive removal, truncation, overwrite-by-move, git clean/reset, database drops, package removals, and service data deletion.",
      "Keep changes scoped to the user's request and report any destructive or root-level action clearly.",
    ],
  );
}

function buildRestrictSafetyInstructions(): string {
  return buildSafetyInstructionBlock(
    "restrict",
    [
      "You are running in TeleCodex RESTRICT mode with danger-full-access and approval_policy=never, but you must behave conservatively.",
      "Do not run root or sudo commands unless the user explicitly confirms that specific action in the conversation.",
      "Before destructive deletion, create a practical backup first. If a backup is not practical, stop and ask the user for explicit confirmation before deleting.",
      "Treat destructive deletion broadly: rm/unlink, recursive removal, truncation, overwrite-by-move, git clean/reset, database drops, package removals, and service data deletion.",
      "Prefer reversible edits, narrow commands, and workspace-local changes. Explain when you are stopping for confirmation.",
    ],
  );
}

function buildSafetyInstructionBlock(policy: CodexSafetyPolicy, lines: string[]): string {
  return [
    `TeleCodex launch safety policy: ${policy}.`,
    ...lines,
  ].join("\n");
}

function buildCodexEnv(apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  return env;
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
