import { vi } from "vitest";

import { createDefaultLaunchProfile, createLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";

const mockCodexState = vi.hoisted(() => {
  const getThread = vi.fn();
  const listThreads = vi.fn().mockReturnValue([]);
  const listWorkspaces = vi.fn().mockReturnValue([]);
  const listModels = vi.fn().mockReturnValue([]);

  return {
    getThread,
    listThreads,
    listWorkspaces,
    listModels,
    reset: () => {
      getThread.mockReset();
      getThread.mockReturnValue(null);
      listThreads.mockReset();
      listThreads.mockReturnValue([]);
      listWorkspaces.mockReset();
      listWorkspaces.mockReturnValue([]);
      listModels.mockReset();
      listModels.mockReturnValue([]);
    },
  };
});

const mockState = vi.hoisted(() => {
  const createdCodexOptions: any[] = [];
  const codexInstances: any[] = [];
  const createdThreads: any[] = [];

  const createEmptyEvents = () =>
    (async function* () {
      // empty
    })();

  const createThread = (id: string | null, options: any) => {
    const thread = {
      id,
      options,
      runStreamed: vi.fn().mockResolvedValue({ events: createEmptyEvents() }),
    };
    createdThreads.push(thread);
    return thread;
  };

  const Codex = vi.fn().mockImplementation(function (options: any) {
    createdCodexOptions.push(options);

    const instance = {
      startThread: vi.fn().mockImplementation((threadOptions: any) => createThread(null, threadOptions)),
      resumeThread: vi
        .fn()
        .mockImplementation((threadId: string, threadOptions: any) => createThread(threadId, threadOptions)),
    };

    codexInstances.push(instance);
    return instance;
  });

  return {
    Codex,
    createdCodexOptions,
    codexInstances,
    createdThreads,
    reset: () => {
      createdCodexOptions.length = 0;
      codexInstances.length = 0;
      createdThreads.length = 0;
      Codex.mockClear();
    },
  };
});

const mockAppServerState = vi.hoisted(() => {
  let notifications: Array<{ method: string; params?: unknown }> = [];

  const CodexAppServerClient = vi.fn().mockImplementation(function () {
    const listeners = new Set<(notification: { method: string; params?: unknown }) => void>();
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockReturnValue(true),
      getNotifications: vi.fn().mockReturnValue([]),
      getClosedReason: vi.fn().mockReturnValue(undefined),
      close: vi.fn(),
      onNotification: vi.fn((listener: (notification: { method: string; params?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      request: vi.fn().mockImplementation(async (method: string) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-app-server" } };
        }
        if (method === "turn/start") {
          setTimeout(() => {
            for (const notification of notifications) {
              for (const listener of [...listeners]) {
                listener(notification);
              }
            }
          }, 0);
          return { turn: { id: "turn-app-server" } };
        }
        throw new Error(`Unexpected app-server request: ${method}`);
      }),
    };
    return client;
  });

  return {
    CodexAppServerClient,
    setNotifications: (next: Array<{ method: string; params?: unknown }>) => {
      notifications = next;
    },
    reset: () => {
      notifications = [];
      CodexAppServerClient.mockClear();
    },
  };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: mockState.Codex,
}));

vi.mock("../src/codex-app-server-client.js", () => ({
  CodexAppServerClient: mockAppServerState.CodexAppServerClient,
}));

vi.mock("../src/codex-state.js", () => ({
  getThread: mockCodexState.getThread,
  listThreads: mockCodexState.listThreads,
  listWorkspaces: mockCodexState.listWorkspaces,
  listModels: mockCodexState.listModels,
}));

import { CodexSessionService } from "../src/codex-session.js";

describe("CodexSessionService", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  };

  const createConfig = (overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "o3",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [
      createDefaultLaunchProfile("workspace-write", "never"),
      createLaunchProfile({
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    ...overrides,
  });

  const createCallbacks = () => ({
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    onTodoUpdate: vi.fn(),
    onTurnComplete: vi.fn(),
  });

  const streamEvents = (events: any[]) =>
    (async function* () {
      for (const event of events) {
        yield event;
      }
    })();

  beforeEach(() => {
    mockState.reset();
    mockCodexState.reset();
    mockAppServerState.reset();
  });

  const completedAppServerTurn = {
    method: "turn/completed",
    params: {
      threadId: "thread-app-server",
      turn: { id: "turn-app-server", status: "completed" },
    },
  };

  const createAppServerService = () =>
    CodexSessionService.create(createConfig({ enableCodexAppServerRuntime: true }));

  it("creates the service and starts an initial thread", async () => {
    const service = await CodexSessionService.create(createConfig());

    expect(mockState.Codex).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "codex-key",
        config: { approval_policy: "never" },
        env: expect.objectContaining({ CODEX_API_KEY: "codex-key" }),
      }),
    );

    const codexInstance = mockState.codexInstances[0];
    expect(codexInstance.startThread).toHaveBeenCalledWith({
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });

    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("create accepts overrides for workspace, model, reasoning effort, launch profile, and resumeThreadId", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      workspace: "/workspace/resumed",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      resumeThreadId: "thread-resume",
    });

    const codexInstance = mockState.codexInstances[0];
    expect(codexInstance.startThread).toHaveBeenCalledTimes(0);
    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-resume", {
      model: "gpt-5.4",
      sandboxMode: "read-only",
      workingDirectory: "/workspace/resumed",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
    });
    expect(service.getInfo()).toEqual({
      threadId: "thread-resume",
      workspace: "/workspace/resumed",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("can defer thread creation so launch settings apply before the first thread starts", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      deferThreadStart: true,
    });

    expect(mockState.codexInstances[0].startThread).toHaveBeenCalledTimes(0);
    expect(service.hasActiveThread()).toBe(false);

    service.setLaunchProfile("readonly");
    await service.newThread();

    expect(mockState.createdThreads[0].options.sandboxMode).toBe("read-only");
  });

  it("setLaunchProfile applies to newly created threads without mutating the existing thread", async () => {
    const service = await CodexSessionService.create(createConfig());
    const firstThread = mockState.createdThreads[0];

    const profile = service.setLaunchProfile("readonly");
    expect(profile.label).toBe("Read Only");
    expect(firstThread.options.sandboxMode).toBe("workspace-write");

    await service.newThread();

    const secondThread = mockState.createdThreads[1];
    expect(secondThread.options.sandboxMode).toBe("read-only");
    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("reports the active thread launch mode separately from the next selected launch profile", async () => {
    const service = await CodexSessionService.create(createConfig());

    service.setLaunchProfile("readonly");

    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
      nextLaunchProfileId: "readonly",
      nextLaunchProfileLabel: "Read Only",
      nextLaunchProfileBehavior: "read-only / never",
      nextUnsafeLaunch: false,
    });
  });

  it("translates agent_message events into text deltas", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        { type: "thread.started", thread_id: "thread-123" },
        { type: "item.started", item: { id: "msg-1", type: "agent_message", text: "Hel" } },
        { type: "item.updated", item: { id: "msg-1", type: "agent_message", text: "Hello" } },
        { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "Hello world" } },
        { type: "turn.completed", usage },
      ]),
    });

    await service.prompt("hello", callbacks);

    expect(callbacks.onTextDelta.mock.calls.map(([delta]) => delta)).toEqual(["Hel", "lo", " world"]);
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(service.getInfo().threadId).toBe("thread-123");
  });

  it("maps command_execution events to tool callbacks", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.updated",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "file-a\nfile-b",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "file-a\nfile-b",
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
    });

    await service.prompt("list files", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("ls -la", "cmd-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("cmd-1", "file-a\nfile-b");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-1", false);
    expect(callbacks.onToolUpdate).toHaveBeenCalledTimes(1);
  });

  it("maps web_search events to tool callbacks", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "search-1",
            type: "web_search",
            query: "latest TypeScript release notes",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "search-1",
            type: "web_search",
            query: "latest TypeScript release notes",
          },
        },
      ]),
    });

    await service.prompt("search", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("🔍 latest TypeScript release notes", "search-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("search-1", "latest TypeScript release notes");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("search-1", false);
  });

  it("surfaces error items as failed tool events", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.completed",
          item: {
            id: "error-1",
            type: "error",
            message: "tool failed but the stream continued",
          },
        },
      ]),
    });

    await service.prompt("continue", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("⚠️ error", "error-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("error-1", "tool failed but the stream continued");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("error-1", true);
  });

  it("emits todo list updates for started, updated, and completed items", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();
    const startedItems = [{ text: "Inspect repo", completed: false }];
    const updatedItems = [
      { text: "Inspect repo", completed: true },
      { text: "Write tests", completed: false },
    ];
    const completedItems = [
      { text: "Inspect repo", completed: true },
      { text: "Write tests", completed: true },
    ];

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: { id: "todo-1", type: "todo_list", items: startedItems },
        },
        {
          type: "item.updated",
          item: { id: "todo-1", type: "todo_list", items: updatedItems },
        },
        {
          type: "item.completed",
          item: { id: "todo-1", type: "todo_list", items: completedItems },
        },
      ]),
    });

    await service.prompt("plan", callbacks);

    expect(callbacks.onTodoUpdate.mock.calls).toEqual([[startedItems], [updatedItems], [completedItems]]);
  });

  it("passes only the new output delta across multiple item.updated events (no duplication)", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.updated",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "compiling...\n",
            status: "in_progress",
          },
        },
        {
          type: "item.updated",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "compiling...\nlinking...\n",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "compiling...\nlinking...\ndone\n",
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
    });

    await service.prompt("build", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("make build", "cmd-2");
    expect(callbacks.onToolUpdate.mock.calls).toEqual([
      ["cmd-2", "compiling...\n"],
      ["cmd-2", "linking...\n"],
      ["cmd-2", "done\n"],
    ]);
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-2", false);
  });

  it("emits output via onToolUpdate when output only arrives in item.completed (fast command)", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "cmd-3",
            type: "command_execution",
            command: "echo hi",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-3",
            type: "command_execution",
            command: "echo hi",
            aggregated_output: "hi\n",
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
    });

    await service.prompt("greet", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("echo hi", "cmd-3");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("cmd-3", "hi\n");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-3", false);
  });

  it("deduplicates canonical app-server command deltas against the completion snapshot", async () => {
    const service = await createAppServerService();
    const callbacks = createCallbacks();
    mockAppServerState.setNotifications([
      {
        method: "item/started",
        params: {
          threadId: "thread-app-server",
          item: { id: "canonical-command", type: "commandExecution", command: "printf output" },
        },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread-app-server", itemId: "canonical-command", delta: "first\n" },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-app-server",
          item: {
            id: "canonical-command",
            type: "commandExecution",
            command: "printf output",
            aggregatedOutput: "first\nsecond\n",
            status: "completed",
          },
        },
      },
      completedAppServerTurn,
    ]);

    await service.prompt("run command", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolStart).toHaveBeenCalledWith("printf output", "canonical-command");
    expect(callbacks.onToolUpdate.mock.calls).toEqual([
      ["canonical-command", "first\n", { kind: "output" }],
      ["canonical-command", "second\n", { kind: "output" }],
    ]);
    expect(callbacks.onToolEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("canonical-command", false);
  });

  it("keeps context usage pending until the selected model reports a fresh app-server window", async () => {
    const service = await createAppServerService();
    const callbacks = createCallbacks();
    expect(service.getInfo()).toMatchObject({ model: "o3", contextWindowPending: true });

    mockAppServerState.setNotifications([
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-app-server",
          turnId: "turn-app-server",
          tokenUsage: {
            last: { inputTokens: 20_000, cachedInputTokens: 10_000, outputTokens: 100 },
            total: { inputTokens: 20_000, cachedInputTokens: 10_000, outputTokens: 100 },
            modelContextWindow: 100_000,
          },
        },
      },
      completedAppServerTurn,
    ]);
    await service.prompt("model a turn", callbacks);
    expect(service.getInfo()).toMatchObject({
      model: "o3",
      contextWindow: {
        model: "o3",
        limit: 100_000,
        effectiveLimit: 100_000,
        source: "app-server",
        used: 20_000,
        remaining: 80_000,
        percentUsed: 20,
      },
    });

    service.setModel("o4-mini");
    expect(service.getInfo()).toMatchObject({
      model: "o4-mini",
      contextWindowPending: true,
      lastTurnTokens: { input: 20_000, cached: 10_000, output: 100 },
    });
    expect(service.getInfo().contextWindow).toBeUndefined();

    mockAppServerState.setNotifications([
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-app-server",
          turnId: "turn-app-server",
          tokenUsage: {
            last: { inputTokens: 50_000, cachedInputTokens: 40_000, outputTokens: 200 },
            total: { inputTokens: 70_000, cachedInputTokens: 50_000, outputTokens: 300 },
            modelContextWindow: 200_000,
          },
        },
      },
      completedAppServerTurn,
    ]);
    await service.prompt("model b turn", callbacks);
    expect(service.getInfo()).toMatchObject({
      model: "o4-mini",
      contextWindow: {
        model: "o4-mini",
        limit: 200_000,
        effectiveLimit: 200_000,
        source: "app-server",
        used: 50_000,
        remaining: 150_000,
        percentUsed: 25,
      },
    });
    expect(service.getInfo().contextWindowPending).toBeUndefined();
  });

  it("renders a canonical app-server completion without prior start or delta notifications", async () => {
    const service = await createAppServerService();
    const callbacks = createCallbacks();
    mockAppServerState.setNotifications([
      {
        method: "item/completed",
        params: {
          threadId: "thread-app-server",
          item: {
            id: "completion-only",
            type: "commandExecution",
            command: "echo ready",
            aggregatedOutput: "ready\n",
            status: "completed",
          },
        },
      },
      completedAppServerTurn,
    ]);

    await service.prompt("fast command", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("echo ready", "completion-only");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("completion-only", "ready\n", { kind: "output" });
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("completion-only", false);
  });

  it("ignores duplicated canonical completion replay for the same item id", async () => {
    const service = await createAppServerService();
    const callbacks = createCallbacks();
    const completion = {
      method: "item/completed",
      params: {
        threadId: "thread-app-server",
        item: {
          id: "replayed-command",
          type: "commandExecution",
          command: "echo once",
          aggregatedOutput: "once\n",
          status: "completed",
        },
      },
    };
    mockAppServerState.setNotifications([completion, completion, completedAppServerTurn]);

    await service.prompt("replay command", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown canonical item types without failing the turn or exposing their payload", async () => {
    const service = await createAppServerService();
    const callbacks = createCallbacks();
    mockAppServerState.setNotifications([
      {
        method: "item/started",
        params: {
          threadId: "thread-app-server",
          item: { id: "future-item", type: "futureSensitiveItem", secret: "must-not-be-rendered" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-app-server",
          item: { id: "future-item", type: "futureSensitiveItem", secret: "must-not-be-rendered" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-owned-by-another-instance",
          item: {
            id: "foreign-command",
            type: "commandExecution",
            command: "must not run",
            aggregatedOutput: "must not render",
            status: "completed",
          },
        },
      },
      completedAppServerTurn,
    ]);

    await expect(service.prompt("future event", callbacks)).resolves.toBeUndefined();
    expect(callbacks.onToolStart).not.toHaveBeenCalled();
    expect(callbacks.onToolUpdate).not.toHaveBeenCalled();
    expect(callbacks.onToolEnd).not.toHaveBeenCalled();
  });

  it("releases canonical item lifecycle state between app-server turns", async () => {
    const service = await createAppServerService();
    const callbacks = createCallbacks();
    const completion = {
      method: "item/completed",
      params: {
        threadId: "thread-app-server",
        item: {
          id: "reused-item-id",
          type: "commandExecution",
          command: "echo reusable",
          aggregatedOutput: "reusable\n",
          status: "completed",
        },
      },
    };

    mockAppServerState.setNotifications([completion, completedAppServerTurn]);
    await service.prompt("first turn", callbacks);
    mockAppServerState.setNotifications([completion, completedAppServerTurn]);
    await service.prompt("second turn", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledTimes(2);
    expect(callbacks.onToolUpdate).toHaveBeenCalledTimes(2);
    expect(callbacks.onToolEnd).toHaveBeenCalledTimes(2);
  });

  it("synthesizes tool events for file changes", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.completed",
          item: {
            id: "patch-1",
            type: "file_change",
            changes: [
              { kind: "add", path: "src/new.ts" },
              { kind: "update", path: "README.md" },
            ],
            diff: "diff --git a/src/new.ts b/src/new.ts\n@@\n+export const value = 1;\n",
            status: "completed",
          },
        },
      ]),
    });

    await service.prompt("edit files", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("file_change", "patch-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("patch-1", "add src/new.ts, update README.md");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith(
      "patch-1",
      "diff --git a/src/new.ts b/src/new.ts\n@@\n+export const value = 1;",
      { kind: "diff" },
    );
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("patch-1", false);
  });

  it("triggers onAgentEnd when the turn completes", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([{ type: "turn.completed", usage }]),
    });

    await service.prompt("done?", callbacks);

    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("reports per-turn token usage and accumulates session totals", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const firstCallbacks = createCallbacks();
    const secondCallbacks = createCallbacks();
    const firstUsage = {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
    };
    const secondUsage = {
      input_tokens: 5,
      cached_input_tokens: 2,
      output_tokens: 13,
    };

    thread.runStreamed
      .mockResolvedValueOnce({ events: streamEvents([{ type: "turn.completed", usage: firstUsage }]) })
      .mockResolvedValueOnce({ events: streamEvents([{ type: "turn.completed", usage: secondUsage }]) });

    await service.prompt("first", firstCallbacks);
    await service.prompt("second", secondCallbacks);

    expect(firstCallbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(firstCallbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 7,
    });
    expect(secondCallbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(secondCallbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 13,
    });
    expect(service.getInfo().sessionTokens).toEqual({
      input: 16,
      cached: 5,
      output: 20,
    });
  });

  it("throws when the turn fails", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([{ type: "turn.failed", error: { message: "boom" } }]),
    });

    await expect(service.prompt("fail", callbacks)).rejects.toThrow("boom");
  });

  it("aborts an in-flight turn via AbortController", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    let release!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    thread.runStreamed.mockImplementationOnce(async (_input: string, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return {
        events: (async function* () {
          await blocker;
          if (capturedSignal?.aborted) {
            throw new Error("aborted");
          }
          yield { type: "turn.completed", usage };
        })(),
      };
    });

    const promptPromise = service.prompt("stop", callbacks);
    await Promise.resolve();

    expect(service.isProcessing()).toBe(true);

    await service.abort();

    expect(capturedSignal?.aborted).toBe(true);

    release();

    await expect(promptPromise).rejects.toThrow("aborted");
    expect(service.isProcessing()).toBe(false);
  });

  it("creates a new thread in a different workspace", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.newThread("/workspace/other");

    expect(codexInstance.startThread).toHaveBeenCalledTimes(2);
    expect(codexInstance.startThread).toHaveBeenLastCalledWith({
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/other",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info).toEqual({
      threadId: null,
      workspace: "/workspace/other",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    expect(service.getCurrentWorkspace()).toBe("/workspace/other");
  });

  it("resumes a thread by id", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.resumeThread("thread-999");

    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-999", {
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info).toEqual({
      threadId: "thread-999",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("switchSession looks up workspace and model from codex state", async () => {
    mockCodexState.getThread.mockReturnValue({
      id: "thread-abc",
      title: "Saved thread",
      cwd: "/workspace/from-db",
      model: "gpt-5.4-mini",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      firstUserMessage: "hello",
    });

    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.switchSession("thread-abc");

    expect(mockCodexState.getThread).toHaveBeenCalledWith("thread-abc");
    expect(codexInstance.resumeThread).toHaveBeenLastCalledWith("thread-abc", {
      model: "gpt-5.4-mini",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/from-db",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info).toEqual({
      threadId: "thread-abc",
      workspace: "/workspace/from-db",
      model: "gpt-5.4-mini",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("switchSession throws when a turn is in progress", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    thread.runStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        await blocker;
      })(),
    }));

    const promptPromise = service.prompt("busy", callbacks);
    await Promise.resolve();

    await expect(service.switchSession("thread-busy")).rejects.toThrow(
      "Cannot switch session while a turn is in progress",
    );

    await service.abort();
    release();
    await promptPromise.catch(() => {});
  });

  it("newThread accepts an explicit model override and updates getInfo", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.newThread(undefined, "gpt-5.4");

    expect(codexInstance.startThread).toHaveBeenLastCalledWith({
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info.model).toBe("gpt-5.4");
    expect(service.getInfo().model).toBe("gpt-5.4");
  });

  it("setReasoningEffort stores the effort and applies it to new threads", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    service.setReasoningEffort("high");
    expect(service.getInfo().reasoningEffort).toBe("high");

    await service.newThread();

    expect(codexInstance.startThread).toHaveBeenLastCalledWith({
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
    });
  });

  it("setModel updates the tracked model returned by getInfo", async () => {
    const service = await CodexSessionService.create(createConfig());

    expect(service.setModel("o4-mini")).toBe("o4-mini");
    expect(service.getInfo().model).toBe("o4-mini");
  });

  it("passes text plus image inputs through to the SDK", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt({ text: "describe this", imagePaths: ["/tmp/img.png"] }, callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      [
        { type: "text", text: "describe this" },
        { type: "local_image", path: "/tmp/img.png" },
      ],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("prepends staged file instructions to the SDK input text", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt(
      { text: "analyze this", stagedFileInstructions: "Files staged at /inbox:\n- log.txt" },
      callbacks,
    );

    expect(thread.runStreamed).toHaveBeenCalledWith(
      "Files staged at /inbox:\n- log.txt\n\nanalyze this",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends only staged file instructions when no user text", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt({ stagedFileInstructions: "Files staged at /inbox:\n- log.txt" }, callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      "Files staged at /inbox:\n- log.txt",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("passes image-only inputs through to the SDK", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt({ imagePaths: ["/tmp/img.png"] }, callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      [{ type: "local_image", path: "/tmp/img.png" }],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps string inputs unchanged when calling the SDK", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt("hello", callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith("hello", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("prepends restrict safety instructions for restrict launch profiles", async () => {
    const service = await CodexSessionService.create(
      createConfig({
        launchProfiles: [
          createLaunchProfile({
            id: "restrict",
            label: "Restrict",
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            safetyPolicy: "restrict",
          }),
        ],
        defaultLaunchProfileId: "restrict",
      }),
    );
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt("delete logs", callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      expect.stringContaining("TeleCodex launch safety policy: restrict."),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(thread.runStreamed.mock.calls[0]?.[0]).toContain("delete logs");
    expect(thread.runStreamed.mock.calls[0]?.[0]).toContain("Do not run root or sudo commands");
  });

  it("prepends full safety instructions for full launch profiles", async () => {
    const service = await CodexSessionService.create(
      createConfig({
        launchProfiles: [
          createLaunchProfile({
            id: "full",
            label: "Full",
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            safetyPolicy: "full",
          }),
        ],
        defaultLaunchProfileId: "full",
      }),
    );
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt("install package", callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      expect.stringContaining("TeleCodex launch safety policy: full."),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(thread.runStreamed.mock.calls[0]?.[0]).toContain("install package");
    expect(thread.runStreamed.mock.calls[0]?.[0]).toContain("Root or sudo commands are pre-authorized");
  });

  it("handback clears the active thread and returns thread id plus workspace", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([{ type: "thread.started", thread_id: "thread-live" }, { type: "turn.completed", usage }]),
    });

    await service.prompt("hello", callbacks);

    expect(service.handback()).toEqual({
      threadId: "thread-live",
      workspace: "/workspace/base",
    });
    expect(service.hasActiveThread()).toBe(false);
    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
      sessionTokens: {
        input: 1,
        cached: 0,
        output: 1,
      },
    });
  });

  it("listAllSessions delegates to codex-state", async () => {
    mockCodexState.listThreads.mockReturnValue([
      {
        id: "thread-1",
        title: "One",
        cwd: "/workspace/a",
        model: "o3",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
        firstUserMessage: "hello",
      },
    ]);

    const service = await CodexSessionService.create(createConfig());

    expect(service.listAllSessions(5)).toEqual([
      expect.objectContaining({ id: "thread-1", cwd: "/workspace/a" }),
    ]);
    expect(mockCodexState.listThreads).toHaveBeenCalledWith(5);
  });

  it("listWorkspaces delegates to codex-state", async () => {
    mockCodexState.listWorkspaces.mockReturnValue(["/workspace/a", "/workspace/b"]);

    const service = await CodexSessionService.create(createConfig());

    expect(service.listWorkspaces()).toEqual(["/workspace/a", "/workspace/b"]);
    expect(mockCodexState.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("listModels delegates to codex-state", async () => {
    mockCodexState.listModels.mockReturnValue([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "o3", displayName: "o3" },
    ]);

    const service = await CodexSessionService.create(createConfig());

    expect(service.listModels()).toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "o3", displayName: "o3" },
    ]);
    expect(mockCodexState.listModels).toHaveBeenCalledTimes(1);
  });
});
