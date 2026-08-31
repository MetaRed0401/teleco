import { randomUUID } from "node:crypto";

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
  inspectWorkspace,
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

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CodexApprovalResponse =
  | { decision: CodexApprovalDecision }
  | {
      permissions: {
        fileSystem?: unknown | null;
        network?: unknown | null;
      };
      scope?: "turn" | "session";
      strictAutoReview?: boolean | null;
    };

export interface CodexMcpElicitationRequest {
  method: "mcpServer/elicitation/request";
  params?: unknown;
}

export type CodexMcpElicitationResponse = {
  action: "accept" | "decline" | "cancel";
  content: unknown | null;
  _meta: unknown | null;
};

export interface CodexToolUserInputRequest {
  method: "item/tool/requestUserInput";
  params?: unknown;
}

export type CodexToolUserInputResponse = {
  answers: Record<string, { answers: string[] }>;
};

export interface CodexSessionCallbacks {
  onTextDelta: (delta: string, metadata?: CodexAgentMessageMetadata) => void;
  onAgentMessageComplete?: (metadata: CodexAgentMessageMetadata) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string, metadata?: { kind?: "output" | "diff" }) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalResponse>;
  onMcpElicitationRequest?: (request: CodexMcpElicitationRequest) => Promise<CodexMcpElicitationResponse>;
  onToolUserInputRequest?: (request: CodexToolUserInputRequest) => Promise<CodexToolUserInputResponse>;
  onContextCompaction?: () => void;
  onThreadReverted?: () => void;
  onTurnStarted?: (turnId: string) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
}

export interface CodexAgentMessageMetadata {
  agentMessageId: string;
  startsNewMessage: boolean;
  delivery?: "async";
}

export interface CodexSessionInfo {
  threadId: string | null;
  projectId?: string;
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
  configuredSandboxMode?: string;
  configuredApprovalPolicy?: string;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  selectedPermissionProfileId?: string;
  permissionProfileId?: string;
  nextPermissionProfileId?: string;
  permissionProfilePending?: boolean;
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
    source: "app-server" | "model-cache";
    used?: number;
    remaining?: number;
    percentUsed?: number;
  };
  contextWindowPending?: boolean;
}

export interface CodexCompactResult {
  threadId: string;
  turnId?: string;
  elapsedMs: number;
  eventObserved: boolean;
}

export interface CodexRuntimeStatus {
  backend: "app-server" | "sdk-fallback";
  appServerEnabled: boolean;
  appServerRunning: boolean;
  appServerInitialized: boolean;
  currentTurnId: string | null;
  recentNotificationCount: number;
  recentProblem?: string;
  appServerTransport?: "persistent-websocket" | "direct-stdio";
  appServerTransportDetail?: string;
}

export interface CodexTurnRecoverySnapshot {
  threadId: string;
  turnId?: string;
  threadStatus: string;
  turnStatus?: string;
  items: CodexTurnRecoveryItem[];
  agentText: string;
  error?: string;
}

export type CodexTurnRecoveryItem =
  | {
      id: string;
      kind: "response";
      text: string;
      delivery?: "async";
    }
  | {
      id: string;
      kind: "tool";
      toolName: string;
      detail: string;
      isError: boolean;
    };

type CodexThreadHistoryMode = "legacy" | "paginated";

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
  threadUsage?: {
    estimatedCredits: number;
    estimatedUsd?: number;
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
  mcp?: {
    total: number;
    authenticationRequired: number;
    unknownAuthentication: number;
    runtimeStatusCounts: Record<CodexMcpServerRuntimeStatus, number>;
  };
  plugins?: {
    total: number;
    installed: number;
    disabled: number;
    loadErrors: number;
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
  permissionProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
}

export type CodexPromptInput = string | { text?: string; imagePaths?: string[]; stagedFileInstructions?: string };

export interface CodexPermissionProfile {
  id: string;
  allowed: boolean;
  description?: string;
}

export interface CodexMcpServerStatus {
  name: string;
  authStatus: string;
  runtimeStatus: CodexMcpServerRuntimeStatus;
}

export type CodexMcpServerRuntimeStatus =
  | "notStarted"
  | "starting"
  | "connected"
  | "authenticationRequired"
  | "failed"
  | "cancelled"
  | "disabled"
  | "unknown";

export interface CodexThreadSection {
  id: string;
  name: string;
}

export interface CodexQueuedPrompt {
  id: string;
  clientUserMessageId: string;
  summary: string;
}

export interface CodexQueueSnapshot {
  supported: boolean;
  items: CodexQueuedPrompt[];
}

export interface CodexThreadConnectionCheck {
  threadId: string;
  workspace: string;
  status: string;
  connectable: boolean;
}

type AppServerToolLifecycle = {
  status: "started" | "streaming" | "completed" | "failed";
  output: string;
  diff: string;
};

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
  private currentPermissionProfileId: string | undefined;
  private activeThreadPermissionProfileId: string | undefined;
  private sessionTokens = { input: 0, cached: 0, output: 0 };
  private lastTurnTokens: { input: number; cached: number; output: number } | undefined;
  private contextTokensUsed: number | undefined;
  private appServerModelContextWindow: number | undefined;
  private appServerContextWindowModel: string | undefined;
  private contextWindowPendingModel: string | undefined;
  private appServerClient: CodexAppServerClient | null = null;
  private appServerInitialized = false;
  private appServerThreadLoaded = false;
  private appServerCurrentTurnId: string | null = null;
  private appServerCallbacks: CodexSessionCallbacks | undefined;
  private readonly appServerToolLifecycles = new Map<string, AppServerToolLifecycle>();
  private readonly appServerAgentMessages = new Map<string, string>();
  private readonly appServerAsyncAgentMessages = new Set<string>();
  private readonly appServerCompletedAgentMessages = new Set<string>();
  private currentProjectId: string | undefined;
  private readonly threadMetadataOverrides = new Map<string, { name?: string; isPinned?: boolean }>();
  private firstPromptConnectionCheckPending = false;
  private appServerInstructionSources: string[] = [];
  private appServerActivePermissionProfile: string | undefined;
  private appServerApprovalsReviewer: string | undefined;
  private appServerModelProvider: string | undefined;
  private appServerServiceTier: string | undefined;
  private appServerEffectiveSandbox: string | undefined;
  private appServerEffectiveApprovalPolicy: string | undefined;

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
    service.currentPermissionProfileId = config.enableCodexAppServerRuntime
      ? options?.permissionProfileId
      : undefined;
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
    const sandboxMode = this.appServerEffectiveSandbox ?? effectiveLaunchProfile.sandboxMode;
    const approvalPolicy = this.appServerEffectiveApprovalPolicy ?? effectiveLaunchProfile.approvalPolicy;
    const info: CodexSessionInfo = {
      threadId: this.thread?.id ?? this.currentThreadId,
      projectId: this.currentProjectId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      fastMode: this.currentFastMode,
      fastOnce: this.fastOnce,
      serviceTier: this.getRequestedServiceTier() ?? this.appServerServiceTier,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode,
      approvalPolicy,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
    };

    if (sandboxMode !== effectiveLaunchProfile.sandboxMode) {
      info.configuredSandboxMode = effectiveLaunchProfile.sandboxMode;
    }
    if (approvalPolicy !== effectiveLaunchProfile.approvalPolicy) {
      info.configuredApprovalPolicy = effectiveLaunchProfile.approvalPolicy;
    }

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

    if (this.currentPermissionProfileId) {
      info.selectedPermissionProfileId = this.currentPermissionProfileId;
    }
    if (this.activeThreadLaunchProfile) {
      if (this.activeThreadPermissionProfileId) {
        info.permissionProfileId = this.activeThreadPermissionProfileId;
      }
      if (this.activeThreadPermissionProfileId !== this.currentPermissionProfileId) {
        info.permissionProfilePending = true;
        if (this.currentPermissionProfileId) {
          info.nextPermissionProfileId = this.currentPermissionProfileId;
        }
      }
    } else if (this.currentPermissionProfileId) {
      info.permissionProfileId = this.currentPermissionProfileId;
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
    if (info.model && this.contextWindowPendingModel === info.model) {
      info.contextWindowPending = true;
    }

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null;
  }

  hasActiveThread(): boolean {
    return Boolean(this.thread !== null || (this.config.enableCodexAppServerRuntime && this.currentThreadId !== null));
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
      appServerTransport: this.appServerClient?.getTransportMode(),
      appServerTransportDetail: this.appServerClient?.getTransportDetail(),
      recentProblem: closedReason ?? (recentProblem ? summarizeAppServerProblem(recentProblem) : undefined),
    };
  }

  async getTurnRecoverySnapshot(turnId?: string): Promise<CodexTurnRecoverySnapshot> {
    if (!this.config.enableCodexAppServerRuntime || !this.currentThreadId) {
      throw new Error("App-server thread is not available for recovery.");
    }

    await this.ensureAppServerThreadReady();
    const client = this.getAppServerClient();
    const response = await client.request(
      "thread/read",
      { threadId: this.currentThreadId, includeTurns: false },
      10_000,
    );
    let thread = readRecord(readRecord(response)?.thread);
    if (!thread) {
      throw new Error("Codex thread recovery snapshot is unavailable.");
    }

    const historyMode = readThreadHistoryMode(thread.historyMode);
    if (thread.historyMode !== undefined && !historyMode) {
      client.recordUnknownEvent("parse", "thread.historyMode");
    }
    const paginatedTurns = await this.readPaginatedRecoveryTurns(
      client,
      this.currentThreadId,
      turnId,
      historyMode === "paginated",
    );
    let turns: Record<string, unknown>[];
    let newestFirst = true;
    if (paginatedTurns) {
      turns = paginatedTurns;
    } else {
      const legacy = await this.readLegacyRecoveryThread(client, this.currentThreadId);
      thread = legacy.thread;
      turns = legacy.turns;
      newestFirst = false;
    }
    let turn = selectRecoveryTurn(turns, turnId, newestFirst);
    let items = Array.isArray(turn?.items)
      ? turn.items.map(readRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    if (paginatedTurns && turn && !Array.isArray(turn.items)) {
      const selectedTurnId = readString(turn.id);
      if (selectedTurnId) {
        const paginatedItems = await this.readPaginatedRecoveryItems(
          client,
          this.currentThreadId,
          selectedTurnId,
          historyMode === "paginated",
        );
        if (paginatedItems) {
          items = paginatedItems;
        } else {
          const legacy = await this.readLegacyRecoveryThread(client, this.currentThreadId);
          thread = legacy.thread;
          turns = legacy.turns;
          turn = selectRecoveryTurn(turns, turnId, false);
          items = Array.isArray(turn?.items)
            ? turn.items.map(readRecord).filter((item): item is Record<string, unknown> => Boolean(item))
            : [];
        }
      }
    }
    const recoveryItems = items
      .map((item, index) => toTurnRecoveryItem(item, index, readString(turn?.id)))
      .filter((item): item is CodexTurnRecoveryItem => Boolean(item));
    const agentMessages = recoveryItems
      .filter(
        (item): item is Extract<CodexTurnRecoveryItem, { kind: "response" }> =>
          item.kind === "response" && item.delivery !== "async",
      )
      .map((item) => item.text);
    const agentText = agentMessages.at(-1) ?? "";
    const threadStatus = readString(readRecord(thread.status)?.type) ?? "unknown";
    const turnError = readRecord(turn?.error);

    return {
      threadId: readString(thread.id) ?? this.currentThreadId,
      turnId: readString(turn?.id),
      threadStatus,
      turnStatus: readString(turn?.status),
      items: recoveryItems,
      agentText,
      error: readString(turnError?.message) ?? readString(turnError?.additionalDetails),
    };
  }

  private async readPaginatedRecoveryTurns(
    client: CodexAppServerClient,
    threadId: string,
    targetTurnId?: string,
    required = false,
  ): Promise<Record<string, unknown>[] | undefined> {
    const turns: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      let response: unknown;
      try {
        response = await client.request(
          "thread/turns/list",
          {
            threadId,
            limit: 50,
            sortDirection: "desc",
            itemsView: "full",
            ...(cursor ? { cursor } : {}),
          },
          10_000,
        );
      } catch (error) {
        if (page === 0) {
          if (required) {
            throw new Error("Codex paginated thread history is unavailable.");
          }
          if (isUnsupportedAppServerRequest(error, "thread/turns/list")) {
            return undefined;
          }
        }
        throw new Error("Codex paginated thread history pagination failed.");
      }

      const result = readRecord(response);
      const pageTurns = Array.isArray(result?.data)
        ? result.data.map(readRecord).filter((turn): turn is Record<string, unknown> => Boolean(turn))
        : [];
      turns.push(...pageTurns);
      if (!targetTurnId || turns.some((turn) => readString(turn.id) === targetTurnId)) {
        return turns;
      }

      const nextCursor = readString(result?.nextCursor);
      if (!nextCursor) {
        return turns;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex thread history returned a repeated pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error("Codex thread history exceeded the recovery page limit.");
  }

  private async readPaginatedRecoveryItems(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string,
    required: boolean,
  ): Promise<Record<string, unknown>[] | undefined> {
    const items: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      let response: unknown;
      try {
        response = await client.request(
          "thread/items/list",
          {
            threadId,
            turnId,
            limit: 50,
            sortDirection: "asc",
            ...(cursor ? { cursor } : {}),
          },
          10_000,
        );
      } catch (error) {
        if (page === 0 && !required && isUnsupportedAppServerRequest(error, "thread/items/list")) {
          return undefined;
        }
        throw new Error("Codex paginated thread items are unavailable.");
      }

      const result = readRecord(response);
      const pageItems = Array.isArray(result?.data)
        ? result.data.map(readRecord).filter((item): item is Record<string, unknown> => Boolean(item))
        : [];
      items.push(...pageItems);
      const nextCursor = readString(result?.nextCursor);
      if (!nextCursor) return items;
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex thread items returned a repeated pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error("Codex thread items exceeded the recovery page limit.");
  }

  private async readLegacyRecoveryThread(
    client: CodexAppServerClient,
    threadId: string,
  ): Promise<{ thread: Record<string, unknown>; turns: Record<string, unknown>[] }> {
    const response = await client.request(
      "thread/read",
      { threadId, includeTurns: true },
      10_000,
    );
    const thread = readRecord(readRecord(response)?.thread);
    if (!thread) {
      throw new Error("Codex thread recovery snapshot is unavailable.");
    }
    const turns = Array.isArray(thread.turns)
      ? thread.turns.map(readRecord).filter((turn): turn is Record<string, unknown> => Boolean(turn))
      : [];
    return { thread, turns };
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
      const [accountResponse, usageResponse, threadUsageResponse, rateLimitResponse, configResponse, threadResponse, mcpResponse, pluginResponse] = await Promise.all([
        client.request("account/read", { refreshToken: false }, 5000).catch((error) => ({ error })),
        client.request("account/usage/read", undefined, 5000).catch((error) => ({ error })),
        this.currentThreadId && isCodexMinorAtLeast(client.getCodexVersion(), 148)
          ? client.request("account/usage/read", { threadId: this.currentThreadId }, 5000).catch((error) => ({ error }))
          : Promise.resolve(undefined),
        client.request("account/rateLimits/read", undefined, 5000).catch((error) => ({ error })),
        client.request("config/read", {}, 5000).catch((error) => ({ error })),
        this.currentThreadId
          ? client.request("thread/read", { threadId: this.currentThreadId, includeTurns: false }, 5000).catch((error) => ({ error }))
          : Promise.resolve(undefined),
        this.listMcpServerStatuses(client, 5000).catch((error) => ({ error })),
        client.request(
          "plugin/list",
          {
            cwds: [this.currentWorkspace],
            forceRefetch: false,
            marketplaceKinds: ["local", "workspace-directory"],
          },
          5000,
        ).catch((error) => ({ error })),
      ]);

      const details: CodexStatusDetails = {
        account: parseAccountStatus(accountResponse),
        accountUsage: parseAccountUsageStatus(usageResponse),
        threadUsage: parseThreadUsageStatus(threadUsageResponse),
        rateLimits: parseRateLimitStatus(rateLimitResponse),
      };
      details.config = parseConfigStatus(configResponse);
      if (Array.isArray(mcpResponse)) {
        const runtimeStatusCounts: Record<CodexMcpServerRuntimeStatus, number> = {
          notStarted: 0,
          starting: 0,
          connected: 0,
          authenticationRequired: 0,
          failed: 0,
          cancelled: 0,
          disabled: 0,
          unknown: 0,
        };
        for (const status of mcpResponse) {
          runtimeStatusCounts[status.runtimeStatus] += 1;
        }
        details.mcp = {
          total: mcpResponse.length,
          authenticationRequired: mcpResponse.filter((status) => status.authStatus === "notLoggedIn").length,
          unknownAuthentication: mcpResponse.filter((status) => status.authStatus === "unknown").length,
          runtimeStatusCounts,
        };
      }
      const pluginRecord = readRecord(pluginResponse);
      if (Array.isArray(pluginRecord?.marketplaces)) {
        const plugins = pluginRecord.marketplaces.flatMap((value) => {
          const marketplace = readRecord(value);
          return Array.isArray(marketplace?.plugins)
            ? marketplace.plugins.map(readRecord).filter((plugin): plugin is Record<string, unknown> => Boolean(plugin))
            : [];
        });
        details.plugins = {
          total: plugins.length,
          installed: plugins.filter((plugin) => plugin.installed === true).length,
          disabled: plugins.filter((plugin) => plugin.enabled === false || Boolean(readString(plugin.disabledReason))).length,
          loadErrors: Array.isArray(pluginRecord.marketplaceLoadErrors) ? pluginRecord.marketplaceLoadErrors.length : 0,
        };
      }
      if (details.config?.model && !this.currentModel) {
        this.currentModel = details.config.model;
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
              const diff = summarizeAppServerFileChangeDiff(item as unknown as Record<string, unknown>);
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              if (diff) {
                callbacks.onToolUpdate(toolId, diff, { kind: "diff" });
              }
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
      this.firstPromptConnectionCheckPending = false;
      this.resetUsageState(effectiveModel);
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    this.thread = this.getCodex().startThread({
      ...this.buildThreadOptions(effectiveWorkspace, effectiveModel),
      threadSource: "telecodex",
    });
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = this.thread.id ?? null;
    this.firstPromptConnectionCheckPending = false;
    this.resetUsageState(effectiveModel);
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
    assertWorkspaceAvailable(workspace);

    if (this.config.enableCodexAppServerRuntime) {
      this.resetAppServerClient();
      await this.ensureAppServerInitialized();
      const response = await this.requestAppServerThreadResume({
        threadId,
        excludeTurns: true,
      });
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentThreadId = threadId;
      this.captureAppServerThreadResumeState(response);
      this.appServerThreadLoaded = true;
      this.firstPromptConnectionCheckPending = true;
      this.lastTurnTokens = undefined;
      this.contextTokensUsed = undefined;
      this.appServerModelContextWindow = undefined;
      this.appServerContextWindowModel = undefined;
      this.contextWindowPendingModel = this.currentModel ?? model ?? this.config.codexModel;
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
    this.firstPromptConnectionCheckPending = true;
    this.lastTurnTokens = undefined;
    this.contextTokensUsed = undefined;
    this.appServerModelContextWindow = undefined;
    this.appServerContextWindowModel = undefined;
    this.contextWindowPendingModel = undefined;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async forkThread(beforeTurnId?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("fork a thread");
    if (!this.currentThreadId) {
      throw new Error("No active Codex thread to fork.");
    }
    if (!this.config.enableCodexAppServerRuntime) {
      throw new Error("App-server runtime is required to fork a thread.");
    }

    await this.ensureAppServerInitialized();
    const response = await this.requestAppServerThreadFork({
      threadId: this.currentThreadId,
      excludeTurns: true,
      ...(beforeTurnId ? { beforeTurnId } : {}),
    });
    const threadId = readString(readRecord(readRecord(response)?.thread)?.id);
    if (!threadId) {
      throw new Error("Codex app-server did not return a forked thread id.");
    }

    this.captureAppServerThreadResumeState(response);
    this.thread = null;
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = threadId;
    this.appServerThreadLoaded = true;
    this.firstPromptConnectionCheckPending = false;
    this.resetUsageState(this.currentModel ?? this.config.codexModel);
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || undefined;
    assertWorkspaceAvailable(workspace);

    if (this.config.enableCodexAppServerRuntime) {
      if (workspace !== this.currentWorkspace) {
        this.resetAppServerClient();
      }
      await this.ensureAppServerInitialized();
      const response = await this.requestAppServerThreadResume({
        threadId,
        excludeTurns: true,
      });
      this.captureAppServerThreadResumeState(response);
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentWorkspace = workspace;
      this.currentThreadId = threadId;
      this.appServerThreadLoaded = true;
      this.firstPromptConnectionCheckPending = true;
      this.resetUsageState(model ?? this.currentModel ?? this.config.codexModel);
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    this.firstPromptConnectionCheckPending = true;
    this.resetUsageState(model ?? this.currentModel);
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
    let finish: (result: { turnId?: string; eventObserved: true }) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const completed = new Promise<{ turnId?: string; eventObserved: true }>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let completionTimeout: NodeJS.Timeout | undefined;

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
            eventObserved: true,
          });
        }
        return;
      }

      if (notification.method === "thread/compacted") {
        finish({
          turnId: readString(params?.turnId) ?? turnId,
          eventObserved: true,
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
      const result = await Promise.race([
        completed,
        new Promise<{ turnId?: string; eventObserved: false }>((resolve) => {
          completionTimeout = setTimeout(() => resolve({ turnId, eventObserved: false }), 60_000);
        }),
      ]);
      if (result.eventObserved) {
        this.lastTurnTokens = undefined;
        this.contextTokensUsed = undefined;
      }
      return {
        threadId,
        turnId: result.turnId,
        elapsedMs: Date.now() - startedAt,
        eventObserved: result.eventObserved,
      };
    } catch (error) {
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new Error("Native compact was aborted.");
      }
      throw error;
    } finally {
      if (completionTimeout) clearTimeout(completionTimeout);
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
    return listThreads(limit ?? 20).map((thread) => {
      const override = this.threadMetadataOverrides.get(thread.id);
      return override ? { ...thread, ...override } : thread;
    });
  }

  async checkThreadConnection(threadId: string): Promise<CodexThreadConnectionCheck> {
    this.ensureIdle("check a thread connection");
    const record = getThread(threadId);
    if (!record) {
      throw new Error(`Unknown Codex thread: ${threadId}`);
    }
    assertWorkspaceAvailable(record.cwd);
    if (!this.config.enableCodexAppServerRuntime) {
      throw new Error("App-server runtime is required to check a thread connection.");
    }

    await this.ensureAppServerInitialized();
    const response = await this.getAppServerClient().request(
      "thread/read",
      { threadId, includeTurns: false },
      5000,
    );
    const thread = readRecord(readRecord(response)?.thread);
    if (!thread || readString(thread.id) !== threadId) {
      throw new Error("Codex thread is not readable through the app-server.");
    }

    const status = readString(readRecord(thread.status)?.type) ?? readString(thread.status) ?? "unknown";
    return {
      threadId,
      workspace: record.cwd,
      status,
      connectable: status !== "active" && status !== "systemError",
    };
  }

  async checkPendingFirstPromptConnection(): Promise<CodexThreadConnectionCheck | undefined> {
    if (!this.firstPromptConnectionCheckPending || !this.currentThreadId) {
      return undefined;
    }
    const result = await this.checkThreadConnection(this.currentThreadId);
    if (result.connectable) {
      this.firstPromptConnectionCheckPending = false;
    }
    return result;
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

  async listPermissionProfiles(): Promise<CodexPermissionProfile[]> {
    if (!this.config.enableCodexAppServerRuntime) {
      return [];
    }

    try {
      await this.ensureAppServerInitialized();
      const response = await this.getAppServerClient().request(
        "permissionProfile/list",
        { cwd: this.currentWorkspace, limit: 100 },
        5000,
      );
      const data = readRecord(response)?.data;
      if (!Array.isArray(data)) {
        return [];
      }
      return data.flatMap((value) => {
        const profile = readRecord(value);
        const id = readString(profile?.id);
        if (!id) {
          return [];
        }
        const description = readString(profile?.description);
        return [{
          id,
          allowed: profile?.allowed === true,
          ...(description ? { description } : {}),
        }];
      });
    } catch {
      return [];
    }
  }

  setModel(slug: string): string {
    if (this.currentModel !== slug && this.config.enableCodexAppServerRuntime) {
      this.appServerModelContextWindow = undefined;
      this.appServerContextWindowModel = undefined;
      this.contextTokensUsed = undefined;
      this.contextWindowPendingModel = slug;
    }
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
    this.currentPermissionProfileId = undefined;
    this.resetCodexClient();
    return this.currentLaunchProfile;
  }

  async setLaunchProfileAndReattach(profileId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("change launch profile");
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    this.currentPermissionProfileId = undefined;

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

  setPermissionProfile(profileId: string | undefined): CodexSessionInfo {
    this.currentPermissionProfileId = profileId;
    return this.getInfo();
  }

  async setPermissionProfileAndReattach(profileId: string | undefined): Promise<CodexSessionInfo> {
    this.ensureIdle("change permission profile");
    this.currentPermissionProfileId = profileId;

    const threadId = this.currentThreadId ?? this.thread?.id ?? null;
    if (!threadId) {
      return this.getInfo();
    }

    return this.resumeThread(threadId);
  }

  async handback(): Promise<{ threadId: string | null; workspace: string }> {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    if (
      this.config.enableCodexAppServerRuntime
      && info.threadId
      && this.appServerInitialized
      && this.appServerThreadLoaded
      && this.appServerClient?.isHealthy()
    ) {
      await this.appServerClient.request("thread/unsubscribe", { threadId: info.threadId }, 5000);
    }
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.currentProjectId = undefined;
    this.firstPromptConnectionCheckPending = false;
    this.activeThreadLaunchProfile = null;
    this.activeThreadPermissionProfileId = undefined;
    this.resetAppServerClient();
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.currentProjectId = undefined;
    this.activeThreadLaunchProfile = null;
    this.activeThreadPermissionProfileId = undefined;
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

  async refreshMcpServers(): Promise<{ supported: boolean; statuses: CodexMcpServerStatus[] }> {
    if (!this.config.enableCodexAppServerRuntime) {
      return { supported: false, statuses: [] };
    }

    await this.ensureAppServerInitialized();
    const client = this.getAppServerClient();
    try {
      await client.request("config/mcpServer/reload", {}, 10_000);
    } catch (error) {
      if (isUnsupportedAppServerRequest(error, "config/mcpServer/reload")) {
        return { supported: false, statuses: [] };
      }
      throw error;
    }

    const statuses = await this.listMcpServerStatuses(client, 10_000);
    return { supported: true, statuses };
  }

  async listThreadSections(): Promise<{ supported: boolean; sections: CodexThreadSection[] }> {
    if (!this.config.enableCodexAppServerRuntime) {
      return { supported: false, sections: [] };
    }

    await this.ensureAppServerInitialized();
    const client = this.getAppServerClient();
    const sections: CodexThreadSection[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      let response: unknown;
      try {
        response = await client.request(
          "threadSection/list",
          cursor ? { cursor, limit: 100 } : { limit: 100 },
          10_000,
        );
      } catch (error) {
        if (page === 0 && isUnsupportedAppServerRequest(error, "threadSection/list")) {
          return { supported: false, sections: [] };
        }
        throw error;
      }

      const result = readRecord(response);
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const value of data) {
        const section = readRecord(value);
        const id = readString(section?.id);
        const name = readString(section?.name);
        if (id && name) {
          sections.push({ id, name });
        }
      }

      const nextCursor = readString(result?.nextCursor);
      if (!nextCursor) {
        return { supported: true, sections };
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex thread sections returned a repeated pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error("Codex thread sections exceeded the pagination limit.");
  }

  async moveCurrentThreadToSection(sectionId: string | null): Promise<void> {
    this.ensureIdle("move a thread to a section");
    if (!this.currentThreadId || !this.config.enableCodexAppServerRuntime) {
      throw new Error("Thread section changes require an active app-server thread.");
    }

    await this.ensureAppServerThreadReady();
    await this.getAppServerClient().request(
      "thread/section/move",
      { threadId: this.currentThreadId, sectionId },
      5000,
    );
  }

  async listQueuedPrompts(): Promise<CodexQueueSnapshot> {
    if (!this.config.enableCodexAppServerRuntime) {
      return { supported: false, items: [] };
    }

    await this.ensureAppServerInitialized();
    const client = this.getAppServerClient();
    if (!isCodexMinorAtLeast(client.getCodexVersion(), 148)) {
      return { supported: false, items: [] };
    }
    if (!this.currentThreadId) {
      return { supported: true, items: [] };
    }

    await this.ensureAppServerThreadReady();
    return {
      supported: true,
      items: await this.listNativeQueuedPrompts(client, this.currentThreadId),
    };
  }

  async addQueuedPrompt(input: CodexPromptInput): Promise<CodexQueuedPrompt> {
    const { client, threadId } = await this.requireNativeQueue();
    const response = await client.request(
      "thread/queue/add",
      {
        threadId,
        input: this.buildAppServerInput(input),
        clientUserMessageId: randomUUID(),
      },
      5000,
    );
    const queued = parseQueuedPrompt(readRecord(response)?.queuedSubmission);
    if (!queued) {
      throw new Error("Codex did not return the queued submission.");
    }
    return queued;
  }

  async updateQueuedPrompt(queuedSubmissionId: string, input: CodexPromptInput): Promise<CodexQueuedPrompt> {
    const { client, threadId } = await this.requireNativeQueue();
    const response = await client.request(
      "thread/queue/update",
      { threadId, queuedSubmissionId, input: this.buildAppServerInput(input) },
      5000,
    );
    const queued = parseQueuedPrompt(readRecord(response)?.queuedSubmission);
    if (!queued) {
      throw new Error("Codex did not return the updated queued submission.");
    }
    return queued;
  }

  async deleteQueuedPrompt(queuedSubmissionId: string): Promise<boolean> {
    const { client, threadId } = await this.requireNativeQueue();
    const response = await client.request(
      "thread/queue/delete",
      { threadId, queuedSubmissionId },
      5000,
    );
    return readRecord(response)?.deleted === true;
  }

  async clearQueuedPrompts(): Promise<number> {
    const snapshot = await this.listQueuedPrompts();
    if (!snapshot.supported) {
      throw new Error("Native Codex queue is unavailable.");
    }
    let deleted = 0;
    for (const item of snapshot.items) {
      if (await this.deleteQueuedPrompt(item.id)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async reorderQueuedPrompts(queuedSubmissionIds: string[]): Promise<void> {
    const { client, threadId } = await this.requireNativeQueue();
    await client.request("thread/queue/reorder", { threadId, queuedSubmissionIds }, 5000);
  }

  async startQueuedPrompt(queuedSubmissionId?: string): Promise<string | undefined> {
    const { client, threadId } = await this.requireNativeQueue();
    const response = await client.request(
      "thread/queue/start",
      { threadId, queuedSubmissionId: queuedSubmissionId ?? null },
      5000,
    );
    return readString(readRecord(readRecord(response)?.turn)?.id);
  }

  private async requireNativeQueue(): Promise<{ client: CodexAppServerClient; threadId: string }> {
    if (!this.config.enableCodexAppServerRuntime || !this.currentThreadId) {
      throw new Error("Native Codex queue requires an active app-server thread.");
    }
    await this.ensureAppServerThreadReady();
    const client = this.getAppServerClient();
    if (!isCodexMinorAtLeast(client.getCodexVersion(), 148)) {
      throw new Error("Native Codex queue requires Codex 0.148 or newer.");
    }
    return { client, threadId: this.currentThreadId };
  }

  private async listNativeQueuedPrompts(
    client: CodexAppServerClient,
    threadId: string,
  ): Promise<CodexQueuedPrompt[]> {
    const items: CodexQueuedPrompt[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const response = await client.request(
        "thread/queue/list",
        { threadId, limit: 100, ...(cursor ? { cursor } : {}) },
        5000,
      );
      const result = readRecord(response);
      const pageItems = Array.isArray(result?.data) ? result.data : [];
      for (const value of pageItems) {
        const queued = parseQueuedPrompt(value);
        if (queued) {
          items.push(queued);
        }
      }
      const nextCursor = readString(result?.nextCursor);
      if (!nextCursor) {
        return items;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex queue returned a repeated pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error("Codex queue exceeded the pagination limit.");
  }

  async setThreadName(name: string): Promise<string> {
    this.ensureIdle("rename a thread");
    const normalizedName = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!normalizedName) {
      throw new Error("Thread name cannot be empty.");
    }
    if (normalizedName.length > 80) {
      throw new Error("Thread name must be 80 characters or fewer.");
    }
    if (!this.currentThreadId || !this.config.enableCodexAppServerRuntime) {
      throw new Error("Native thread naming requires an active app-server thread.");
    }

    await this.ensureAppServerThreadReady();
    await this.getAppServerClient().request(
      "thread/name/set",
      { threadId: this.currentThreadId, name: normalizedName },
      5000,
    );
    this.threadMetadataOverrides.set(this.currentThreadId, {
      ...this.threadMetadataOverrides.get(this.currentThreadId),
      name: normalizedName,
    });
    return normalizedName;
  }

  async setThreadPinned(isPinned: boolean): Promise<void> {
    this.ensureIdle(isPinned ? "pin a thread" : "unpin a thread");
    if (!this.currentThreadId || !this.config.enableCodexAppServerRuntime) {
      throw new Error("Native thread pinning requires an active app-server thread.");
    }

    await this.ensureAppServerThreadReady();
    const client = this.getAppServerClient();
    if (isCodexMinorAtLeast(client.getCodexVersion(), 147)) {
      throw new Error("Native thread pinning is unavailable in Codex 0.147 and newer.");
    }
    await client.request(
      "thread/metadata/update",
      { threadId: this.currentThreadId, isPinned },
      5000,
    );
    this.threadMetadataOverrides.set(this.currentThreadId, {
      ...this.threadMetadataOverrides.get(this.currentThreadId),
      isPinned,
    });
  }

  private async listMcpServerStatuses(
    client: CodexAppServerClient,
    timeoutMs: number,
  ): Promise<CodexMcpServerStatus[]> {
    const statuses: CodexMcpServerStatus[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const response = await client.request(
        "mcpServerStatus/list",
        cursor ? { cursor } : {},
        timeoutMs,
      );
      const result = readRecord(response);
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const value of data) {
        const status = readRecord(value);
        const name = readString(status?.name);
        if (name) {
          statuses.push({
            name,
            authStatus: readString(status?.authStatus) ?? "unknown",
            runtimeStatus: readMcpServerRuntimeStatus(status?.runtimeStatus),
          });
        }
      }

      const nextCursor = readString(result?.nextCursor);
      if (!nextCursor) {
        return statuses;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Codex MCP status returned a repeated pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error("Codex MCP status exceeded the pagination limit.");
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
    this.appServerToolLifecycles.clear();
    this.appServerAgentMessages.clear();
    this.appServerAsyncAgentMessages.clear();
    this.appServerCompletedAgentMessages.clear();
  }

  private resetUsageState(model = this.currentModel ?? this.config.codexModel): void {
    this.sessionTokens = { input: 0, cached: 0, output: 0 };
    this.lastTurnTokens = undefined;
    this.contextTokensUsed = undefined;
    this.appServerModelContextWindow = undefined;
    this.appServerContextWindowModel = undefined;
    this.contextWindowPendingModel = this.config.enableCodexAppServerRuntime ? model : undefined;
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
    const thread = readRecord(record?.thread);
    this.currentProjectId = readString(thread?.projectId);
    this.appServerInstructionSources = readStringArray(record?.instructionSources);
    this.appServerActivePermissionProfile = summarizeUnknownValue(record?.activePermissionProfile);
    this.appServerApprovalsReviewer = summarizeUnknownValue(record?.approvalsReviewer);
    this.appServerModelProvider = readString(record?.modelProvider);
    this.appServerServiceTier = readString(record?.serviceTier);
    this.appServerEffectiveApprovalPolicy = summarizeApprovalPolicy(record?.approvalPolicy);
    this.appServerEffectiveSandbox = summarizeSandboxPolicy(record?.sandbox);
    const resumedWorkspace = readString(record?.cwd);
    if (resumedWorkspace) {
      this.currentWorkspace = resumedWorkspace;
    }
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
    this.appServerToolLifecycles.clear();
    this.appServerAgentMessages.clear();
    this.appServerAsyncAgentMessages.clear();
    this.appServerCompletedAgentMessages.clear();
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
      if (this.appServerCurrentTurnId) {
        callbacks.onTurnStarted?.(this.appServerCurrentTurnId);
      }

      await this.waitForAppServerTurnChain(client, callbacks, controller, this.currentThreadId);
    } catch (error) {
      if (isRecoverableAppServerError(error)) {
        this.resetAppServerClient();
      }
      throw error;
    } finally {
      unsubscribe();
      this.appServerCurrentTurnId = null;
      this.appServerToolLifecycles.clear();
      this.appServerAgentMessages.clear();
      this.appServerAsyncAgentMessages.clear();
      this.appServerCompletedAgentMessages.clear();
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private async waitForAppServerTurnChain(
    client: CodexAppServerClient,
    callbacks: CodexSessionCallbacks,
    controller: AbortController,
    threadId: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let settleTimer: NodeJS.Timeout | undefined;
      let lastFailure: Error | undefined;

      const cleanup = (): void => {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        controller.signal.removeEventListener("abort", onAbort);
        unsubscribe();
      };
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onAbort = (): void => finish(new Error("Codex turn was aborted."));

      const inspectQueue = async (): Promise<void> => {
        if (settled || this.appServerCurrentTurnId) {
          return;
        }
        if (!isCodexMinorAtLeast(client.getCodexVersion(), 148)) {
          finish(lastFailure);
          return;
        }

        try {
          const queued = await this.listNativeQueuedPrompts(client, threadId);
          if (settled || this.appServerCurrentTurnId) {
            return;
          }
          if (queued.length === 0) {
            finish(lastFailure);
            return;
          }

          const response = await client.request(
            "thread/queue/start",
            { threadId, queuedSubmissionId: null },
            5000,
          ).catch((error) => {
            if (!/active|in progress|invalid request/i.test(String(error))) {
              throw error;
            }
            return undefined;
          });
          const turnId = readString(readRecord(readRecord(response)?.turn)?.id);
          if (turnId && turnId !== this.appServerCurrentTurnId) {
            this.appServerCurrentTurnId = turnId;
            callbacks.onTurnStarted?.(turnId);
          }
          scheduleQueueInspection(250);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const scheduleQueueInspection = (delayMs = 100): void => {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        settleTimer = setTimeout(() => void inspectQueue(), delayMs);
      };

      const unsubscribe = client.onNotification((notification) => {
        const params = readRecord(notification.params);
        if (readString(params?.threadId) !== threadId) {
          return;
        }
        if (notification.method === "thread/deleted") {
          finish(new Error("The active Codex thread was deleted."));
          return;
        }
        if (notification.method === "error") {
          finish(
            new Error(
              readString(readRecord(params?.error)?.message) ??
                readString(params?.message) ??
                "Codex app-server turn failed.",
            ),
          );
          return;
        }
        if (notification.method === "turn/started") {
          lastFailure = undefined;
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = undefined;
          }
          return;
        }
        if (notification.method !== "turn/completed") {
          if (
            notification.method === "thread/status/changed" &&
            readString(readRecord(params?.status)?.type) === "idle"
          ) {
            scheduleQueueInspection();
          }
          return;
        }

        const turn = readRecord(params?.turn);
        const status = readString(turn?.status);
        this.appServerCurrentTurnId = null;
        if (status === "interrupted") {
          finish();
          return;
        }
        if (status === "failed") {
          const turnError = readRecord(turn?.error);
          lastFailure = new Error(
            readString(turnError?.message) ??
              readString(turnError?.additionalDetails) ??
              "Codex app-server turn failed.",
          );
        }
        scheduleQueueInspection();
      });

      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
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
      excludeTurns: true,
    });
    this.captureAppServerThreadResumeState(response);
    this.thread = null;
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.appServerThreadLoaded = true;
  }

  private async requestAppServerThreadStart(params: Record<string, unknown>): Promise<unknown> {
    const requestParams = this.applyAppServerPermissionProfile(params, "thread");
    try {
      const response = await this.getAppServerClient().request("thread/start", requestParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in requestParams)) {
        throw error;
      }
      const retryParams = { ...requestParams };
      delete retryParams.runtimeWorkspaceRoots;
      const response = await this.getAppServerClient().request("thread/start", retryParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    }
  }

  private async requestAppServerThreadResume(params: Record<string, unknown>): Promise<unknown> {
    const requestParams = this.applyAppServerPermissionProfile(params, "thread");
    try {
      const response = await this.getAppServerClient().request("thread/resume", requestParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in requestParams)) {
        throw error;
      }
      const retryParams = { ...requestParams };
      delete retryParams.runtimeWorkspaceRoots;
      const response = await this.getAppServerClient().request("thread/resume", retryParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    }
  }

  private async requestAppServerThreadFork(params: Record<string, unknown>): Promise<unknown> {
    const requestParams = this.applyAppServerPermissionProfile(params, "thread");
    try {
      const response = await this.getAppServerClient().request("thread/fork", requestParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in requestParams)) {
        throw error;
      }
      const retryParams = { ...requestParams };
      delete retryParams.runtimeWorkspaceRoots;
      const response = await this.getAppServerClient().request("thread/fork", retryParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    }
  }

  private async requestAppServerTurnStart(client: CodexAppServerClient, params: Record<string, unknown>): Promise<unknown> {
    const requestParams = this.applyAppServerPermissionProfile(params, "turn");
    try {
      const response = await client.request("turn/start", requestParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    } catch (error) {
      if (!isRuntimeWorkspaceRootsError(error) || !("runtimeWorkspaceRoots" in requestParams)) {
        throw error;
      }
      const retryParams = { ...requestParams };
      delete retryParams.runtimeWorkspaceRoots;
      const response = await client.request("turn/start", retryParams);
      this.activeThreadPermissionProfileId = this.currentPermissionProfileId;
      return response;
    }
  }

  private applyAppServerPermissionProfile(
    params: Record<string, unknown>,
    target: "thread" | "turn",
  ): Record<string, unknown> {
    const next = { ...params };
    if (!this.currentPermissionProfileId) {
      delete next.permissions;
      return next;
    }

    next.permissions = this.currentPermissionProfileId;
    if (target === "turn") {
      delete next.sandboxPolicy;
    } else {
      delete next.sandbox;
    }
    return next;
  }

  private async handleAppServerRequest(
    request: AppServerRequest,
    callbacks?: CodexSessionCallbacks,
  ): Promise<unknown> {
    const defaultApprovalResponse = (): CodexApprovalResponse =>
      request.method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : { decision: "decline" };
    const requestThreadId = readString(readRecord(request.params)?.threadId);
    if (requestThreadId && this.currentThreadId && requestThreadId !== this.currentThreadId) {
      if (request.method === "mcpServer/elicitation/request") {
        return { action: "cancel", content: null, _meta: null };
      }
      return defaultApprovalResponse();
    }

    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval"
    ) {
      if (request.method === "item/commandExecution/requestApproval") {
        const params = readRecord(request.params);
        const kind = params?.kind;
        if (kind !== undefined && kind !== "command" && kind !== "writeStdin") {
          this.appServerClient?.recordUnknownEvent?.(
            "request",
            "item/commandExecution/requestApproval:unknown-kind",
          );
          return defaultApprovalResponse();
        }
      }
      console.log(`App-server approval request: ${request.method}`);
      const response = await callbacks?.onApprovalRequest?.({
        method: request.method,
        params: request.params,
      });
      return response ?? defaultApprovalResponse();
    }

    if (request.method === "mcpServer/elicitation/request") {
      const response = await callbacks?.onMcpElicitationRequest?.({
        method: request.method,
        params: request.params,
      });
      return response ?? { action: "cancel", content: null, _meta: null };
    }

    if (request.method === "item/tool/requestUserInput") {
      const response = await callbacks?.onToolUserInputRequest?.({
        method: request.method,
        params: request.params,
      });
      return response ?? { answers: {} };
    }

    if (request.method === "item/tool/call") {
      return { contentItems: [], success: false };
    }

    if (request.method === "currentTime/read") {
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    }

    this.appServerClient?.recordUnknownEvent?.("request", request.method);
    throw new Error(`Unsupported app-server request: ${request.method}`);
  }

  private handleAppServerNotification(
    notification: AppServerNotification,
    callbacks: CodexSessionCallbacks,
  ): void {
    const params = readRecord(notification.params);
    const notificationThreadId = readString(params?.threadId);
    if (notificationThreadId && this.currentThreadId && notificationThreadId !== this.currentThreadId) {
      return;
    }
    const notificationTurnId = readString(params?.turnId) ?? readString(readRecord(params?.turn)?.id);
    if (
      notification.method !== "turn/started" &&
      notificationTurnId &&
      this.appServerCurrentTurnId &&
      notificationTurnId !== this.appServerCurrentTurnId
    ) {
      return;
    }
    if (notificationTurnId && !this.appServerCurrentTurnId) {
      this.appServerCurrentTurnId = notificationTurnId;
    }

    switch (notification.method) {
      case "thread/started": {
        const thread = readRecord(params?.thread);
        const threadId = readString(thread?.id);
        if (threadId) {
          this.currentThreadId = threadId;
          this.currentProjectId = readString(thread?.projectId);
          this.appServerThreadLoaded = true;
        }
        break;
      }
      case "turn/started": {
        const turnId = readString(readRecord(params?.turn)?.id);
        if (turnId) {
          this.appServerCurrentTurnId = turnId;
          this.appServerToolLifecycles.clear();
          this.appServerAgentMessages.clear();
          this.appServerAsyncAgentMessages.clear();
          this.appServerCompletedAgentMessages.clear();
          callbacks.onTurnStarted?.(turnId);
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = readString(params?.delta);
        const itemId = readString(params?.itemId) ?? "agent-message";
        if (delta) {
          this.emitAppServerAgentDelta(callbacks, itemId, delta, this.getAppServerAgentDelivery(itemId));
        }
        break;
      }
      case "item/started": {
        const item = readRecord(params?.item);
        const id = readString(item?.id) ?? randomItemId();
        const type = readString(item?.type);
        if (type === "agentMessage") {
          if (readAgentMessageDelivery(item) === "async") {
            this.appServerAsyncAgentMessages.add(this.getAppServerItemLifecycleKey(id));
          }
        } else if (type === "commandExecution") {
          this.emitAppServerToolStart(callbacks, getCommandExecutionToolName(item), id);
        } else if (type === "mcpToolCall") {
          this.emitAppServerToolStart(callbacks, `mcp:${readString(item?.server) ?? "unknown"}/${readString(item?.tool) ?? "tool"}`, id);
        } else if (type === "dynamicToolCall") {
          this.emitAppServerToolStart(callbacks, `dynamic:${readString(item?.namespace) ?? "tool"}/${readString(item?.tool) ?? "call"}`, id);
        } else if (type === "fileChange") {
          this.emitAppServerToolStart(callbacks, "file_change", id);
        } else if (type === "contextCompaction") {
          callbacks.onContextCompaction?.();
          this.emitAppServerToolStart(callbacks, "context_compaction", id);
        } else {
          const toolName = getCanonicalAppServerToolName(item);
          if (toolName) {
            this.emitAppServerToolStart(callbacks, toolName, id);
          } else if (type && !isKnownPassiveAppServerItem(type)) {
            this.appServerClient?.recordUnknownEvent?.("item", type);
          }
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
          this.emitAppServerToolStart(callbacks, "shell", itemId);
          this.emitAppServerToolDelta(callbacks, itemId, delta);
        }
        break;
      }
      case "item/fileChange/outputDelta": {
        const itemId = readString(params?.itemId);
        const delta = readString(params?.delta);
        if (itemId && delta) {
          this.emitAppServerToolStart(callbacks, "file_change", itemId);
          this.emitAppServerToolDelta(callbacks, itemId, delta, "diff");
        }
        break;
      }
      case "item/fileChange/patchUpdated": {
        const itemId = readString(params?.itemId);
        if (itemId) {
          const patchItem = { changes: params?.changes };
          const summary = summarizeAppServerFileChange(patchItem);
          const diff = summarizeAppServerFileChangeDiff(patchItem);
          this.emitAppServerToolStart(callbacks, "file_change", itemId);
          if (summary) {
            this.emitAppServerToolSnapshot(callbacks, itemId, summary);
          }
          if (diff) {
            this.emitAppServerToolSnapshot(callbacks, itemId, diff, "diff");
          }
        }
        break;
      }
      case "item/mcpToolCall/progress": {
        const itemId = readString(params?.itemId);
        const message = readString(params?.message);
        if (itemId && message) {
          this.emitAppServerToolStart(callbacks, "mcp:unknown/tool", itemId);
          this.emitAppServerToolDelta(callbacks, itemId, `${message}\n`);
        }
        break;
      }
      case "item/completed": {
        const item = readRecord(params?.item);
        const id = readString(item?.id) ?? randomItemId();
        const type = readString(item?.type);
        if (type === "agentMessage") {
          const delivery = readAgentMessageDelivery(item) ?? this.getAppServerAgentDelivery(id);
          if (delivery === "async") {
            this.appServerAsyncAgentMessages.add(this.getAppServerItemLifecycleKey(id));
          }
          this.emitAppServerAgentSnapshot(callbacks, id, readString(item?.text) ?? "", delivery);
          const lifecycleKey = this.getAppServerItemLifecycleKey(id);
          if (delivery === "async" && !this.appServerCompletedAgentMessages.has(lifecycleKey)) {
            this.appServerCompletedAgentMessages.add(lifecycleKey);
            callbacks.onAgentMessageComplete?.({ agentMessageId: id, startsNewMessage: false, delivery });
          }
        } else if (type === "commandExecution") {
          this.emitAppServerToolStart(callbacks, getCommandExecutionToolName(item), id);
          const output = readString(item?.aggregatedOutput);
          if (output) {
            this.emitAppServerToolSnapshot(callbacks, id, output);
          }
          this.emitAppServerToolEnd(callbacks, id, readString(item?.status) === "failed");
        } else if (type === "fileChange") {
          this.emitAppServerToolStart(callbacks, "file_change", id);
          const summary = summarizeAppServerFileChange(item);
          const diff = summarizeAppServerFileChangeDiff(item);
          if (summary) {
            this.emitAppServerToolSnapshot(callbacks, id, summary);
          }
          if (diff) {
            this.emitAppServerToolSnapshot(callbacks, id, diff, "diff");
          }
          this.emitAppServerToolEnd(callbacks, id, readString(item?.status) === "failed");
        } else if (type === "mcpToolCall") {
          this.emitAppServerToolStart(callbacks, `mcp:${readString(item?.server) ?? "unknown"}/${readString(item?.tool) ?? "tool"}`, id);
          const error = readRecord(item?.error);
          if (error) {
            this.emitAppServerToolSnapshot(callbacks, id, readString(error?.message) ?? "MCP tool call failed.");
          }
          this.emitAppServerToolEnd(callbacks, id, Boolean(error) || readString(item?.status) === "failed");
        } else if (type === "dynamicToolCall") {
          this.emitAppServerToolStart(callbacks, `dynamic:${readString(item?.namespace) ?? "tool"}/${readString(item?.tool) ?? "call"}`, id);
          this.emitAppServerToolEnd(callbacks, id, readString(item?.status) === "failed" || item?.success === false);
        } else if (type === "contextCompaction") {
          this.emitAppServerToolStart(callbacks, "context_compaction", id);
          this.emitAppServerToolEnd(callbacks, id, false);
        } else {
          const toolName = getCanonicalAppServerToolName(item);
          if (item && toolName) {
            this.emitAppServerToolStart(callbacks, toolName, id);
            const summary = summarizeCanonicalAppServerItem(item);
            if (summary) {
              this.emitAppServerToolSnapshot(callbacks, id, summary);
            }
            this.emitAppServerToolEnd(callbacks, id, isCanonicalAppServerItemError(item));
          } else if (type && !isKnownPassiveAppServerItem(type)) {
            this.appServerClient?.recordUnknownEvent?.("item", type);
          }
        }
        break;
      }
      case "hook/started": {
        const run = readRecord(params?.run);
        const id = readString(run?.id) ?? randomItemId();
        const eventName = readString(run?.eventName) ?? "hook";
        this.emitAppServerToolStart(callbacks, `hook:${eventName}`, `hook-${id}`);
        const statusMessage = readString(run?.statusMessage);
        if (statusMessage) {
          this.emitAppServerToolSnapshot(callbacks, `hook-${id}`, statusMessage);
        }
        break;
      }
      case "hook/completed": {
        const run = readRecord(params?.run);
        const id = readString(run?.id) ?? randomItemId();
        const toolId = `hook-${id}`;
        const eventName = readString(run?.eventName) ?? "hook";
        const status = readString(run?.status);
        this.emitAppServerToolStart(callbacks, `hook:${eventName}`, toolId);
        const statusMessage = readString(run?.statusMessage);
        if (statusMessage) {
          this.emitAppServerToolSnapshot(callbacks, toolId, statusMessage);
        }
        this.emitAppServerToolEnd(callbacks, toolId, status === "failed" || status === "blocked" || status === "stopped");
        break;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        const reviewId = readString(params?.reviewId) ?? randomItemId();
        const toolId = `auto-approval-review-${reviewId}`;
        const review = readRecord(params?.review);
        const status = readString(review?.status) ?? "inProgress";
        const riskLevel = readString(review?.riskLevel);
        this.emitAppServerToolStart(callbacks, "review:auto-approval", toolId);
        this.emitAppServerToolSnapshot(
          callbacks,
          toolId,
          [`status: ${status}`, riskLevel ? `risk: ${riskLevel}` : undefined]
            .filter((value): value is string => Boolean(value))
            .join("\n"),
        );
        if (notification.method === "item/autoApprovalReview/completed") {
          this.emitAppServerToolEnd(
            callbacks,
            toolId,
            status === "denied" || status === "timedOut" || status === "aborted",
          );
        }
        break;
      }
      case "autoApprovalReview/strictReviewRequired": {
        const turnId = readString(params?.turnId) ?? "turn";
        const toolId = `strict-review-${turnId}`;
        this.emitAppServerToolStart(callbacks, "review:strict", toolId);
        this.emitAppServerToolSnapshot(callbacks, toolId, "Codex strict security review required.");
        this.emitAppServerToolEnd(callbacks, toolId, false);
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
        const modelContextWindow = readNumber(usage?.modelContextWindow);
        const activeModel = this.currentModel ?? this.config.codexModel;
        if (modelContextWindow && activeModel) {
          this.appServerModelContextWindow = modelContextWindow;
          this.appServerContextWindowModel = activeModel;
          if (this.contextWindowPendingModel === activeModel) {
            this.contextWindowPendingModel = undefined;
          }
        }
        callbacks.onTurnComplete?.({
          inputTokens: input,
          cachedInputTokens: cached,
          outputTokens: output,
        });
        break;
      }
      case "turn/moderationMetadata":
        break;
      case "turn/completed": {
        const turn = readRecord(params?.turn);
        const status = readString(turn?.status);
        const turnError = readRecord(turn?.error);
        const message = readString(turnError?.message) ?? readString(turnError?.additionalDetails);
        const turnItems = Array.isArray(turn?.items)
          ? turn.items.map(readRecord).filter((item): item is Record<string, unknown> => Boolean(item))
          : [];
        const agentItems = turnItems.filter(
          (item) => readString(item.type) === "agentMessage" && readAgentMessageDelivery(item) !== "async",
        );
        const finalAgentItem =
          agentItems.filter((item) => readString(item.phase) === "final_answer").at(-1)
          ?? agentItems.at(-1);
        if (finalAgentItem) {
          this.emitAppServerAgentSnapshot(
            callbacks,
            readString(finalAgentItem.id) ?? "agent-message",
            readString(finalAgentItem.text) ?? "",
          );
        }
        if ((status === "failed" || status === "interrupted") && message) {
          const id = `app-server-turn-${status}-${Date.now()}`;
          this.emitAppServerToolStart(callbacks, `app_server_turn_${status}`, id);
          callbacks.onToolUpdate(id, message);
          callbacks.onToolEnd(id, status === "failed");
        }
        callbacks.onAgentEnd();
        break;
      }
      case "thread/deleted": {
        if (!notificationThreadId || notificationThreadId === this.currentThreadId) {
          this.currentThreadId = null;
          this.currentProjectId = undefined;
          this.appServerThreadLoaded = false;
          this.appServerCurrentTurnId = null;
          this.appServerToolLifecycles.clear();
          this.appServerAgentMessages.clear();
          this.appServerAsyncAgentMessages.clear();
          this.appServerCompletedAgentMessages.clear();
        }
        break;
      }
      case "thread/compacted":
        callbacks.onContextCompaction?.();
        break;
      case "thread/reverted":
        this.appServerCurrentTurnId = null;
        this.appServerToolLifecycles.clear();
        this.appServerAgentMessages.clear();
        this.appServerAsyncAgentMessages.clear();
        this.appServerCompletedAgentMessages.clear();
        this.lastTurnTokens = undefined;
        this.contextTokensUsed = undefined;
        callbacks.onThreadReverted?.();
        break;
      case "thread/queue/changed":
        break;
      case "thread/archived":
      case "thread/unarchived":
      case "thread/closed":
      case "thread/status/changed":
      case "thread/settings/updated":
      case "thread/name/updated":
      case "project/changed":
      case "turn/diff/updated":
      case "turn/plan/updated":
      case "account/rateLimits/updated":
      case "account/login/completed":
      case "account/updated":
      case "mcp/server/status/updated":
      case "mcpServer/oauthLogin/completed":
      case "mcpServer/startupStatus/updated":
      case "mcpServer/event/stream/notification":
      case "thread/realtime/item/started":
      case "thread/realtime/item/completed":
      case "thread/realtime/item/transcript/delta":
        break;
      case "thread/project/updated": {
        if (!notificationThreadId || notificationThreadId === this.currentThreadId) {
          this.currentProjectId = readString(params?.projectId);
        }
        break;
      }
      case "model/rerouted": {
        const toModel = readString(params?.toModel);
        if (toModel && toModel !== this.currentModel) {
          this.currentModel = toModel;
          this.appServerModelContextWindow = undefined;
          this.appServerContextWindowModel = undefined;
          this.contextTokensUsed = undefined;
          this.contextWindowPendingModel = toModel;
        }
        break;
      }
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
      case "parse/error":
        break;
      default:
        this.appServerClient?.recordUnknownEvent?.("notification", notification.method);
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
    const lifecycleKey = this.getAppServerItemLifecycleKey(toolCallId);
    if (this.appServerToolLifecycles.has(lifecycleKey)) {
      return;
    }
    this.appServerToolLifecycles.set(lifecycleKey, { status: "started", output: "", diff: "" });
    callbacks.onToolStart(toolName, toolCallId);
  }

  private emitAppServerToolDelta(
    callbacks: CodexSessionCallbacks,
    toolCallId: string,
    delta: string,
    kind: "output" | "diff" = "output",
  ): void {
    const state = this.appServerToolLifecycles.get(this.getAppServerItemLifecycleKey(toolCallId));
    if (!state || state.status === "completed" || state.status === "failed" || !delta) {
      return;
    }
    state.status = "streaming";
    state[kind] += delta;
    callbacks.onToolUpdate(toolCallId, delta, { kind });
  }

  private emitAppServerToolSnapshot(
    callbacks: CodexSessionCallbacks,
    toolCallId: string,
    snapshot: string,
    kind: "output" | "diff" = "output",
  ): void {
    const state = this.appServerToolLifecycles.get(this.getAppServerItemLifecycleKey(toolCallId));
    if (!state || state.status === "completed" || state.status === "failed" || !snapshot) {
      return;
    }
    const delta = computeTextDelta(state[kind], snapshot);
    state[kind] = snapshot;
    if (delta) {
      state.status = "streaming";
      callbacks.onToolUpdate(toolCallId, delta, { kind });
    }
  }

  private emitAppServerToolEnd(callbacks: CodexSessionCallbacks, toolCallId: string, isError: boolean): void {
    const state = this.appServerToolLifecycles.get(this.getAppServerItemLifecycleKey(toolCallId));
    if (!state || state.status === "completed" || state.status === "failed") {
      return;
    }
    state.status = isError ? "failed" : "completed";
    callbacks.onToolEnd(toolCallId, isError);
  }

  private emitAppServerAgentDelta(
    callbacks: CodexSessionCallbacks,
    agentMessageId: string,
    delta: string,
    delivery?: "async",
  ): void {
    if (!delta) {
      return;
    }
    const lifecycleKey = this.getAppServerItemLifecycleKey(agentMessageId);
    const previous = this.appServerAgentMessages.get(lifecycleKey);
    this.appServerAgentMessages.set(lifecycleKey, `${previous ?? ""}${delta}`);
    callbacks.onTextDelta(delta, {
      agentMessageId,
      startsNewMessage: previous === undefined,
      ...(delivery ? { delivery } : {}),
    });
  }

  private emitAppServerAgentSnapshot(
    callbacks: CodexSessionCallbacks,
    agentMessageId: string,
    snapshot: string,
    delivery?: "async",
  ): void {
    if (!snapshot) {
      return;
    }
    const lifecycleKey = this.getAppServerItemLifecycleKey(agentMessageId);
    const previous = this.appServerAgentMessages.get(lifecycleKey);
    const delta = previous === undefined ? snapshot : computeTextDelta(previous, snapshot);
    this.appServerAgentMessages.set(lifecycleKey, snapshot);
    if (delta) {
      callbacks.onTextDelta(delta, {
        agentMessageId,
        startsNewMessage: previous === undefined,
        ...(delivery ? { delivery } : {}),
      });
    }
  }

  private getAppServerAgentDelivery(agentMessageId: string): "async" | undefined {
    return this.appServerAsyncAgentMessages.has(this.getAppServerItemLifecycleKey(agentMessageId))
      ? "async"
      : undefined;
  }

  private getAppServerItemLifecycleKey(itemId: string): string {
    return [
      this.currentThreadId ?? "thread",
      this.appServerCurrentTurnId ?? "turn",
      itemId,
    ].join(":");
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

    if (this.contextWindowPendingModel === modelSlug) {
      return undefined;
    }

    const modelRecord = listModels().find((candidate) => candidate.slug === modelSlug);
    const hasAppServerWindow = this.appServerContextWindowModel === modelSlug && Boolean(this.appServerModelContextWindow);
    const rawLimit = hasAppServerWindow
      ? this.appServerModelContextWindow
      : modelRecord?.contextWindow ?? modelRecord?.maxContextWindow;
    if (!rawLimit) {
      return undefined;
    }

    const percent = hasAppServerWindow ? 100 : modelRecord?.effectiveContextWindowPercent ?? 100;
    const effectiveLimit = Math.floor(rawLimit * (percent / 100));
    const rawUsed = hasAppServerWindow || !this.config.enableCodexAppServerRuntime
      ? this.contextTokensUsed ?? this.lastTurnTokens?.input
      : undefined;
    const used = rawUsed !== undefined && rawUsed <= effectiveLimit ? rawUsed : undefined;
    const remaining = used === undefined ? undefined : Math.max(0, effectiveLimit - used);
    const percentUsed = used === undefined ? undefined : Math.round((used / effectiveLimit) * 100);

    return {
      model: modelSlug,
      limit: rawLimit,
      effectiveLimit,
      source: hasAppServerWindow ? "app-server" : "model-cache",
      used,
      remaining,
      percentUsed,
    };
  }
}

function toTurnRecoveryItem(
  item: Record<string, unknown>,
  index: number,
  turnId: string | undefined,
): CodexTurnRecoveryItem | undefined {
  const type = readString(item.type);
  const id = readString(item.id) ?? `${turnId ?? "turn"}:${index}:${type ?? "item"}`;

  if (type === "agentMessage") {
    const text = readString(item.text)?.trim();
    const delivery = readAgentMessageDelivery(item);
    return text ? { id, kind: "response", text, ...(delivery ? { delivery } : {}) } : undefined;
  }

  if (type === "commandExecution") {
    return {
      id,
      kind: "tool",
      toolName: getCommandExecutionToolName(item),
      detail: trimRecoveryDetail(readString(item.aggregatedOutput) ?? ""),
      isError: readString(item.status) === "failed",
    };
  }

  if (type === "fileChange") {
    return {
      id,
      kind: "tool",
      toolName: "file_change",
      detail: trimRecoveryDetail(summarizeAppServerFileChange(item)),
      isError: readString(item.status) === "failed",
    };
  }

  if (type === "mcpToolCall") {
    const error = readRecord(item.error);
    return {
      id,
      kind: "tool",
      toolName: `mcp:${readString(item.server) ?? "unknown"}/${readString(item.tool) ?? "tool"}`,
      detail: trimRecoveryDetail(readString(error?.message) ?? ""),
      isError: Boolean(error) || readString(item.status) === "failed",
    };
  }

  if (type === "dynamicToolCall") {
    return {
      id,
      kind: "tool",
      toolName: `dynamic:${readString(item.namespace) ?? "tool"}/${readString(item.tool) ?? "call"}`,
      detail: "",
      isError: readString(item.status) === "failed" || item.success === false,
    };
  }

  if (type === "contextCompaction") {
    return { id, kind: "tool", toolName: "context_compaction", detail: "", isError: false };
  }

  const toolName = getCanonicalAppServerToolName(item);
  if (!toolName) {
    return undefined;
  }
  return {
    id,
    kind: "tool",
    toolName,
    detail: trimRecoveryDetail(summarizeCanonicalAppServerItem(item) ?? ""),
    isError: isCanonicalAppServerItemError(item),
  };
}

function readAgentMessageDelivery(item: Record<string, unknown> | undefined): "async" | undefined {
  return readString(item?.delivery) === "async" ? "async" : undefined;
}

function trimRecoveryDetail(value: string): string {
  const limit = 6000;
  return value.length > limit ? `${value.slice(0, limit)}\n...truncated` : value;
}

function selectRecoveryTurn(
  turns: Record<string, unknown>[],
  turnId: string | undefined,
  newestFirst: boolean,
): Record<string, unknown> | undefined {
  if (turnId) return turns.find((turn) => readString(turn.id) === turnId);
  return newestFirst ? turns[0] : turns.at(-1);
}

function readThreadHistoryMode(value: unknown): CodexThreadHistoryMode | undefined {
  return value === "legacy" || value === "paginated" ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readMcpServerRuntimeStatus(value: unknown): CodexMcpServerRuntimeStatus {
  switch (value) {
    case "notStarted":
    case "starting":
    case "connected":
    case "authenticationRequired":
    case "failed":
    case "cancelled":
    case "disabled":
      return value;
    default:
      return "unknown";
  }
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

function getCanonicalAppServerToolName(item: Record<string, unknown> | undefined): string | undefined {
  const type = readString(item?.type);
  if (type === "collabAgentToolCall") {
    return `subagent:${readString(item?.tool) ?? "collaboration"}`;
  }
  if (type === "subAgentActivity") {
    return `subagent:${readString(item?.kind) ?? "activity"}`;
  }
  if (type === "webSearch") {
    return `web:${readString(item?.query) ?? "search"}`;
  }
  if (type === "imageView") {
    return "view_image";
  }
  if (type === "imageGeneration") {
    return "image_generation";
  }
  if (type === "sleep") {
    return "sleep";
  }
  if (type === "enteredReviewMode") {
    return "review:entered";
  }
  if (type === "exitedReviewMode") {
    return "review:exited";
  }
  if (type === "hookPrompt") {
    return "hook:prompt";
  }
  return undefined;
}

function getCommandExecutionToolName(item: Record<string, unknown> | undefined): string {
  const pluginId = readString(item?.pluginId);
  if (pluginId) {
    const scriptPath = readString(item?.scriptPath);
    return `plugin:${pluginId}/${scriptPath ?? "command"}`;
  }
  return readString(item?.command) ?? "shell";
}

function summarizeCanonicalAppServerItem(item: Record<string, unknown>): string | undefined {
  const type = readString(item.type);
  if (type === "collabAgentToolCall") {
    const receivers = readStringArray(item.receiverThreadIds);
    const states = readRecord(item.agentsStates);
    const stateSummary = states
      ? Object.entries(states)
          .map(([threadId, value]) => {
            const status = readString(readRecord(value)?.status);
            return status ? `${threadId}: ${status}` : undefined;
          })
          .filter((value): value is string => Boolean(value))
          .join("\n")
      : "";
    return [receivers.length > 0 ? `targets: ${receivers.join(", ")}` : undefined, stateSummary || undefined]
      .filter((value): value is string => Boolean(value))
      .join("\n") || undefined;
  }
  if (type === "subAgentActivity") {
    const threadId = readString(item.agentThreadId);
    const kind = readString(item.kind);
    return [threadId ? `agent: ${threadId}` : undefined, kind ? `activity: ${kind}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join("\n") || undefined;
  }
  if (type === "webSearch") {
    return readString(item.query);
  }
  if (type === "sleep") {
    const durationMs = readNumber(item.durationMs);
    return durationMs === undefined ? undefined : `duration: ${durationMs}ms`;
  }
  if (type === "imageView") {
    return readString(item.path);
  }
  return undefined;
}

function isCanonicalAppServerItemError(item: Record<string, unknown>): boolean {
  const status = readString(item.status);
  return status === "failed" || status === "declined" || readString(item.kind) === "interrupted";
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

function parseThreadUsageStatus(value: unknown): CodexStatusDetails["threadUsage"] | undefined {
  const threadUsage = readRecord(readRecord(value)?.threadUsage);
  const estimatedCreditsMicros = readNumber(threadUsage?.estimatedUsageCreditsMicros);
  if (estimatedCreditsMicros === undefined) {
    return undefined;
  }
  const estimatedUsdMicros = readNumber(threadUsage?.estimatedUsageUsdMicros);
  return {
    estimatedCredits: estimatedCreditsMicros / 1_000_000,
    ...(estimatedUsdMicros === undefined ? {} : { estimatedUsd: estimatedUsdMicros / 1_000_000 }),
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

function summarizeApprovalPolicy(value: unknown): string | undefined {
  return readString(value) ?? summarizeUnknownValue(value);
}

function summarizeSandboxPolicy(value: unknown): string | undefined {
  const type = readString(readRecord(value)?.type);
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "readOnly") return "read-only";
  if (type === "workspaceWrite") return "workspace-write";
  if (type === "externalSandbox") return "external-sandbox";
  return type;
}

function parseQueuedPrompt(value: unknown): CodexQueuedPrompt | undefined {
  const record = readRecord(value);
  const id = readString(record?.id);
  const clientUserMessageId = readString(record?.clientUserMessageId);
  if (!id || !clientUserMessageId) {
    return undefined;
  }
  const input = Array.isArray(record?.input) ? record.input : [];
  const summary = input
    .map((entry) => {
      const item = readRecord(entry);
      const type = readString(item?.type);
      if (type === "text") return readString(item?.text) ?? "";
      if (type === "localImage" || type === "image") return "[image]";
      return type ? `[${type}]` : "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    id,
    clientUserMessageId,
    summary: summary.length > 120 ? `${summary.slice(0, 119)}…` : summary || "(empty prompt)",
  };
}

function summarizeAppServerFileChange(item: Record<string, unknown> | undefined): string {
  if (!item) {
    return "";
  }

  const lines = new Set<string>();
  collectFileChangeEntries(lines, item.changes);
  collectFileChangeEntries(lines, item.files);
  collectFileChangeEntries(lines, item.fileChanges);
  collectFileChangeEntries(lines, item.edits);
  collectFileChangeEntries(lines, item.operations);
  collectFileChangeEntries(lines, item.modifiedFiles, "update");
  collectFileChangeEntries(lines, item.createdFiles, "add");
  collectFileChangeEntries(lines, item.deletedFiles, "remove");

  const summary =
    readString(item.summary) ??
    readString(item.description) ??
    readString(item.message) ??
    readString(item.aggregatedOutput) ??
    readString(item.output);
  if (summary) {
    addFileChangeSummaryText(lines, summary);
  }

  return [...lines].slice(0, 12).join("\n");
}

function summarizeAppServerFileChangeDiff(item: Record<string, unknown> | undefined): string {
  if (!item) {
    return "";
  }

  const diff =
    readString(item.diff) ??
    readString(item.patch) ??
    readString(item.unifiedDiff) ??
    readString(item.diffPreview) ??
    collectNestedFileChangeDiff(item.changes) ??
    collectNestedFileChangeDiff(item.files) ??
    collectNestedFileChangeDiff(item.fileChanges) ??
    collectNestedFileChangeDiff(item.edits) ??
    collectNestedFileChangeDiff(item.operations);
  return diff ? limitFileChangeDiffPreview(diff) : "";
}

function collectNestedFileChangeDiff(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return looksLikeDiff(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const diff = collectNestedFileChangeDiff(entry);
      if (diff) {
        return diff;
      }
    }
    return undefined;
  }

  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  return (
    readString(record.diff) ??
    readString(record.patch) ??
    readString(record.unifiedDiff) ??
    readString(record.diffPreview) ??
    collectNestedFileChangeDiff(record.changes) ??
    collectNestedFileChangeDiff(record.files) ??
    collectNestedFileChangeDiff(record.fileChanges) ??
    collectNestedFileChangeDiff(record.edits)
  );
}

function collectFileChangeEntries(lines: Set<string>, value: unknown, defaultKind = ""): void {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    const line = defaultKind ? `${defaultKind} ${value}` : value;
    addFileChangeSummaryText(lines, line);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFileChangeEntries(lines, entry, defaultKind);
    }
    return;
  }

  const record = readRecord(value);
  if (!record) {
    return;
  }

  const line = formatFileChangeRecord(record, defaultKind);
  if (line) {
    lines.add(line);
    return;
  }

  collectFileChangeEntries(lines, record.changes);
  collectFileChangeEntries(lines, record.files);
  collectFileChangeEntries(lines, record.fileChanges);
  collectFileChangeEntries(lines, record.edits);
  collectFileChangeEntries(lines, record.operations);
}

function formatFileChangeRecord(record: Record<string, unknown>, defaultKind = ""): string {
  const path =
    readString(record.path) ??
    readString(record.filePath) ??
    readString(record.relativePath) ??
    readString(record.name);
  if (path) {
    const kind =
      readString(record.kind) ??
      readString(record.action) ??
      readString(record.changeType) ??
      readString(record.status) ??
      readString(record.type) ??
      defaultKind;
    return [normalizeFileChangeKind(kind), path].filter(Boolean).join(" ");
  }

  const summary = readString(record.summary) ?? readString(record.message) ?? readString(record.description);
  return summary ? sanitizeFileChangeSummaryLine(summary) : "";
}

function addFileChangeSummaryText(lines: Set<string>, text: string): void {
  for (const rawLine of text.split("\n")) {
    const line = sanitizeFileChangeSummaryLine(rawLine);
    if (line) {
      lines.add(line);
    }
    if (lines.size >= 12) {
      return;
    }
  }
}

function sanitizeFileChangeSummaryLine(line: string): string {
  const trimmed = line.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed === "workspace edits") {
    return "";
  }
  if (trimmed.startsWith("@@") || trimmed.startsWith("diff --git")) {
    return "";
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function normalizeFileChangeKind(kind: string | undefined): string {
  const normalized = kind?.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "modify" || normalized === "modified") {
    return "update";
  }
  if (normalized === "create" || normalized === "created") {
    return "add";
  }
  if (normalized === "delete" || normalized === "deleted") {
    return "remove";
  }
  return normalized;
}

function limitFileChangeDiffPreview(diff: string): string {
  const normalized = diff.replace(/\r\n?/g, "\n").trim();
  if (!normalized || !looksLikeDiff(normalized)) {
    return "";
  }

  const maxLines = 160;
  const maxChars = 3500;
  const lines = normalized.split("\n");
  let preview = lines.slice(0, maxLines).join("\n");
  const omittedLines = Math.max(0, lines.length - maxLines);
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars).trimEnd()}\n... truncated by character limit ...`;
  } else if (omittedLines > 0) {
    preview = `${preview}\n... ${omittedLines} more lines omitted ...`;
  }
  return preview;
}

function looksLikeDiff(text: string): boolean {
  return /(^diff --git|^@@\\s|^---\\s|^\\+\\+\\+\\s|^[+-][^+-])/m.test(text);
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

function isCodexMinorAtLeast(version: string, minimumMinor: number): boolean {
  const match = /^(?:codex-cli\s+)?0\.(\d+)\./.exec(version);
  return Boolean(match && Number(match[1]) >= minimumMinor);
}

function assertWorkspaceAvailable(workspace: string): void {
  const availability = inspectWorkspace(workspace);
  if (!availability.available) {
    throw new Error(`Workspace unavailable (${availability.reason}): ${workspace}`);
  }
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

function isKnownPassiveAppServerItem(type: string): boolean {
  return ["agentMessage", "userMessage", "plan", "reasoning"].includes(type);
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

function isUnsupportedAppServerRequest(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes(method.toLowerCase()) && (
    normalized.includes("unsupported") ||
    normalized.includes("not supported") ||
    normalized.includes("unknown method") ||
    normalized.includes("method not found")
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
