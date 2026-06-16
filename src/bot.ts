import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import {
  finishActiveOperation,
  startActiveOperation,
  updateActiveOperation,
} from "./active-operations.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexApprovalRequest,
  type CodexApprovalResponse,
  type CodexRuntimeStatus,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
  type CodexStatusDetails,
} from "./codex-session.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import { runCliPtyCompact } from "./codex-cli-pty-compact.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
  type CodexLaunchProfile,
} from "./codex-launch.js";
import { getThread, type CodexThreadRecord } from "./codex-state.js";
import type { TeleCodexConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatStreamingTelegramHTML, formatTelegramHTML } from "./format.js";
import {
  collectRuntimeDoctor,
  collectRuntimeLocks,
  renderRuntimeDoctor,
  renderRuntimeLocks,
} from "./runtime-diagnostics.js";
import {
  getCurrentServiceInstanceName,
  startServiceOperationMarker,
  updateServiceOperationMarkerPid,
} from "./service-operation-marker.js";
import { SessionRegistry } from "./session-registry.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";
import {
  findWorkspaceFiles,
  grepWorkspaceText,
  listWorkspaceEntries,
  readWorkspaceFile,
  renderWorkspaceTree,
  resolveWorkspaceFileForSend,
  searchWorkspaceFiles,
  type WorkspaceEntry,
} from "./workspace-browser.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const TOOL_UPDATE_DEBOUNCE_MS = 1200;
const TYPING_INTERVAL_MS = 4500;
const LONG_RUNNING_FIRST_NOTICE_MS = 3 * 60 * 1000;
const LONG_RUNNING_SECOND_NOTICE_DELAY_MS = 7 * 60 * 1000;
const LONG_RUNNING_NOTICE_INTERVAL_MS = 10 * 60 * 1000;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const RESPONSE_HEADER = "💬 Response";
const DEFAULT_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const MAX_PROMPT_QUEUE_SIZE = 5;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type TelegramReaction = NonNullable<Parameters<Context["api"]["setMessageReaction"]>[2]>[number];
type TelegramReactionEmoji = Extract<TelegramReaction, { type: "emoji" }>["emoji"];
type KeyboardItem = { label: string; callbackData: string };
type PendingApproval = {
  resolve: (response: CodexApprovalResponse) => void;
  timeout: NodeJS.Timeout;
  shortId: string;
  contextKey: TelegramContextKey | null;
  chatId: TelegramChatId;
  messageThreadId?: number;
  request: CodexApprovalRequest;
  rendered: { html: string; plain: string };
  createdAt: number;
};
type QueuedPrompt = {
  id: number;
  input: string;
  summary: string;
  ctx: Context;
  chatId: TelegramChatId;
};

type SessionWorkspaceGroup = {
  workspace: string;
  sessions: CodexThreadRecord[];
};

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
  lastUpdateMs?: number;
};

type AutoCompactReason = "codex-auto" | "threshold";

type AutoCompactState = {
  turnsSinceLastCompact: number;
  lastCompactAtMs?: number;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export function createBot(config: TeleCodexConfig, registry: SessionRegistry): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const instanceName = process.env.TELECODEX_INSTANCE?.trim() || "default";

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean; compacting: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionWorkspacePicks = new Map<TelegramContextKey, SessionWorkspaceGroup[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingSessionWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingFastButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const promptQueues = new Map<TelegramContextKey, QueuedPrompt[]>();
  const compactAbortControllers = new Map<TelegramContextKey, AbortController>();
  const autoCompactStates = new Map<TelegramContextKey, AutoCompactState>();
  const toolUpdateTimers = new Map<string, NodeJS.Timeout>();
  let nextQueuedPromptId = 1;

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    pendingFastButtons.delete(key);
    lastPromptInput.delete(key);
    promptQueues.delete(key);
    autoCompactStates.delete(key);
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean; compacting: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false, compacting: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(state?.processing || state?.switching || state?.transcribing || state?.compacting || session?.isProcessing());
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message. Use /queue <prompt> to run something next."), {
      fallbackText: "Still working on previous message. Use /queue <prompt> to run something next.",
    });
  };

  const getPromptQueue = (contextKey: TelegramContextKey): QueuedPrompt[] => {
    let queue = promptQueues.get(contextKey);
    if (!queue) {
      queue = [];
      promptQueues.set(contextKey, queue);
    }
    return queue;
  };

  const enqueuePrompt = (
    contextKey: TelegramContextKey,
    ctx: Context,
    chatId: TelegramChatId,
    input: string,
  ): QueuedPrompt | null => {
    const queue = getPromptQueue(contextKey);
    if (queue.length >= MAX_PROMPT_QUEUE_SIZE) {
      return null;
    }

    const summary = truncateForChannelHeader(input.replace(/\s+/g, " ").trim(), 120);
    const queuedPrompt = {
      id: nextQueuedPromptId++,
      input,
      summary,
      ctx,
      chatId,
    };
    queue.push(queuedPrompt);
    return queuedPrompt;
  };

  const renderQueueStatus = (contextKey: TelegramContextKey): { html: string; plain: string } => {
    const queue = getPromptQueue(contextKey);
    if (queue.length === 0) {
      return {
        html: "Queue is empty.\n\nUse <code>/queue &lt;prompt&gt;</code> while Codex is working.",
        plain: "Queue is empty.\n\nUse /queue <prompt> while Codex is working.",
      };
    }

    const htmlLines = [`<b>Queued prompts:</b> <code>${queue.length}/${MAX_PROMPT_QUEUE_SIZE}</code>`];
    const plainLines = [`Queued prompts: ${queue.length}/${MAX_PROMPT_QUEUE_SIZE}`];
    queue.forEach((item, index) => {
      htmlLines.push(`${index + 1}. <code>#${item.id}</code> ${escapeHTML(item.summary)}`);
      plainLines.push(`${index + 1}. #${item.id} ${item.summary}`);
    });
    htmlLines.push("", "Use <code>/queue clear</code> to empty the queue.");
    plainLines.push("", "Use /queue clear to empty the queue.");
    return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
  };

  const drainNextQueuedPrompt = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    if (isBusy(contextKey)) {
      return;
    }

    const queue = promptQueues.get(contextKey);
    if (!queue) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      return;
    }
    if (queue.length === 0) {
      promptQueues.delete(contextKey);
    }

    void safeReply(next.ctx, `<b>Running queued prompt #${next.id}</b>\n<code>${escapeHTML(next.summary)}</code>`, {
      fallbackText: `Running queued prompt #${next.id}\n${next.summary}`,
    }).catch((error) => {
      console.error("Failed to announce queued prompt", error);
    });
    lastPromptInput.set(contextKey, next.input);
    runPromptInBackground(next.ctx, contextKey, next.chatId, session, next.input);
  };

  const getAutoCompactState = (contextKey: TelegramContextKey): AutoCompactState => {
    let state = autoCompactStates.get(contextKey);
    if (!state) {
      state = { turnsSinceLastCompact: 0 };
      autoCompactStates.set(contextKey, state);
    }
    return state;
  };

  const markAutoCompactTurnCompleted = (contextKey: TelegramContextKey): void => {
    getAutoCompactState(contextKey).turnsSinceLastCompact += 1;
  };

  const markAutoCompactCompleted = (contextKey: TelegramContextKey): void => {
    const state = getAutoCompactState(contextKey);
    state.turnsSinceLastCompact = 0;
    state.lastCompactAtMs = Date.now();
  };

  const isAutoCompactCooldownActive = (contextKey: TelegramContextKey): boolean => {
    const state = getAutoCompactState(contextKey);
    if (config.autoCompactCooldownTurns > 0 && state.turnsSinceLastCompact < config.autoCompactCooldownTurns) {
      return true;
    }

    if (config.autoCompactCooldownMinutes <= 0 || !state.lastCompactAtMs) {
      return false;
    }

    return Date.now() - state.lastCompactAtMs < config.autoCompactCooldownMinutes * 60 * 1000;
  };

  const getAutoCompactDecision = (
    contextKey: TelegramContextKey,
    session: CodexSessionService,
    codexAutoCompactObserved: boolean,
  ): { shouldCompact: boolean; reason?: AutoCompactReason; detail?: string } => {
    if (!config.autoCompactEnabled) {
      return { shouldCompact: false };
    }

    const info = session.getInfo();
    if (!info.threadId) {
      return { shouldCompact: false };
    }

    if (codexAutoCompactObserved && config.autoCompactAfterCodexAutoCompact) {
      return {
        shouldCompact: true,
        reason: "codex-auto",
        detail: "Codex auto compact was observed during this turn.",
      };
    }

    if (!config.autoCompactAfterEveryTurn && isAutoCompactCooldownActive(contextKey)) {
      return { shouldCompact: false };
    }

    const percentUsed = info.contextWindow?.percentUsed;
    if (percentUsed === undefined) {
      return { shouldCompact: false };
    }

    const thresholdPercent = Math.round(config.autoCompactContextThreshold * 100);
    if (percentUsed >= thresholdPercent) {
      return {
        shouldCompact: true,
        reason: "threshold",
        detail: `Context usage ${percentUsed}% >= ${thresholdPercent}%.`,
      };
    }

    return { shouldCompact: false };
  };

  const formatAutoCompactReason = (reason: AutoCompactReason | undefined): string => {
    switch (reason) {
      case "codex-auto":
        return "Codex auto compact event";
      case "threshold":
        return "context threshold";
      default:
        return "manual request";
    }
  };

  const runTwoStageCompact = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
    options: {
      automatic?: boolean;
      reason?: AutoCompactReason;
      detail?: string;
      sendStepUpdates?: boolean;
    } = {},
  ): Promise<boolean> => {
    const info = session.getInfo();
    if (!info.threadId) {
      if (!options.automatic) {
        await safeReply(ctx, "No active Codex thread to compact yet. Send a prompt first.", {
          fallbackText: "No active Codex thread to compact yet. Send a prompt first.",
        });
      }
      return false;
    }

    const busyState = getBusyState(contextKey);
    if (busyState.compacting) {
      if (!options.automatic) {
        await safeReply(ctx, "Compact is already running for this context.", {
          fallbackText: "Compact is already running for this context.",
        });
      }
      return false;
    }

    busyState.compacting = true;
    const compactAbortController = new AbortController();
    compactAbortControllers.set(contextKey, compactAbortController);
    const reasonText = formatAutoCompactReason(options.reason);
    const sendStepUpdates = options.sendStepUpdates ?? !options.automatic;
    let activeOperationId: string | undefined;
    let activeOperationFinished = false;
    if (ctx.chat?.id !== undefined) {
      activeOperationId = startActiveOperation(config, {
        contextKey,
        chatId: ctx.chat.id,
        messageThreadId: parseContextKey(contextKey).messageThreadId,
        operation: "compact",
        threadId: info.threadId,
        workspace: info.workspace,
        promptSummary: options.detail ?? reasonText,
      }).id;
    }

    await safeReply(
      ctx,
      [
        `<b>${options.automatic ? "Auto compact started." : "Compact started."}</b>`,
        `<b>Reason:</b> <code>${escapeHTML(reasonText)}</code>`,
        options.detail ? `<b>Detail:</b> <code>${escapeHTML(options.detail)}</code>` : undefined,
        `<b>Thread:</b> <code>${escapeHTML(info.threadId)}</code>`,
        "<b>Step:</b> <code>1/2 app-server native compact</code>",
        "",
        "Incoming messages during compact will be queued.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      {
        fallbackText: [
          options.automatic ? "Auto compact started." : "Compact started.",
          `Reason: ${reasonText}`,
          options.detail ? `Detail: ${options.detail}` : undefined,
          `Thread: ${info.threadId}`,
          "Step: 1/2 app-server native compact",
          "",
          "Incoming messages during compact will be queued.",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      },
    );

    try {
      const nativeResult = await session.compactCurrentThread({ signal: compactAbortController.signal });
      registry.updateMetadata(contextKey, session);
      if (sendStepUpdates) {
        await safeReply(
          ctx,
          [
            "<b>Native compact completed.</b>",
            "<b>Step:</b> <code>2/2 Codex CLI PTY compact</code>",
            `<b>Elapsed:</b> <code>${escapeHTML(formatDuration(nativeResult.elapsedMs))}</code>`,
          ].join("\n"),
          {
            fallbackText: [
              "Native compact completed.",
              "Step: 2/2 Codex CLI PTY compact",
              `Elapsed: ${formatDuration(nativeResult.elapsedMs)}`,
            ].join("\n"),
          },
        );
      }
      const cliResult = await runCliPtyCompact(session.getInfo(), { signal: compactAbortController.signal });
      await session.resumeThread(cliResult.threadId);
      registry.updateMetadata(contextKey, session);
      markAutoCompactCompleted(contextKey);
      finishActiveOperation(config, activeOperationId, "completed");
      activeOperationFinished = true;
      await safeReply(
        ctx,
        [
          `<b>${options.automatic ? "Auto compact completed." : "Compact completed."}</b>`,
          `<b>Thread:</b> <code>${escapeHTML(cliResult.threadId)}</code>`,
          `<b>Native elapsed:</b> <code>${escapeHTML(formatDuration(nativeResult.elapsedMs))}</code>`,
          `<b>CLI elapsed:</b> <code>${escapeHTML(formatDuration(cliResult.elapsedMs))}</code>`,
        ].join("\n"),
        {
          fallbackText: [
            options.automatic ? "Auto compact completed." : "Compact completed.",
            `Thread: ${cliResult.threadId}`,
            `Native elapsed: ${formatDuration(nativeResult.elapsedMs)}`,
            `CLI elapsed: ${formatDuration(cliResult.elapsedMs)}`,
          ].join("\n"),
        },
      );
      return true;
    } catch (error) {
      finishActiveOperation(config, activeOperationId, isAbortLikeError(error) ? "aborted" : "failed");
      activeOperationFinished = true;
      await safeReply(ctx, `<b>Compact failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Compact failed: ${friendlyErrorText(error)}`,
      });
      return false;
    } finally {
      if (!activeOperationFinished) {
        finishActiveOperation(config, activeOperationId, "failed");
      }
      busyState.compacting = false;
      compactAbortControllers.delete(contextKey);
      drainNextQueuedPrompt(contextKey, session);
    }
  };

  const setReaction = async (ctx: Context, emoji: string | undefined): Promise<void> => {
    if (!config.enableTelegramReactions || !emoji) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as TelegramReactionEmoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const requestTelegramApproval = async (
    ctx: Context,
    chatId: TelegramChatId,
    messageThreadId: number | undefined,
    request: CodexApprovalRequest,
  ): Promise<CodexApprovalResponse> => {
    const approvalId = randomUUID();
    const approvalContextKey = contextKeyFromCtx(ctx);
    const text = renderApprovalRequest(request);
    const keyboard = new InlineKeyboard()
      .text("Allow once", `approval:${approvalId}:accept`)
      .text("Allow session", `approval:${approvalId}:acceptForSession`)
      .row()
      .text("Deny", `approval:${approvalId}:decline`)
      .text("Cancel", `approval:${approvalId}:cancel`);

    await sendTextMessage(bot.api, chatId, text.html, {
      parseMode: "HTML",
      fallbackText: text.plain,
      messageThreadId,
      replyMarkup: keyboard,
    });

    return new Promise<CodexApprovalResponse>((resolve) => {
      const timeout = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        resolve({ decision: "decline" });
      }, 5 * 60 * 1000);
      pendingApprovals.set(approvalId, {
        resolve,
        timeout,
        shortId: approvalId.slice(0, 8),
        contextKey: approvalContextKey,
        chatId,
        messageThreadId,
        request,
        rendered: text,
        createdAt: Date.now(),
      });
    });
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const promptStartedAt = Date.now();
    let activeOperationId: string | undefined;
    let activeOperationFinished = false;

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;
    console.log(
      `Prompt started instance=${instanceName} context=${contextKey} chat=${chatId} workspace=${session.getCurrentWorkspace()} input=${summarizePromptForLog(userInput)}`,
    );

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const channelChatId = config.telegramChannelId;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    const assistantSegments: string[] = [];
    let accumulatedText = "";
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let codexAutoCompactObserved = false;
    let longRunningStatusTimer: NodeJS.Timeout | undefined;
    let longRunningStatusMessageId: number | undefined;
    let longRunningNoticeCount = 0;
    let longRunningStatusClosed = false;

    const typingInterval = setInterval(() => {
      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
    }, TYPING_INTERVAL_MS);
    void bot.api
      .sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    const clearLongRunningStatusTimer = (): void => {
      if (longRunningStatusTimer) {
        clearTimeout(longRunningStatusTimer);
        longRunningStatusTimer = undefined;
      }
    };

    const isPromptStillActive = (): boolean =>
      !finalized && !longRunningStatusClosed && getBusyState(contextKey).processing && session.isProcessing();

    const deleteLongRunningStatusMessage = async (): Promise<void> => {
      if (longRunningStatusMessageId === undefined) {
        return;
      }

      const messageId = longRunningStatusMessageId;
      longRunningStatusMessageId = undefined;
      await bot.api.deleteMessage(chatId, messageId).catch(() => undefined);
    };

    const closeLongRunningStatus = async (): Promise<void> => {
      longRunningStatusClosed = true;
      clearLongRunningStatusTimer();
      await deleteLongRunningStatusMessage();
    };

    const renderLongRunningStatus = (): { html: string; plain: string } => {
      const elapsed = formatElapsedDuration(Date.now() - promptStartedAt);
      const info = session.getInfo();
      const queueCount = promptQueues.get(contextKey)?.length ?? 0;
      const promptSummary = summarizeUserInputForChannel(userInput);
      const htmlLines = [
        "<b>Still working...</b>",
        `<b>Elapsed:</b> <code>${escapeHTML(elapsed)}</code>`,
        info.threadId ? `<b>Thread:</b> <code>${escapeHTML(info.threadId)}</code>` : undefined,
        `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
        queueCount > 0 ? `<b>Queued:</b> <code>${queueCount}</code>` : undefined,
        `<b>Last user:</b> <code>${escapeHTML(promptSummary)}</code>`,
      ].filter((line): line is string => Boolean(line));
      const plainLines = [
        "Still working...",
        `Elapsed: ${elapsed}`,
        info.threadId ? `Thread: ${info.threadId}` : undefined,
        `Workspace: ${info.workspace}`,
        queueCount > 0 ? `Queued: ${queueCount}` : undefined,
        `Last user: ${promptSummary}`,
      ].filter((line): line is string => Boolean(line));
      return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
    };

    const scheduleLongRunningStatus = (delayMs: number): void => {
      if (longRunningStatusClosed) {
        return;
      }
      longRunningStatusTimer = setTimeout(() => {
        longRunningStatusTimer = undefined;
        void sendLongRunningStatus().catch((error) => {
          console.error("Failed to send long-running status", error);
        });
      }, delayMs);
    };

    const sendLongRunningStatus = async (): Promise<void> => {
      if (!isPromptStillActive()) {
        return;
      }

      const rendered = renderLongRunningStatus();
      if (!isPromptStillActive()) {
        return;
      }
      if (longRunningStatusMessageId === undefined) {
        const message = await sendTextMessage(bot.api, chatId, rendered.html, {
          parseMode: "HTML",
          fallbackText: rendered.plain,
          messageThreadId,
        });
        longRunningStatusMessageId = message.message_id;
        updateActiveOperation(config, activeOperationId, { statusMessageId: longRunningStatusMessageId });
        if (!isPromptStillActive()) {
          await deleteLongRunningStatusMessage();
          return;
        }
      } else {
        if (!isPromptStillActive()) {
          return;
        }
        await safeEditMessage(bot, chatId, longRunningStatusMessageId, rendered.html, {
          fallbackText: rendered.plain,
        });
      }

      if (!isPromptStillActive()) {
        return;
      }

      longRunningNoticeCount += 1;
      scheduleLongRunningStatus(
        longRunningNoticeCount === 1 ? LONG_RUNNING_SECOND_NOTICE_DELAY_MS : LONG_RUNNING_NOTICE_INTERVAL_MS,
      );
    };

    scheduleLongRunningStatus(LONG_RUNNING_FIRST_NOTICE_MS);

    const stopTyping = (): void => {
      clearInterval(typingInterval);
      clearLongRunningStatusTimer();
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const clearToolUpdateTimer = (toolCallId: string): void => {
      const timer = toolUpdateTimers.get(toolCallId);
      if (!timer) {
        return;
      }

      clearTimeout(timer);
      toolUpdateTimers.delete(toolCallId);
    };

    const clearAllToolUpdateTimers = (): void => {
      for (const [toolCallId] of toolUpdateTimers) {
        clearToolUpdateTimer(toolCallId);
      }
    };

    const scheduleToolUpdate = (toolCallId: string): void => {
      const state = toolStates.get(toolCallId);
      if (!state || !state.messageId || !state.partialResult) {
        return;
      }

      const now = Date.now();
      clearToolUpdateTimer(toolCallId);

      const delay = Math.max(0, TOOL_UPDATE_DEBOUNCE_MS - (now - (state.lastUpdateMs ?? 0)));
      const timer = setTimeout(() => {
        toolUpdateTimers.delete(toolCallId);
        const current = toolStates.get(toolCallId);
        if (!current || !current.messageId || !current.partialResult) {
          return;
        }

        const running = renderToolRunningMessage(current.toolName, current.partialResult);
        void safeEditMessage(bot, chatId, current.messageId, running.text, {
          parseMode: running.parseMode,
          fallbackText: running.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool output for ${current.toolName}`, error);
        });
        current.lastUpdateMs = Date.now();
      }, delay);

      toolUpdateTimers.set(toolCallId, timer);
      state.lastUpdateMs = Date.now();
    };

    const hasResponseBody = (): boolean => accumulatedText.trim().length > 0;

    const renderPreview = (): RenderedChunk => {
      const previewText = buildStreamingPreview(formatResponseSegment(accumulatedText));
      return renderStreamingMarkdownChunkWithinLimit(previewText);
    };

    const resetResponseState = (): void => {
      accumulatedText = "";
      responseMessageId = undefined;
      responseMessagePromise = undefined;
      lastRenderedText = "";
      lastEditAt = 0;
      isFlushing = false;
      flushPending = false;
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        const preview = renderPreview();
        const placeholder = renderResponsePlaceholder();
        const message = await sendTextMessage(bot.api, chatId, preview.text || placeholder.text, {
          parseMode: preview.text ? preview.parseMode : placeholder.parseMode,
          fallbackText: preview.fallbackText || placeholder.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        updateActiveOperation(config, activeOperationId, { responseMessageId });
        lastRenderedText = preview.text || placeholder.text;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText) {
        return;
      }
      if (!responseMessageId) {
        await ensureResponseMessage();
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) {
        return;
      }

      const nextText = renderPreview();
      if (nextText.text === lastRenderedText) {
        return;
      }

      isFlushing = true;
      try {
        await safeEditMessage(bot, chatId, responseMessageId, nextText.text, {
          parseMode: nextText.parseMode,
          fallbackText: nextText.fallbackText,
          replyMarkup: abortKeyboard,
        });
        lastRenderedText = nextText.text;
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized) {
        return;
      }

      const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const removeAbortKeyboardFrom = async (messageId: number | undefined): Promise<void> => {
      if (!messageId) {
        return;
      }

      try {
        await bot.api.editMessageReplyMarkup(chatId, messageId, {
          reply_markup: new InlineKeyboard(),
        });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      await removeAbortKeyboardFrom(responseMessageId);
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await safeEditMessage(bot, chatId, responseMessageId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
        });
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
    };

    const closeCurrentAssistantSegment = async (): Promise<void> => {
      const segmentText = formatResponseSegment(accumulatedText).trim();
      if (!segmentText) {
        return;
      }

      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Fall back to sending the finalized segment below.
        }
      }

      await deliverRenderedChunks(splitMarkdownForTelegram(segmentText));
      assistantSegments.push(segmentText);
      resetResponseState();
    };

    const mirrorFinalResponseToChannel = async (text: string): Promise<void> => {
      if (channelChatId === undefined) {
        return;
      }

      const chunks = splitMarkdownForTelegram(text);
      const header = buildChannelResponseHeader(session.getCurrentWorkspace(), userInput, chunks.length);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const htmlHeader = renderChannelResponseHeaderHTML(header, index + 1);
        const plainHeader = renderChannelResponseHeaderPlain(header, index + 1);
        await sendTextMessage(bot.api, channelChatId, `${htmlHeader}\n\n${chunk.text}`, {
          parseMode: "HTML",
          fallbackText: `${plainHeader}\n\n${chunk.fallbackText}`,
        });
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();
      await closeLongRunningStatus();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      const finalText = buildFinalResponseText(formatResponseSegment(accumulatedText));
      if (!finalText) {
        if (assistantSegments.length > 0) {
          await removeAbortKeyboard();
          await mirrorFinalResponseToChannel(assistantSegments.join("\n\n"));
          return;
        }

        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        await mirrorFinalResponseToChannel(plainText);
        return;
      }

      await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
      await mirrorFinalResponseToChannel([...assistantSegments, finalText].join("\n\n"));
    };

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: (delta: string, metadata) => {
        if (metadata?.startsNewMessage && accumulatedText.trim()) {
          const previousResponseMessageId = responseMessageId;
          clearFlushTimer();
          void removeAbortKeyboardFrom(previousResponseMessageId).catch((error) => {
            console.error("Failed to clear Abort button before starting next agent message", error);
          });
          accumulatedText = "";
          responseMessageId = undefined;
          responseMessagePromise = undefined;
          lastRenderedText = "";
          lastEditAt = 0;
          isFlushing = false;
          flushPending = false;
        }

        accumulatedText += delta;
        if (!hasResponseBody()) {
          return;
        }

        if (!responseMessageId) {
          void ensureResponseMessage()
            .then(() => {
              scheduleFlush();
            })
            .catch((error) => {
              console.error("Failed to send initial Telegram response message", error);
            });
          return;
        }

        scheduleFlush();
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "", lastUpdateMs: Date.now() });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          await closeCurrentAssistantSegment();
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          state.lastUpdateMs = Date.now();
          scheduleToolUpdate(toolCallId);
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
        scheduleToolUpdate(toolCallId);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        clearToolUpdateTimer(toolCallId);

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onContextCompaction: () => {
        codexAutoCompactObserved = true;
      },
      onApprovalRequest: (request) => requestTelegramApproval(ctx, chatId, messageThreadId, request),
      onAgentEnd: () => {
        void finalizeResponse().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex is not authenticated.</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "Use /login to start authentication, or set CODEX_API_KEY on the host.",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex is not authenticated.",
              "",
              authStatus.detail,
              "",
              "Use /login to start authentication, or set CODEX_API_KEY on the host.",
            ].join("\n"),
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      const operation = startActiveOperation(config, {
        contextKey,
        chatId,
        messageThreadId,
        operation: "turn",
        threadId: session.getInfo().threadId,
        workspace: session.getCurrentWorkspace(),
        promptSummary: summarizeUserInputForChannel(userInput),
      });
      activeOperationId = operation.id;
      await session.prompt(userInput, callbacks);
      updateSessionMetadata(contextKey, session);
      updateActiveOperation(config, activeOperationId, {
        threadId: session.getInfo().threadId,
        workspace: session.getCurrentWorkspace(),
      });
      await finalizeResponse();
      finishActiveOperation(config, activeOperationId, "completed");
      activeOperationFinished = true;
      markAutoCompactTurnCompleted(contextKey);
      const autoCompact = getAutoCompactDecision(contextKey, session, codexAutoCompactObserved);
      if (autoCompact.shouldCompact) {
        await runTwoStageCompact(ctx, contextKey, session, {
          automatic: true,
          reason: autoCompact.reason,
          detail: autoCompact.detail,
          sendStepUpdates: false,
        });
      }
      const info = session.getInfo();
      console.log(
        `Prompt completed instance=${instanceName} context=${contextKey} thread=${info.threadId ?? "none"} durationMs=${Date.now() - promptStartedAt}`,
      );
    } catch (error) {
      finishActiveOperation(config, activeOperationId, isAbortLikeError(error) ? "aborted" : "failed");
      activeOperationFinished = true;
      console.error(
        `Prompt failed instance=${instanceName} context=${contextKey} durationMs=${Date.now() - promptStartedAt}: ${formatError(error)}`,
      );
      stopTyping();
      await closeLongRunningStatus();
      clearAllToolUpdateTimers();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          await deliverRenderedChunks(chunks);
          await mirrorFinalResponseToChannel(combinedText);
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      if (!activeOperationFinished) {
        finishActiveOperation(config, activeOperationId, "failed");
      }
      stopTyping();
      await closeLongRunningStatus();
      clearAllToolUpdateTimers();
      clearFlushTimer();
      busyState.processing = false;
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Not authenticated. Use /login or set CODEX_API_KEY.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info, instanceName),
        renderSessionInfoPlain(info, instanceName),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("status", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const busy = isBusy(contextKey);
    const processing = session.isProcessing();
    const busyState = getBusyState(contextKey);
    const queueCount = promptQueues.get(contextKey)?.length ?? 0;
    const compactState = busyState.compacting ? "running" : "ready";
    const runtimeStatus = session.getRuntimeStatus();
    const runtimeBackend = runtimeStatus.backend === "app-server" ? "app-server" : "SDK fallback";
    const statusDetails = await session.getStatusDetails();
    const info = session.getInfo();
    const approvalBridge = renderApprovalBridgeStatus(info, config.enableCodexAppServerRuntime);
    const appServerStatus = formatRuntimeStatusPlain(runtimeStatus);
    const rendered = renderMobileStatus({
      authStatus: authStatus.authenticated ? "authenticated" : "not authenticated",
      authMethod: authStatus.method,
      runtimeBackend,
      runtime: `${busy ? "busy" : "idle"}${processing ? " (processing)" : ""}`,
      compactState,
      approvalBridge: approvalBridge.plain,
      appServerStatus,
      queueCount,
      instanceName,
      info,
      statusDetails,
    });
    const plainLines = rendered.plainLines;
    const htmlLines = rendered.htmlLines;

    if (!authStatus.authenticated) {
      plainLines.splice(3, 0, `Auth detail: ${authStatus.detail}`);
      htmlLines.splice(3, 0, `<b>Auth detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`);
    }

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("doctor", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const workspace = contextSession?.session.getCurrentWorkspace() ?? config.workspace;
    const report = await collectRuntimeDoctor({ workspace, instanceName });
    const rendered = renderRuntimeDoctor(report);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("locks", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const workspace = contextSession?.session.getCurrentWorkspace() ?? config.workspace;
    const report = await collectRuntimeLocks({ workspace });
    const rendered = renderRuntimeLocks(report);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command(["reconnect", "codex_reconnect"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, "Cannot reconnect Codex app-server while this context is busy.", {
        fallbackText: "Cannot reconnect Codex app-server while this context is busy.",
      });
      return;
    }

    try {
      const info = await session.reconnectAppServer();
      updateSessionMetadata(contextKey, session);
      await safeReply(
        ctx,
        [
          "<b>Codex app-server reconnected.</b>",
          `<b>Thread:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
          `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
        ].join("\n"),
        {
          fallbackText: [
            "Codex app-server reconnected.",
            `Thread: ${info.threadId ?? "(not started yet)"}`,
            `Workspace: ${info.workspace}`,
          ].join("\n"),
        },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Reconnect failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Reconnect failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("compact", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const arg = commandArgs(ctx, "compact").toLowerCase();

    if (arg === "status") {
      await safeReply(ctx, renderCompactStatusHTML(info), {
        fallbackText: renderCompactStatusPlain(info),
      });
      return;
    }

    if (arg === "preview") {
      await safeReply(
        ctx,
        [
          "<b>Compact preview is not available.</b>",
          "",
          "This command runs app-server native compact, then Codex CLI <code>/compact</code> through PTY.",
        ].join("\n"),
        {
          fallbackText: [
            "Compact preview is not available.",
            "",
            "This command runs app-server native compact, then Codex CLI /compact through PTY.",
          ].join("\n"),
        },
      );
      return;
    }

    const busyState = getBusyState(contextKey);
    if (session.isProcessing() || busyState.processing) {
      await safeReply(ctx, "Cannot compact while a Codex turn is running. Use /stop first if needed.", {
        fallbackText: "Cannot compact while a Codex turn is running. Use /stop first if needed.",
      });
      return;
    }

    void (async () => {
      await runTwoStageCompact(ctx, contextKey, session, { sendStepUpdates: true });
    })().catch((error) => {
      console.error("Compact failed:", error);
    });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          "Run <code>codex login</code> on the host, or set CODEX_API_KEY in .env.",
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            "Run 'codex login' on the host, or set CODEX_API_KEY in .env.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>Cannot logout via Telegram when using CODEX_API_KEY.</b>",
          "",
          "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            "Cannot logout via Telegram when using CODEX_API_KEY.",
            "",
            "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        "Run <code>codex logout</code> on the host.",
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          "Run 'codex logout' on the host.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Install <code>parakeet-coreml</code> + ffmpeg, or set <code>OPENAI_API_KEY</code>.",
          "<i>Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Install parakeet-coreml + ffmpeg, or set OPENAI_API_KEY.",
            "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`, {
      fallbackText: `Voice backends: ${joined}`,
    });
  });

  bot.command(["update", "service_update"], async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    try {
      const instance = getServiceInstanceName();
      const marker = startServiceOperationMarker(config, {
        type: "update",
        instance,
        chatId: ctx.chat.id,
        messageThreadId: ctx.message?.message_thread_id,
      });
      const launched = startServiceUpdate();
      updateServiceOperationMarkerPid(config, instance, marker.id, launched.pid);
      await safeReply(
        ctx,
        [
          "<b>Service update launched.</b>",
          `<b>Instance:</b> <code>${escapeHTML(instance)}</code>`,
          launched.pid ? `<b>PID:</b> <code>${launched.pid}</code>` : undefined,
          "",
          "Running fire-and-forget. This bot may restart if the update succeeds.",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
        {
          fallbackText: [
            "Service update launched.",
            `Instance: ${instance}`,
            launched.pid ? `PID: ${launched.pid}` : undefined,
            "",
            "Running fire-and-forget. This bot may restart if the update succeeds.",
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
        },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Service update failed to launch:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Service update failed to launch: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command(["restart", "force_restart", "service_restart"], async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const instance = getServiceInstanceName();
    startServiceOperationMarker(config, {
      type: "restart",
      instance,
      chatId: ctx.chat.id,
      messageThreadId: ctx.message?.message_thread_id,
    });
    await safeReply(
      ctx,
      [
        "<b>Service restart requested.</b>",
        `<b>Instance:</b> <code>${escapeHTML(instance)}</code>`,
        "",
        "Restarting fire-and-forget. This command does not contact Codex app-server.",
      ].join("\n"),
      {
        fallbackText: [
          "Service restart requested.",
          `Instance: ${instance}`,
          "",
          "Restarting fire-and-forget. This command does not contact Codex app-server.",
        ].join("\n"),
      },
    );
    scheduleServiceRestart();
  });

  const getWorkspaceForCommand = async (ctx: Context): Promise<string | null> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    return contextSession?.session.getCurrentWorkspace() ?? null;
  };

  const runPromptInBackground = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    after?: () => Promise<void>,
  ): void => {
    void (async () => {
      void setReaction(ctx, config.telegramReactionProcessingEmoji);
      try {
        await handleUserPrompt(ctx, contextKey, chatId, session, userInput);
        await setReaction(ctx, config.telegramReactionSuccessEmoji);
      } catch {
        if (config.telegramReactionFailureEmoji) {
          await setReaction(ctx, config.telegramReactionFailureEmoji);
        } else {
          await clearReaction(ctx);
        }
      } finally {
        try {
          if (after) {
            await after();
          }
        } finally {
          drainNextQueuedPrompt(contextKey, session);
        }
      }
    })().catch((error) => {
      console.error("Background prompt failed:", error);
    });
  };

  bot.command("files", async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const targetPath = commandArgs(ctx, "files") || ".";
    try {
      const result = await listWorkspaceEntries(workspace, targetPath);
      const lines = [
        `<b>Files:</b> <code>${escapeHTML(result.basePath)}</code>`,
        "",
        ...result.entries.map(formatWorkspaceEntryHTML),
        result.truncated ? "" : undefined,
        result.truncated ? "<i>Output truncated.</i>" : undefined,
      ].filter((line): line is string => line !== undefined);
      await safeReply(ctx, lines.join("\n"), { fallbackText: stripHTML(lines.join("\n")) });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("tree", async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const { pathArg, depth } = parsePathAndDepth(commandArgs(ctx, "tree"));
    try {
      const result = await renderWorkspaceTree(workspace, pathArg || ".", depth);
      const text = result.truncated ? `${result.lines.join("\n")}\n... truncated` : result.lines.join("\n");
      await safeReply(ctx, `<pre>${escapeHTML(text)}</pre>`, { fallbackText: text });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("find", async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const parsed = parseQueryAndPath(commandArgs(ctx, "find"));
    try {
      const result = await findWorkspaceFiles(workspace, parsed.query, parsed.pathArg || ".");
      const lines = [
        `<b>Find:</b> <code>${escapeHTML(parsed.query)}</code>`,
        "",
        ...(result.matches.length > 0 ? result.matches.map(formatWorkspaceEntryHTML) : ["<i>No matches.</i>"]),
        result.truncated ? "" : undefined,
        result.truncated ? "<i>Output truncated.</i>" : undefined,
      ].filter((line): line is string => line !== undefined);
      await safeReply(ctx, lines.join("\n"), { fallbackText: stripHTML(lines.join("\n")) });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("search", async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const parsed = parseQueryAndPath(commandArgs(ctx, "search"));
    try {
      const result = await searchWorkspaceFiles(workspace, parsed.query, parsed.pathArg || ".");
      const lines = [
        `<b>Search:</b> <code>${escapeHTML(parsed.query)}</code>`,
        `<b>Workspace:</b> <code>${escapeHTML(workspace)}</code>`,
        `<b>Source:</b> <code>${escapeHTML(result.source)}</code>`,
        "",
        ...(result.matches.length > 0 ? result.matches.map(formatWorkspaceEntryHTML) : ["<i>No matches.</i>"]),
        result.truncated ? "" : undefined,
        result.truncated ? "<i>Output truncated.</i>" : undefined,
        result.matches.length > 0 ? "" : undefined,
        result.matches.length > 0 ? "<i>Use /sendfile &lt;path&gt; to receive a file.</i>" : undefined,
      ].filter((line): line is string => line !== undefined);
      await safeReply(ctx, lines.join("\n"), { fallbackText: stripHTML(lines.join("\n")) });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command(["sendfile", "file", "download"], async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const requestedPath = commandArgsAny(ctx, ["sendfile", "file", "download"]);
    try {
      const file = await resolveWorkspaceFileForSend(workspace, requestedPath, config.maxFileSize);
      await ctx.api.sendChatAction(chatId, "upload_document", {
        ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
      });
      await ctx.api.sendDocument(chatId, new InputFile(file.absolutePath, file.name), {
        caption: `File: ${file.relativePath}`,
        ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("grep", async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const parsed = parseQueryAndPath(commandArgs(ctx, "grep"));
    try {
      const result = await grepWorkspaceText(workspace, parsed.query, parsed.pathArg || ".");
      const lines = [
        `<b>Grep:</b> <code>${escapeHTML(parsed.query)}</code>`,
        "",
        ...(result.matches.length > 0
          ? result.matches.map((match) => `<code>${escapeHTML(`${match.relativePath}:${match.lineNumber}`)}</code> ${escapeHTML(match.line)}`)
          : ["<i>No matches.</i>"]),
        result.truncated ? "" : undefined,
        result.truncated ? "<i>Output truncated.</i>" : undefined,
      ].filter((line): line is string => line !== undefined);
      await safeReply(ctx, lines.join("\n"), { fallbackText: stripHTML(lines.join("\n")) });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("view", async (ctx) => {
    const workspace = await getWorkspaceForCommand(ctx);
    if (!workspace) return;

    const parsed = parseViewArgs(commandArgs(ctx, "view"));
    try {
      const result = await readWorkspaceFile(workspace, parsed.pathArg, parsed.range);
      const header = `${result.relativePath}:${result.startLine}-${result.endLine}/${result.totalLines}`;
      const suffix = result.truncated ? "\n\n... truncated" : "";
      const body = `${result.text}${suffix}`;
      await safeReply(ctx, `<b>View:</b> <code>${escapeHTML(header)}</code>\n<pre>${escapeHTML(body)}</pre>`, {
        fallbackText: `View: ${header}\n${body}`,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    if (workspaces.length <= 1) {
      try {
        const info = await session.newThread();
        updateSessionMetadata(contextKey, session);
        const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
        const plainText = `${label}\n\n${renderSessionInfoPlain(info, instanceName)}`;
        const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info, instanceName)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>Select workspace for new thread:</b>", {
      fallbackText: "Select workspace for new thread:",
      replyMarkup: keyboard,
    });
  });

  bot.command(["abort", "stop"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      compactAbortControllers.get(contextKey)?.abort();
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    runPromptInBackground(ctx, contextKey, chatId, session, cached);
  });

  bot.command("queue", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const rawArgs = commandArgs(ctx, "queue");
    const lowerArgs = rawArgs.toLowerCase();

    if (!rawArgs) {
      const rendered = renderQueueStatus(contextKey);
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    if (lowerArgs === "clear") {
      const count = promptQueues.get(contextKey)?.length ?? 0;
      promptQueues.delete(contextKey);
      await safeReply(ctx, escapeHTML(`Cleared ${count} queued prompt${count === 1 ? "" : "s"}.`), {
        fallbackText: `Cleared ${count} queued prompt${count === 1 ? "" : "s"}.`,
      });
      return;
    }

    const popMatch = lowerArgs.match(/^pop\s+(\d+)$/);
    if (popMatch) {
      const index = Number.parseInt(popMatch[1] ?? "", 10) - 1;
      const queue = promptQueues.get(contextKey) ?? [];
      const [removed] = index >= 0 ? queue.splice(index, 1) : [];
      if (queue.length === 0) {
        promptQueues.delete(contextKey);
      }
      if (!removed) {
        await safeReply(ctx, escapeHTML("No queued prompt at that position."), {
          fallbackText: "No queued prompt at that position.",
        });
        return;
      }
      await safeReply(ctx, `<b>Removed queued prompt #${removed.id}</b>\n<code>${escapeHTML(removed.summary)}</code>`, {
        fallbackText: `Removed queued prompt #${removed.id}\n${removed.summary}`,
      });
      return;
    }

    if (!isBusy(contextKey)) {
      lastPromptInput.set(contextKey, rawArgs);
      runPromptInBackground(ctx, contextKey, chatId, session, rawArgs);
      return;
    }

    const queued = enqueuePrompt(contextKey, ctx, chatId, rawArgs);
    if (!queued) {
      await safeReply(ctx, escapeHTML(`Queue is full (${MAX_PROMPT_QUEUE_SIZE}/${MAX_PROMPT_QUEUE_SIZE}).`), {
        fallbackText: `Queue is full (${MAX_PROMPT_QUEUE_SIZE}/${MAX_PROMPT_QUEUE_SIZE}).`,
      });
      return;
    }

    const position = getPromptQueue(contextKey).findIndex((item) => item.id === queued.id) + 1;
    await safeReply(ctx, `<b>Queued prompt #${queued.id}</b> position <code>${position}</code>`, {
      fallbackText: `Queued prompt #${queued.id} position ${position}`,
    });
  });

  bot.command("steer", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const userInput = commandArgs(ctx, "steer");
    if (!userInput) {
      await safeReply(ctx, escapeHTML("Usage: /steer <prompt>. Sends guidance into the active Codex turn before the next steerable step."), {
        fallbackText: "Usage: /steer <prompt>. Sends guidance into the active Codex turn before the next steerable step.",
      });
      return;
    }

    if (!session.canSteer()) {
      await safeReply(ctx, escapeHTML("No active steerable Codex turn. Use /queue <prompt> to run guidance after the current turn."), {
        fallbackText: "No active steerable Codex turn. Use /queue <prompt> to run guidance after the current turn.",
      });
      return;
    }

    try {
      await session.steer(userInput);
      await safeReply(ctx, `<b>Steer sent to active turn.</b>\n<code>${escapeHTML(truncateForChannelHeader(userInput.replace(/\s+/g, " ").trim(), 160))}</code>`, {
        fallbackText: `Steer sent to active turn.\n${truncateForChannelHeader(userInput.replace(/\s+/g, " ").trim(), 160)}`,
      });
    } catch (error) {
      const message = friendlyErrorText(error);
      await safeReply(ctx, `<b>Steer failed:</b> <code>${escapeHTML(message)}</code>`, {
        fallbackText: `Steer failed: ${message}`,
      });
      return;
    }
  });

  bot.command(["ask", "prompt"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const rawArgs = (ctx.message?.text ?? "").replace(/^\/(?:ask|prompt)(?:@\w+)?\s*/i, "").trim();
    if (!rawArgs) {
      await safeReply(ctx, "Usage: /ask <prompt>. Use this when your prompt would otherwise start with /.", {
        fallbackText: "Usage: /ask <prompt>. Use this when your prompt would otherwise start with /.",
      });
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      const queued = enqueuePrompt(contextKey, ctx, chatId, rawArgs);
      if (!queued) {
        await safeReply(ctx, escapeHTML(`Queue is full (${MAX_PROMPT_QUEUE_SIZE}/${MAX_PROMPT_QUEUE_SIZE}).`), {
          fallbackText: `Queue is full (${MAX_PROMPT_QUEUE_SIZE}/${MAX_PROMPT_QUEUE_SIZE}).`,
        });
        return;
      }

      await safeReply(ctx, `<b>Prompt queued as #${queued.id}</b>\n<code>${escapeHTML(queued.summary)}</code>`, {
        fallbackText: `Prompt queued as #${queued.id}\n${queued.summary}`,
      });
      return;
    }

    lastPromptInput.set(contextKey, rawArgs);
    runPromptInBackground(ctx, contextKey, chatId, session, rawArgs);
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info, instanceName)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info, instanceName)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Selected permission profile:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "Select a profile. Active threads are reattached immediately when idle:",
    ];
    const plainLines = [
      `Selected permission profile: ${selectedLaunchProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "Select a profile. Active threads are reattached immediately when idle:",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses danger-full-access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses danger-full-access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Active thread still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Active thread still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  const applyLaunchProfileSelection = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
    profile: CodexLaunchProfile,
    options: {
      chatId: TelegramChatId;
      messageId?: number;
      confirmedUnsafe?: boolean;
    },
  ): Promise<void> => {
    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      await ctx.answerCallbackQuery({ text: `Applying ${profile.label}...` }).catch(() => undefined);
      clearLaunchSelectionState(contextKey);
      const before = session.getInfo();
      const info = await session.setLaunchProfileAndReattach(profile.id);
      updateSessionMetadata(contextKey, session);

      const appliedLine = before.threadId
        ? "Current thread was reattached with this launch profile."
        : "No active thread yet. This profile applies when a thread starts.";
      const unsafeLine = options.confirmedUnsafe
        ? "⚠️ <i>danger-full-access confirmed for this Telegram context.</i>"
        : undefined;
      const unsafePlainLine = options.confirmedUnsafe
        ? "danger-full-access confirmed for this Telegram context."
        : undefined;
      const html = [
        `<b>Permission profile applied:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
        "",
        escapeHTML(appliedLine),
        unsafeLine,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      const plain = [
        `Permission profile applied: ${info.launchProfileLabel}`,
        `Behavior: ${info.launchProfileBehavior}${info.unsafeLaunch ? " [unsafe]" : ""}`,
        "",
        appliedLine,
        unsafePlainLine,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");

      if (options.messageId) {
        await safeEditMessage(bot, options.chatId, options.messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    } catch (error) {
      await ctx.answerCallbackQuery({ text: "Failed to change permission profile" }).catch(() => undefined);
      const message = friendlyErrorText(error);
      const html = `<b>Failed:</b> ${escapeHTML(message)}`;
      const plain = `Failed: ${message}`;
      if (options.messageId) {
        await safeEditMessage(bot, options.chatId, options.messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    } finally {
      busyState.switching = false;
    }
  };

  bot.command(["launch", "launch_profiles", "permission", "profile"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);
  bot.hears(/^\/permission(?:@\w+)?$/i, openLaunchProfilesPicker);
  bot.hears(/^\/profile(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("approvals", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const approvals = [...pendingApprovals.entries()]
      .filter(([, approval]) => approval.contextKey === contextKey)
      .sort(([, left], [, right]) => left.createdAt - right.createdAt);

    if (approvals.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Pending approvals:</b> <code>0</code>",
          "",
          "No pending approvals for this Telegram context.",
          "Use <code>/permission</code> and select <code>Review</code> if you want Codex to ask before risky actions.",
        ].join("\n"),
        {
          fallbackText: [
            "Pending approvals: 0",
            "",
            "No pending approvals for this Telegram context.",
            "Use /permission and select Review if you want Codex to ask before risky actions.",
          ].join("\n"),
        },
      );
      return;
    }

    const rendered = renderPendingApprovals(approvals);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Thread handed back to Codex CLI.",
        "",
        "Run this in your terminal:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Thread handed back to Codex CLI.</b>",
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    if (!getThread(threadId)) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown Codex thread: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown Codex thread: ${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached to thread.</b>\n\n${renderSessionInfoHTML(info, instanceName)}`;
      const plain = `Attached to thread.\n\n${renderSessionInfoPlain(info, instanceName)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        const html = `<b>Switched thread.</b>\n\n${renderSessionInfoHTML(info, instanceName)}`;
        const plain = `Switched thread.\n\n${renderSessionInfoPlain(info, instanceName)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50);
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("No recent threads found."), {
        fallbackText: "No recent threads found.",
      });
      return;
    }

    const groupedSessions = new Map<string, CodexThreadRecord[]>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const groups: SessionWorkspaceGroup[] = [...groupedSessions.entries()]
      .map(([workspace, workspaceSessions]) => ({
        workspace,
        sessions: [...workspaceSessions].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()),
      }))
      .sort((left, right) => right.sessions[0]!.updatedAt.getTime() - left.sessions[0]!.updatedAt.getTime());

    pendingSessionWorkspacePicks.set(contextKey, groups);
    const workspaceButtons = groups.map((group, index) => ({
      label: formatSessionWorkspaceLabel(group),
      callbackData: `sessws_${index}`,
    }));
    pendingSessionWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "sessws");

    await safeReply(ctx, `<b>Recent workspaces</b> (${groups.length}):\nChoose a project first.`, {
      fallbackText: `Recent workspaces (${groups.length}):\nChoose a project first.`,
      replyMarkup: keyboard,
    });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: `${model.displayName}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new threads:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new threads:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command(["think", "effort"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const requestedEffort = rawText.replace(/^\/(?:think|effort)(?:@\w+)?\s*/, "").trim().toLowerCase();
    const dynamicEfforts = await session.listReasoningEfforts();
    const efforts = [...(dynamicEfforts.length > 0 ? dynamicEfforts : DEFAULT_REASONING_EFFORTS), "default"];
    const current = session.getInfo().reasoningEffort;

    if (requestedEffort) {
      if (!isReasoningEffortOption(requestedEffort, efforts)) {
        const plainText = `Usage: /think ${efforts.join("|")}`;
        await safeReply(ctx, `<code>${escapeHTML(plainText)}</code>`, { fallbackText: plainText });
        return;
      }

      const effort = requestedEffort === "default" ? undefined : requestedEffort;
      session.setReasoningEffort(effort);
      updateSessionMetadata(contextKey, session);
      const label = effort ?? "model default";
      const html = `⚡ Thinking set to <code>${escapeHTML(label)}</code> — applies to new threads or reattached threads.`;
      await safeReply(ctx, html, {
        fallbackText: `Thinking set to ${label} — applies to new threads or reattached threads.`,
      });
      return;
    }

    const effortButtons = efforts.map((effort) => ({
      label: effort === (current ?? "default") ? `${effort} ✓` : effort,
      callbackData: `effort_set_${encodeCallbackValue(effort)}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>Thinking:</b> <code>${escapeHTML(current)}</code>\n\nSelect for new threads or reattached threads:`
      : "<b>Thinking:</b> <code>model default</code>\n\nSelect for new threads or reattached threads:";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.command("fast", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const requestedMode = rawText.replace(/^\/fast(?:@\w+)?\s*/, "").trim().toLowerCase();

    if (requestedMode) {
      if (!isFastModeOption(requestedMode)) {
        const plainText = "Usage: /fast on|off|once|status";
        await safeReply(ctx, `<code>${escapeHTML(plainText)}</code>`, { fallbackText: plainText });
        return;
      }

      if (isBusy(contextKey) && requestedMode !== "status" && requestedMode !== "once") {
        await safeReply(ctx, escapeHTML("Cannot change fast mode while a prompt is running."), {
          fallbackText: "Cannot change fast mode while a prompt is running.",
        });
        return;
      }

      try {
        if (requestedMode === "on") {
          await session.setFastModeAndReattach(true);
        } else if (requestedMode === "off") {
          await session.setFastModeAndReattach(false);
        } else if (requestedMode === "once") {
          session.setFastOnce();
        }
        updateSessionMetadata(contextKey, session);
        const info = session.getInfo();
        await safeReply(ctx, renderFastModeStatusHTML(info), {
          fallbackText: renderFastModeStatusPlain(info),
        });
      } catch (error) {
        const message = friendlyErrorText(error);
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(message)}`, { fallbackText: `Failed: ${message}` });
      }
      return;
    }

    const info = session.getInfo();
    const fastButtons = buildFastModeButtons(info);
    pendingFastButtons.set(contextKey, fastButtons);
    const keyboard = paginateKeyboard(fastButtons, 0, "fast");
    await safeReply(ctx, renderFastModeStatusHTML(info), {
      fallbackText: renderFastModeStatusPlain(info),
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^sessws_page_(\d+)$/, "sessws", pendingSessionWorkspaceButtons, "Expired, run /sessions again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /think again");
  handlePageCallback(/^fast_page_(\d+)$/, "fast", pendingFastButtons, "Expired, run /fast again");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await session.abort();
  });

  bot.callbackQuery(/^approval:([^:]+):(accept|acceptForSession|decline|cancel)$/, async (ctx) => {
    const approvalId = ctx.match?.[1];
    const decision = ctx.match?.[2] as CodexApprovalResponse["decision"] | undefined;
    if (!approvalId || !decision) {
      await ctx.answerCallbackQuery();
      return;
    }

    const pending = pendingApprovals.get(approvalId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Approval expired" });
      return;
    }

    pendingApprovals.delete(approvalId);
    clearTimeout(pending.timeout);
    pending.resolve({ decision });
    await ctx.answerCallbackQuery({ text: `Sent: ${decision}` });
    if (ctx.chat && ctx.callbackQuery.message?.message_id) {
      await safeEditMessage(
        bot,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `<b>Approval ${escapeHTML(decision)}</b>`,
        { fallbackText: `Approval ${decision}` },
      );
    }
  });

  bot.callbackQuery(/^sessws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || !messageId || Number.isNaN(index)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      await ctx.answerCallbackQuery();
      return;
    }

    const { contextKey, session } = contextSession;
    const groups = pendingSessionWorkspacePicks.get(contextKey);
    const group = groups?.[index];
    if (!group) {
      await ctx.answerCallbackQuery({ text: "Expired, run /sessions again" });
      return;
    }

    await ctx.answerCallbackQuery();
    const activeThreadId = session.getInfo().threadId;
    const orderedSessions = [...group.sessions].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );
    const sessionButtons = orderedSessions.map((listedSession, sessionIndex) => ({
      label: formatSessionLabel({
        workspace: listedSession.cwd,
        title: listedSession.title || listedSession.firstUserMessage || "",
        relativeTime: formatRelativeTime(listedSession.updatedAt),
        model: listedSession.model || undefined,
        isActive: listedSession.id === activeThreadId,
      }),
      callbackData: `sess_${sessionIndex}`,
    }));
    pendingSessionButtons.set(contextKey, sessionButtons);

    const html = [
      "<b>Recent threads</b>",
      `<b>Workspace:</b> <code>${escapeHTML(group.workspace)}</code>`,
      "",
      "Tap to switch.",
    ].join("\n");
    const plain = ["Recent threads", `Workspace: ${group.workspace}`, "", "Tap to switch."].join("\n");
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");
    keyboard.row().text("← Workspaces", "sessback");
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: plain,
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery("sessback", async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const contextKey = contextKeyFromCtx(ctx);
    const buttons = contextKey ? pendingSessionWorkspaceButtons.get(contextKey) : undefined;
    if (!contextKey || !buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /sessions again" });
      return;
    }

    await ctx.answerCallbackQuery();
    await safeEditMessage(bot, chatId, messageId, "<b>Recent workspaces</b>:\nChoose a project first.", {
      fallbackText: "Recent workspaces:\nChoose a project first.",
      replyMarkup: paginateKeyboard(buttons, 0, "sessws"),
    });
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);
    pendingSessionWorkspacePicks.delete(contextKey);
    pendingSessionWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `Switched session.\n\n${renderSessionInfoPlain(info, instanceName)}`;
      const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info, instanceName)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating thread..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info, instanceName)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info, instanceName)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "If a thread is active, TeleCodex will reattach it with this profile.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${formatLaunchProfileBehavior(profile)}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "If a thread is active, TeleCodex will reattach it with this profile.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await applyLaunchProfileSelection(ctx, contextKey, session, profile, { chatId, messageId });
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    await applyLaunchProfileSelection(ctx, contextKey, session, profile, {
      chatId,
      messageId,
      confirmedUnsafe: true,
    });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Model set to</b> <code>${escapeHTML(model)}</code> — applies to new threads.`;
      const plainText = `Model set to ${model} — applies to new threads.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_set_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effortOption = decodeCallbackValue(ctx.match?.[1]);

    if (!chatId || !messageId || !effortOption) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_set_${encodeCallbackValue(effortOption)}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /think again" });
      return;
    }

    const effort = effortOption === "default" ? undefined : effortOption;
    const label = effort ?? "model default";
    await ctx.answerCallbackQuery({ text: `Thinking set to ${label}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Thinking set to <code>${escapeHTML(label)}</code> — applies to new threads or reattached threads.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Thinking set to ${label} — applies to new threads or reattached threads.`,
    });
  });

  bot.callbackQuery(/^fast_(on|off|once|status)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const fastOption = ctx.match?.[1];

    if (!chatId || !messageId || !fastOption || !isFastModeOption(fastOption)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingFastButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `fast_${fastOption}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /fast again" });
      return;
    }

    if (isBusy(contextKey) && fastOption !== "status" && fastOption !== "once") {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: fastOption === "status" ? "Fast status" : "Updating fast mode..." });

    try {
      if (fastOption === "on") {
        await session.setFastModeAndReattach(true);
      } else if (fastOption === "off") {
        await session.setFastModeAndReattach(false);
      } else if (fastOption === "once") {
        session.setFastOnce();
      }
      pendingFastButtons.delete(contextKey);
      updateSessionMetadata(contextKey, session);
      const info = session.getInfo();
      await safeEditMessage(bot, chatId, messageId, renderFastModeStatusHTML(info), {
        fallbackText: renderFastModeStatusPlain(info),
      });
    } catch (error) {
      const message = friendlyErrorText(error);
      await safeEditMessage(bot, chatId, messageId, `<b>Failed:</b> ${escapeHTML(message)}`, {
        fallbackText: `Failed: ${message}`,
      });
    }
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText) {
      return;
    }

    if (userText.startsWith("/")) {
      await warnUnknownSlashInput(ctx, userText);
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (getBusyState(contextKey).compacting) {
      const queued = enqueuePrompt(contextKey, ctx, ctx.chat.id, userText);
      if (!queued) {
        await safeReply(ctx, escapeHTML(`Queue is full (${MAX_PROMPT_QUEUE_SIZE}/${MAX_PROMPT_QUEUE_SIZE}).`), {
          fallbackText: `Queue is full (${MAX_PROMPT_QUEUE_SIZE}/${MAX_PROMPT_QUEUE_SIZE}).`,
        });
        return;
      }

      const position = getPromptQueue(contextKey).findIndex((item) => item.id === queued.id) + 1;
      await safeReply(ctx, `<b>Queued during compact #${queued.id}</b> position <code>${position}</code>`, {
        fallbackText: `Queued during compact #${queued.id} position ${position}`,
      });
      return;
    }

    lastPromptInput.set(contextKey, userText);
    runPromptInBackground(ctx, contextKey, ctx.chat.id, session, userText);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      const preview = trimLine(transcript.replace(/\s+/g, " "), 100);
      await safeReply(
        ctx,
        `🎙️ <b>Transcribed:</b> ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎙️ Transcribed: ${preview} (via ${result.backend})` },
      );
    } catch (error) {
      const note = "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    lastPromptInput.set(contextKey, transcript);
    runPromptInBackground(ctx, contextKey, chatId, session, transcript);
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }
    runPromptInBackground(ctx, contextKey, chatId, session, promptInput, async () => {
      await unlink(tempFilePath).catch(() => {});
    });
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }

    runPromptInBackground(ctx, contextKey, chatId, session, promptInput, async () => {
      try {
        await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
      } catch (artifactError) {
        console.error("Failed to deliver artifacts:", artifactError);
      } finally {
        await cleanupInbox(workspace, turnId);
        // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
      }
    });
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "new", description: "Start a new thread" },
    { command: "status", description: "Codex auth & session status" },
    { command: "doctor", description: "Check runtime environment" },
    { command: "locks", description: "Show runtime lock files" },
    { command: "reconnect", description: "Reconnect Codex app-server" },
    { command: "compact", description: "Compact current Codex context" },
    { command: "session", description: "Current thread details" },
    { command: "sessions", description: "Browse & switch threads" },
    { command: "switch", description: "Switch to a thread by ID" },
    { command: "attach", description: "Bind a Codex thread to this topic" },
    { command: "handback", description: "Hand thread to Codex CLI" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "queue", description: "Queue prompts for this context" },
    { command: "steer", description: "Steer the active Codex turn" },
    { command: "ask", description: "Send slash-looking text as prompt" },
    { command: "prompt", description: "Alias for ask" },
    { command: "abort", description: "Cancel current operation" },
    { command: "stop", description: "Cancel current operation" },
    { command: "launch_profiles", description: "Select launch profile" },
    { command: "permission", description: "Change runtime permission profile" },
    { command: "profile", description: "Alias for permission" },
    { command: "approvals", description: "List pending approvals" },
    { command: "model", description: "View & change model" },
    { command: "think", description: "Set thinking effort" },
    { command: "fast", description: "Toggle Codex fast mode" },
    { command: "auth", description: "Check auth status" },
    { command: "login", description: "Start authentication" },
    { command: "logout", description: "Sign out" },
    { command: "voice", description: "Voice transcription status" },
    { command: "update", description: "Update current service instance" },
    { command: "service_update", description: "Alias for update" },
    { command: "restart", description: "Restart current service" },
    { command: "force_restart", description: "Alias for restart" },
    { command: "service_restart", description: "Alias for restart" },
    { command: "files", description: "List workspace files" },
    { command: "tree", description: "Show workspace tree" },
    { command: "find", description: "Find workspace files" },
    { command: "search", description: "Search workspace files" },
    { command: "sendfile", description: "Send a workspace file" },
    { command: "file", description: "Alias for sendfile" },
    { command: "download", description: "Alias for sendfile" },
    { command: "view", description: "View a workspace file" },
    { command: "grep", description: "Search workspace text" },
  ]);
}

type FastModeOption = "on" | "off" | "once" | "status";

function isFastModeOption(value: string): value is FastModeOption {
  return value === "on" || value === "off" || value === "once" || value === "status";
}

function buildFastModeButtons(info: CodexSessionInfo): KeyboardItem[] {
  const active = info.fastMode ? "on" : info.fastOnce ? "once" : "off";
  const options: Array<{ option: FastModeOption; label: string }> = [
    { option: "on", label: "Fast on" },
    { option: "off", label: "Fast off" },
    { option: "once", label: "Fast once" },
    { option: "status", label: "Status" },
  ];
  return options.map(({ option, label }) => ({
    label: option === active ? `${label} ✓` : label,
    callbackData: `fast_${option}`,
  }));
}

function formatFastModeValue(info: CodexSessionInfo): string {
  if (info.fastMode) {
    return "on";
  }
  if (info.fastOnce) {
    return "once (next turn)";
  }
  return info.serviceTier ? `off · detected ${info.serviceTier}` : "off";
}

function renderFastModeStatusPlain(info: CodexSessionInfo): string {
  return [
    "Fast mode",
    `State: ${formatFastModeValue(info)}`,
    `Service tier: ${info.serviceTier ?? "(default)"}`,
    `Model: ${info.model ?? "(default)"}`,
    `Thinking: ${info.reasoningEffort ?? "(default)"}`,
    `Thread: ${info.threadId ?? "(not started yet)"}`,
    "",
    "Commands: /fast on, /fast off, /fast once, /fast status",
  ].join("\n");
}

function renderFastModeStatusHTML(info: CodexSessionInfo): string {
  return [
    "<b>Fast mode</b>",
    `<b>State:</b> <code>${escapeHTML(formatFastModeValue(info))}</code>`,
    `<b>Service tier:</b> <code>${escapeHTML(info.serviceTier ?? "(default)")}</code>`,
    `<b>Model:</b> <code>${escapeHTML(info.model ?? "(default)")}</code>`,
    `<b>Thinking:</b> <code>${escapeHTML(info.reasoningEffort ?? "(default)")}</code>`,
    `<b>Thread:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    "",
    "<code>/fast on</code> · <code>/fast off</code> · <code>/fast once</code> · <code>/fast status</code>",
  ].join("\n");
}

function renderCompactStatusPlain(info: CodexSessionInfo): string {
  return [
    "Compact status",
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    `Model: ${info.model ?? "(default)"}`,
    `Reasoning effort: ${info.reasoningEffort ?? "(default)"}`,
    `Fast mode: ${formatFastModeValue(info)}`,
    "",
    "Step 1: app-server native compact",
    "Step 2: Codex CLI PTY /compact",
    "Preview: not available through native compact",
    "Queue: incoming text is queued while compact is running",
  ].join("\n");
}

function renderCompactStatusHTML(info: CodexSessionInfo): string {
  return [
    "<b>Compact status</b>",
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(`${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`)}</code>`,
    `<b>Model:</b> <code>${escapeHTML(info.model ?? "(default)")}</code>`,
    `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort ?? "(default)")}</code>`,
    `<b>Fast mode:</b> <code>${escapeHTML(formatFastModeValue(info))}</code>`,
    "",
    "<b>Step 1:</b> app-server native compact",
    "<b>Step 2:</b> Codex CLI PTY <code>/compact</code>",
    "<b>Preview:</b> not available through native compact",
    "<b>Queue:</b> incoming text is queued while compact is running",
  ].join("\n");
}

function renderSessionInfoPlain(info: CodexSessionInfo, instanceName?: string): string {
  return [
    instanceName ? `Instance: ${instanceName}` : undefined,
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    `Fast mode: ${formatFastModeValue(info)}`,
    info.contextWindow ? formatContextWindowPlain(info.contextWindow) : "Context window: unknown",
    info.lastTurnTokens ? formatLastTurnTokensPlain(info.lastTurnTokens) : "Last turn usage: none yet",
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function renderSessionInfoHTML(info: CodexSessionInfo, instanceName?: string): string {
  return [
    instanceName ? `<b>Instance:</b> <code>${escapeHTML(instanceName)}</code>` : undefined,
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Launch behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    `<b>Fast mode:</b> <code>${escapeHTML(formatFastModeValue(info))}</code>`,
    info.contextWindow
      ? `<b>Context window:</b> <code>${escapeHTML(formatContextWindowValue(info.contextWindow))}</code>`
      : "<b>Context window:</b> <code>unknown</code>",
    info.lastTurnTokens
      ? `<b>Last turn usage:</b> <code>${escapeHTML(formatLastTurnTokensValue(info.lastTurnTokens))}</code>`
      : "<b>Last turn usage:</b> <code>none yet</code>",
    info.sessionTokens ? `<b>Session usage:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderMobileStatus(options: {
  authStatus: string;
  authMethod: string;
  runtimeBackend: string;
  runtime: string;
  compactState: string;
  approvalBridge: string;
  appServerStatus: string;
  queueCount: number;
  instanceName?: string;
  info: CodexSessionInfo;
  statusDetails: CodexStatusDetails;
}): { plainLines: string[]; htmlLines: string[] } {
  const info = options.info;
  const details = options.statusDetails;
  const account = details.account ? formatAccountStatus(details.account) : "unknown";
  const context = info.contextWindow ? formatContextWindowValue(info.contextWindow) : "usage unavailable";
  const thread = shortId(info.threadId);
  const session = shortId(details.thread?.sessionId);
  const model = info.reasoningEffort ? `${info.model ?? "(default)"} · ${info.reasoningEffort}` : info.model ?? "(default)";
  const fastMode = formatFastModeValue(info);
  const appServer = summarizeAppServerStatus(options.appServerStatus);
  const approvals = summarizeApprovalBridge(options.approvalBridge, info.approvalPolicy);
  const agents = formatAgentsSummary(details.thread?.instructionSources ?? []);
  const limits = formatRateLimitsCompact(details.rateLimits);
  const usage = details.accountUsage ? formatAccountUsageCompact(details.accountUsage) : undefined;

  const plainLines = [
    "Codex status",
    `Auth: ${options.authStatus} (${options.authMethod})`,
    `Account: ${account}`,
    usage ? `Usage: ${usage}` : undefined,
    "",
    "Session",
    `Instance: ${options.instanceName ?? "default"} · Queue: ${options.queueCount}`,
    `Thread: ${thread}${session ? ` · Session: ${session}` : ""}`,
    `Workspace: ${info.workspace}`,
    `Model: ${model}`,
    `Fast: ${fastMode}`,
    `Context: ${context}`,
    "",
    "Runtime",
    `State: ${options.runtime} · ${options.runtimeBackend}`,
    `App-server: ${appServer}`,
    `Launch: ${info.launchProfileLabel} · ${info.launchProfileBehavior}`,
    `Compact: ${options.compactState} · Approval: ${approvals}`,
    details.thread?.approvalsReviewer ? `Reviewer: ${details.thread.approvalsReviewer}` : undefined,
    agents ? `Agents: ${agents}` : undefined,
    limits.length > 0 ? "" : undefined,
    ...limits,
    details.error ? `Warning: ${details.error}` : undefined,
  ].filter((line): line is string => line !== undefined);

  const htmlLines = [
    "<b>Codex status</b>",
    `<b>Auth:</b> <code>${escapeHTML(options.authStatus)} (${escapeHTML(options.authMethod)})</code>`,
    `<b>Account:</b> <code>${escapeHTML(account)}</code>`,
    usage ? `<b>Usage:</b> <code>${escapeHTML(usage)}</code>` : undefined,
    "",
    "<b>Session</b>",
    `<b>Instance:</b> <code>${escapeHTML(options.instanceName ?? "default")}</code> · <b>Queue:</b> <code>${options.queueCount}</code>`,
    `<b>Thread:</b> <code>${escapeHTML(thread)}</code>${session ? ` · <b>Session:</b> <code>${escapeHTML(session)}</code>` : ""}`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Model:</b> <code>${escapeHTML(model)}</code>`,
    `<b>Fast:</b> <code>${escapeHTML(fastMode)}</code>`,
    `<b>Context:</b> <code>${escapeHTML(context)}</code>`,
    "",
    "<b>Runtime</b>",
    `<b>State:</b> <code>${escapeHTML(options.runtime)} · ${escapeHTML(options.runtimeBackend)}</code>`,
    `<b>App-server:</b> <code>${escapeHTML(appServer)}</code>`,
    `<b>Launch:</b> <code>${escapeHTML(`${info.launchProfileLabel} · ${info.launchProfileBehavior}`)}</code>`,
    `<b>Compact:</b> <code>${escapeHTML(options.compactState)}</code> · <b>Approval:</b> <code>${escapeHTML(approvals)}</code>`,
    details.thread?.approvalsReviewer
      ? `<b>Reviewer:</b> <code>${escapeHTML(details.thread.approvalsReviewer)}</code>`
      : undefined,
    agents ? `<b>Agents:</b> <code>${escapeHTML(agents)}</code>` : undefined,
    limits.length > 0 ? "" : undefined,
    ...limits.map((line) => `<code>${escapeHTML(line)}</code>`),
    details.error ? `<b>Warning:</b> <code>${escapeHTML(details.error)}</code>` : undefined,
  ].filter((line): line is string => line !== undefined);

  return { plainLines, htmlLines };
}

function isReasoningEffortOption(value: string, efforts: string[]): boolean {
  return efforts.includes(value);
}

function encodeCallbackValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCallbackValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function buildChannelResponseHeader(
  workspace: string,
  userInput: CodexPromptInput,
  totalParts: number,
): { workspace: string; prompt: string; totalParts: number } {
  return {
    workspace,
    prompt: summarizeUserInputForChannel(userInput),
    totalParts,
  };
}

function renderChannelResponseHeaderHTML(
  header: { workspace: string; prompt: string; totalParts: number },
  part: number,
): string {
  return [
    `<b>Project:</b> <code>${escapeHTML(header.workspace)}</code>`,
    `<b>Last user:</b> <code>${escapeHTML(header.prompt)}</code>`,
    header.totalParts > 1 ? `<b>Part:</b> <code>${part}/${header.totalParts}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderChannelResponseHeaderPlain(
  header: { workspace: string; prompt: string; totalParts: number },
  part: number,
): string {
  return [
    `Project: ${header.workspace}`,
    `Last user: ${header.prompt}`,
    header.totalParts > 1 ? `Part: ${part}/${header.totalParts}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function summarizeUserInputForChannel(userInput: CodexPromptInput): string {
  const parts: string[] = [];

  if (typeof userInput === "string") {
    parts.push(userInput);
  } else {
    if (userInput.text) {
      parts.push(userInput.text);
    }
    if (userInput.imagePaths?.length) {
      parts.push(`[${userInput.imagePaths.length} image attachment(s)]`);
    }
    if (userInput.stagedFileInstructions) {
      parts.push(userInput.stagedFileInstructions);
    }
  }

  const text = parts.join(" ").replace(/\s+/g, " ").trim() || "(non-text input)";
  return truncateForChannelHeader(text, 360);
}

function summarizePromptForLog(userInput: CodexPromptInput): string {
  return truncateForChannelHeader(summarizeUserInputForChannel(userInput), 120);
}

function truncateForChannelHeader(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function formatResponseSegment(text: string): string {
  const body = text.replace(/^\s*\n+/, "").trimEnd();
  return body ? `${RESPONSE_HEADER}\n\n${body}` : "";
}

function renderResponsePlaceholder(): RenderedText {
  return {
    text: `<b>${escapeHTML(RESPONSE_HEADER)}</b>`,
    fallbackText: RESPONSE_HEADER,
    parseMode: "HTML",
  };
}

async function warnUnknownSlashInput(ctx: Context, text: string): Promise<void> {
  const command = text.split(/\s+/, 1)[0] ?? text;
  const pathLike = isSlashPathLike(text);
  const htmlLines = [
    "<b>Unknown slash command.</b>",
    `<code>${escapeHTML(command)}</code> was treated as a Telegram bot command, not a Codex prompt.`,
    "",
    pathLike
      ? "If this is a path, send it with context, for example:"
      : "If you wanted to send this to Codex, use:",
    pathLike ? `<code>Use this path: ${escapeHTML(text)}</code>` : undefined,
    pathLike ? "<code>/view &lt;path&gt;</code> for file viewing" : undefined,
    "<code>/ask &lt;prompt&gt;</code>",
  ].filter((line): line is string => Boolean(line));
  const plainLines = [
    "Unknown slash command.",
    `${command} was treated as a Telegram bot command, not a Codex prompt.`,
    "",
    pathLike
      ? "If this is a path, send it with context, for example:"
      : "If you wanted to send this to Codex, use:",
    pathLike ? `Use this path: ${text}` : undefined,
    pathLike ? "/view <path> for file viewing" : undefined,
    "/ask <prompt>",
  ].filter((line): line is string => Boolean(line));

  await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
}

function isSlashPathLike(text: string): boolean {
  return /^\/(?:home|tmp|var|workspace|mnt|opt|usr|etc|srv|root|Users)\//.test(text) || /^\/[^@\s]+(?:\/|\.)/.test(text);
}

function renderToolStartMessage(toolName: string): RenderedText {
  const label = formatToolDisplayLabel(toolName);
  const detail = renderToolDetail(label);
  return {
    text: [`<b>${escapeHTML(label.icon)} ${escapeHTML(label.title)}:</b>`, detail.html].join("\n"),
    fallbackText: [`${label.icon} ${label.title}:`, detail.plain].join("\n"),
    parseMode: "HTML",
  };
}

function renderToolRunningMessage(toolName: string, partialResult: string): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const label = formatToolDisplayLabel(toolName);
  const detail = renderToolDetail(label);
  const htmlLines = [`<b>${escapeHTML(label.icon)} ${escapeHTML(label.title)}:</b>`, detail.html];
  const plainLines = [`${label.icon} ${label.title}:`, detail.plain];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const label = formatToolDisplayLabel(toolName);
  const status = isError ? "Tool failed" : "Tool done";
  const statusIcon = isError ? "❌" : "✅";
  const detail = renderToolDetail(label);
  const htmlLines = [`<b>${escapeHTML(statusIcon)} ${escapeHTML(status)}:</b> <code>${escapeHTML(label.kind)}</code>`, detail.html];
  const plainLines = [`${statusIcon} ${status}: \`${label.kind}\``, detail.plain];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolDisplayLabel(toolName: string): { icon: string; title: string; kind: string; detail: string } {
  if (toolName === "file_change") {
    return { icon: "📝", title: "File change", kind: "file_change", detail: "workspace edits" };
  }

  if (toolName === "context_compaction") {
    return { icon: "🗜️", title: "Context compact", kind: "compact", detail: "conversation history compaction" };
  }

  if (toolName === "reasoning") {
    return { icon: "🧠", title: "Reasoning", kind: "reasoning", detail: "summary stream" };
  }

  if (toolName === "app_server_warning") {
    return { icon: "⚠️", title: "App-server warning", kind: "warning", detail: "runtime warning" };
  }

  if (toolName === "app_server_error") {
    return { icon: "⚠️", title: "App-server error", kind: "error", detail: "runtime error" };
  }

  if (toolName === "⚠️ error") {
    return { icon: "⚠️", title: "Tool error", kind: "error", detail: "runtime error" };
  }

  if (toolName.startsWith("🔍 ")) {
    return { icon: "🌐", title: "Web search", kind: "web_search", detail: toolName.slice(3).trim() || "search" };
  }

  if (toolName.startsWith("mcp:")) {
    const descriptor = toolName.slice("mcp:".length);
    const [server = "mcp", tool = descriptor] = descriptor.split("/");
    return { icon: "🧩", title: "MCP tool", kind: "mcp", detail: `${server}/${tool}` };
  }

  if (toolName.startsWith("dynamic:")) {
    const descriptor = toolName.slice("dynamic:".length);
    const [namespace = "tool", tool = descriptor] = descriptor.split("/");
    return { icon: "🧰", title: "Dynamic tool", kind: "dynamic", detail: `${namespace}/${tool}` };
  }

  return { icon: "💻", title: "Shell command", kind: "bash", detail: normalizeShellToolName(toolName) };
}

function renderToolDetail(label: { kind: string; detail: string }): { html: string; plain: string } {
  if (shouldRenderToolDetailBlock(label)) {
    return {
      html: `<pre>${escapeHTML(label.detail)}</pre>`,
      plain: `\`\`\`\n${label.detail}\n\`\`\``,
    };
  }

  return {
    html: `<code>${escapeHTML(label.detail)}</code>`,
    plain: `\`${label.detail}\``,
  };
}

function shouldRenderToolDetailBlock(label: { kind: string; detail: string }): boolean {
  return label.kind === "bash" && (label.detail.length > 80 || label.detail.includes("\n"));
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

function normalizeShellToolName(toolName: string): string {
  if (toolName === "/bin/bash") {
    return "/bin/bash";
  }

  return toolName;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

type SessionTokenSummary = { input: number; cached: number; output: number };
type ContextWindowSummary = NonNullable<CodexSessionInfo["contextWindow"]>;

function formatSessionTokensValue(tokens: SessionTokenSummary): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: SessionTokenSummary): string {
  return `Session usage: ${formatSessionTokensValue(tokens)}`;
}

function formatLastTurnTokensValue(tokens: SessionTokenSummary): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatLastTurnTokensPlain(tokens: SessionTokenSummary): string {
  return `Last turn usage: ${formatLastTurnTokensValue(tokens)}`;
}

function formatContextWindowValue(context: ContextWindowSummary): string {
  const base = `effective: ${formatTokenCount(context.effectiveLimit)}/${formatTokenCount(context.limit)}`;
  if (context.used === undefined || context.remaining === undefined || context.percentUsed === undefined) {
    return `${base} · usage unavailable until next turn`;
  }

  const leftPercent = Math.max(0, 100 - context.percentUsed);
  return `${leftPercent}% left (${formatTokenCount(context.used)} used / ${formatTokenCount(context.effectiveLimit)})`;
}

function formatContextWindowPlain(context: ContextWindowSummary): string {
  return `Context usage: ${formatContextWindowValue(context)}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function renderApprovalBridgeStatus(
  info: CodexSessionInfo,
  appServerRuntimeEnabled: boolean,
): { plain: string; html: string } {
  if (info.approvalPolicy === "never") {
    return { plain: "not needed (approval never)", html: "not needed (approval never)" };
  }

  if (appServerRuntimeEnabled) {
    return {
      plain: "Telegram approval enabled for app-server requests",
      html: "Telegram approval enabled for app-server requests",
    };
  }

  return {
    plain: "SDK cannot forward approval prompts; app-server runtime required",
    html: "SDK cannot forward approval prompts; app-server runtime required",
  };
}

function renderApprovalRequest(request: CodexApprovalRequest): { html: string; plain: string } {
  const params = readUnknownRecord(request.params);
  const command = readUnknownString(params?.command);
  const cwd = readUnknownString(params?.cwd);
  const reason = readUnknownString(params?.reason);
  const grantRoot = readUnknownString(params?.grantRoot);
  const title =
    request.method === "item/commandExecution/requestApproval"
      ? "Codex approval requested: command"
      : request.method === "item/fileChange/requestApproval"
        ? "Codex approval requested: file change"
        : request.method === "item/permissions/requestApproval"
          ? "Codex approval requested: permission"
          : "Codex approval requested";
  const detail = command ?? grantRoot ?? reason ?? request.method;

  const plain = [
    title,
    cwd ? `cwd: ${cwd}` : undefined,
    reason ? `reason: ${reason}` : undefined,
    detail ? `request: ${detail}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const html = [
    `<b>${escapeHTML(title)}</b>`,
    cwd ? `<b>cwd:</b> <code>${escapeHTML(cwd)}</code>` : undefined,
    reason ? `<b>reason:</b> <code>${escapeHTML(reason)}</code>` : undefined,
    detail ? `<b>request:</b>\n<pre>${escapeHTML(truncateForTelegramPre(detail, 1200))}</pre>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  return { html, plain };
}

function renderPendingApprovals(
  approvals: Array<[string, PendingApproval]>,
): { html: string; plain: string } {
  const htmlLines: Array<string | undefined> = [`<b>Pending approvals:</b> <code>${approvals.length}</code>`];
  const plainLines: Array<string | undefined> = [`Pending approvals: ${approvals.length}`];

  for (const [, approval] of approvals) {
    const requestSummary = summarizeApprovalRequestForList(approval.request);
    const age = formatDuration(Date.now() - approval.createdAt);
    htmlLines.push(
      "",
      `<b>#${escapeHTML(approval.shortId)}</b> · <code>${escapeHTML(requestSummary.type)}</code> · <code>${escapeHTML(age)} ago</code>`,
      requestSummary.cwd ? `<b>cwd:</b> <code>${escapeHTML(requestSummary.cwd)}</code>` : undefined,
      `<b>Copy id:</b> <code>${escapeHTML(approval.shortId)}</code>`,
      `<b>Request:</b>`,
      `<pre>${escapeHTML(truncateForTelegramPre(requestSummary.detail, 1200))}</pre>`,
    );
    plainLines.push(
      "",
      `#${approval.shortId} · ${requestSummary.type} · ${age} ago`,
      requestSummary.cwd ? `cwd: ${requestSummary.cwd}` : undefined,
      `copy id: ${approval.shortId}`,
      "request:",
      truncateForTelegramPre(requestSummary.detail, 1200),
    );
  }

  htmlLines.push("", "Use the inline buttons on the original approval message to resolve the request.");
  plainLines.push("", "Use the inline buttons on the original approval message to resolve the request.");

  return {
    html: htmlLines.filter((line): line is string => line !== undefined).join("\n"),
    plain: plainLines.filter((line): line is string => line !== undefined).join("\n"),
  };
}

function summarizeApprovalRequestForList(request: CodexApprovalRequest): {
  type: string;
  cwd?: string;
  detail: string;
} {
  const params = readUnknownRecord(request.params);
  const command = readUnknownString(params?.command);
  const cwd = readUnknownString(params?.cwd);
  const reason = readUnknownString(params?.reason);
  const grantRoot = readUnknownString(params?.grantRoot);
  const type =
    request.method === "item/commandExecution/requestApproval"
      ? "command"
      : request.method === "item/fileChange/requestApproval"
        ? "file change"
        : request.method === "item/permissions/requestApproval"
          ? "permission"
          : "approval";

  return {
    type,
    cwd,
    detail: command ?? grantRoot ?? reason ?? request.method,
  };
}

function readUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readUnknownString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncateForTelegramPre(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function formatRuntimeStatusPlain(status: CodexRuntimeStatus): string {
  if (!status.appServerEnabled) {
    return "disabled (SDK fallback)";
  }

  const parts = [
    status.appServerRunning ? "process running" : "process not started",
    status.appServerInitialized ? "initialized" : "not initialized",
    status.currentTurnId ? `turn ${status.currentTurnId}` : undefined,
    `notifications ${status.recentNotificationCount}`,
    status.recentProblem ? `last ${status.recentProblem}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function renderCodexStatusDetailsPlain(details: CodexStatusDetails): string[] {
  const lines: string[] = [];
  if (details.account) {
    lines.push(`Account: ${formatAccountStatus(details.account)}`);
  }
  if (details.thread) {
    if (details.thread.sessionId) {
      lines.push(`Session: ${details.thread.sessionId}`);
    }
    if (details.thread.cliVersion || details.thread.source) {
      lines.push(
        `Thread source: ${[details.thread.source, details.thread.cliVersion].filter(Boolean).join(" · ")}`,
      );
    }
    if (details.thread.activePermissionProfile) {
      lines.push(`Permission profile: ${details.thread.activePermissionProfile}`);
    }
    if (details.thread.approvalsReviewer) {
      lines.push(`Approvals reviewer: ${details.thread.approvalsReviewer}`);
    }
    if (details.thread.instructionSources.length > 0) {
      lines.push(`Agents.md: ${details.thread.instructionSources.join(", ")}`);
    }
  }
  if (details.accountUsage) {
    lines.push(`Account usage: ${formatAccountUsageCompact(details.accountUsage)}`);
  }
  for (const rateLimit of details.rateLimits) {
    lines.push(...formatRateLimitPlain(rateLimit));
  }
  if (details.error) {
    lines.push(`Status detail warning: ${details.error}`);
  }
  return lines;
}

function renderCodexStatusDetailsHTML(details: CodexStatusDetails): string[] {
  const lines: string[] = [];
  if (details.account) {
    lines.push(`<b>Account:</b> <code>${escapeHTML(formatAccountStatus(details.account))}</code>`);
  }
  if (details.thread) {
    if (details.thread.sessionId) {
      lines.push(`<b>Session:</b> <code>${escapeHTML(details.thread.sessionId)}</code>`);
    }
    if (details.thread.cliVersion || details.thread.source) {
      lines.push(
        `<b>Thread source:</b> <code>${escapeHTML([details.thread.source, details.thread.cliVersion].filter(Boolean).join(" · "))}</code>`,
      );
    }
    if (details.thread.activePermissionProfile) {
      lines.push(`<b>Permission profile:</b> <code>${escapeHTML(details.thread.activePermissionProfile)}</code>`);
    }
    if (details.thread.approvalsReviewer) {
      lines.push(`<b>Approvals reviewer:</b> <code>${escapeHTML(details.thread.approvalsReviewer)}</code>`);
    }
    if (details.thread.instructionSources.length > 0) {
      lines.push(`<b>Agents.md:</b> <code>${escapeHTML(details.thread.instructionSources.join(", "))}</code>`);
    }
  }
  if (details.accountUsage) {
    lines.push(`<b>Account usage:</b> <code>${escapeHTML(formatAccountUsageCompact(details.accountUsage))}</code>`);
  }
  for (const rateLimit of details.rateLimits) {
    lines.push(...formatRateLimitHTML(rateLimit));
  }
  if (details.error) {
    lines.push(`<b>Status detail warning:</b> <code>${escapeHTML(details.error)}</code>`);
  }
  return lines;
}

function formatAccountStatus(account: NonNullable<CodexStatusDetails["account"]>): string {
  if (account.email) {
    return `${account.email}${account.planType ? ` (${account.planType})` : ""}`;
  }
  if (account.type === "none") {
    return account.requiresOpenaiAuth ? "not authenticated" : "none";
  }
  if (account.type === "personalAccessToken") {
    return account.planType ? `personal access token (${account.planType})` : "personal access token";
  }
  return account.planType ? `${account.type} (${account.planType})` : account.type;
}

function formatAccountUsageCompact(usage: NonNullable<CodexStatusDetails["accountUsage"]>): string {
  const parts = [
    usage.lifetimeTokens !== undefined ? `lifetime ${formatTokenCount(usage.lifetimeTokens)}` : undefined,
    usage.peakDailyTokens !== undefined ? `peak day ${formatTokenCount(usage.peakDailyTokens)}` : undefined,
    usage.currentStreakDays !== undefined ? `streak ${usage.currentStreakDays}d` : undefined,
    usage.longestRunningTurnSec !== undefined ? `longest turn ${formatDuration(usage.longestRunningTurnSec * 1000)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "unavailable";
}

function formatRateLimitPlain(limit: CodexStatusDetails["rateLimits"][number]): string[] {
  const name = limit.limitName ?? limit.limitId ?? "Codex";
  return [
    limit.primary ? `${name} 5h limit: ${formatRateLimitWindow(limit.primary)}` : undefined,
    limit.secondary ? `${name} weekly limit: ${formatRateLimitWindow(limit.secondary)}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function formatRateLimitHTML(limit: CodexStatusDetails["rateLimits"][number]): string[] {
  const name = limit.limitName ?? limit.limitId ?? "Codex";
  return [
    limit.primary
      ? `<b>${escapeHTML(name)} 5h limit:</b> <code>${escapeHTML(formatRateLimitWindow(limit.primary))}</code>`
      : undefined,
    limit.secondary
      ? `<b>${escapeHTML(name)} weekly limit:</b> <code>${escapeHTML(formatRateLimitWindow(limit.secondary))}</code>`
      : undefined,
  ].filter((line): line is string => Boolean(line));
}

function formatRateLimitWindow(window: NonNullable<CodexStatusDetails["rateLimits"][number]["primary"]>): string {
  const reset = window.resetsAt ? ` · resets ${formatUnixTimestamp(window.resetsAt)}` : "";
  const duration = window.windowDurationMins ? ` · window ${formatLimitDuration(window.windowDurationMins)}` : "";
  return `${Math.round(window.leftPercent)}% left (${Math.round(window.usedPercent)}% used)${duration}${reset}`;
}

function formatRateLimitsCompact(limits: CodexStatusDetails["rateLimits"]): string[] {
  if (limits.length === 0) {
    return [];
  }

  const ordered = [...limits].sort((left, right) => {
    const leftName = left.limitName ?? left.limitId ?? "";
    const rightName = right.limitName ?? right.limitId ?? "";
    if (leftName === "codex") return -1;
    if (rightName === "codex") return 1;
    return leftName.localeCompare(rightName);
  });

  return ordered.flatMap((limit) => {
    const name = shortenLimitName(limit.limitName ?? limit.limitId ?? "Codex");
    return [
      limit.primary ? `${name} 5h: ${formatRateLimitWindowCompact(limit.primary)}` : undefined,
      limit.secondary ? `${name} week: ${formatRateLimitWindowCompact(limit.secondary)}` : undefined,
    ].filter((line): line is string => Boolean(line));
  });
}

function formatRateLimitWindowCompact(
  window: NonNullable<CodexStatusDetails["rateLimits"][number]["primary"]>,
): string {
  const reset = window.resetsAt ? ` · reset ${formatUnixTimestampShort(window.resetsAt)}` : "";
  return `${Math.round(window.leftPercent)}% left${reset}`;
}

function shortenLimitName(name: string): string {
  if (name.toLowerCase() === "codex") {
    return "Codex";
  }
  return name
    .replace(/^gpt-/i, "GPT-")
    .replace(/-codex-/i, " Codex ")
    .replace(/-/g, " ");
}

function shortId(value: string | null | undefined): string {
  if (!value) {
    return "(none)";
  }
  if (value.length <= 13) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function summarizeAppServerStatus(value: string): string {
  return value
    .replace("process running", "running")
    .replace("process not started", "not started")
    .replace("notifications ", "events ");
}

function isAbortLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|aborted|interrupt|cancel/i.test(message);
}

function summarizeApprovalBridge(value: string, approvalPolicy: string): string {
  if (approvalPolicy === "never") {
    return "not needed";
  }
  if (value.includes("Telegram approval enabled")) {
    return "Telegram";
  }
  return value;
}

function formatAgentsSummary(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const names = paths.map((entry) => entry.replace(/^\/home\/[^/]+/, "~"));
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function formatUnixTimestamp(value: number): string {
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatUnixTimestampShort(value: number): string {
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatLimitDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${minutes}m`;
}

function formatElapsedDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.floor(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${totalMinutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

function getServiceInstanceName(): string {
  return getCurrentServiceInstanceName();
}

function startServiceCommand(command: "restart" | "update"): { instance: string; pid?: number } {
  const scriptPath = path.join(process.cwd(), "scripts", "telecodex-service.sh");
  const instance = getServiceInstanceName();
  const child = spawn(scriptPath, [command, instance], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });

  child.once("error", (error) => {
    console.error(`Service ${command} failed to launch for instance=${instance}:`, error);
  });
  child.unref();

  return { instance, pid: child.pid };
}

function startServiceUpdate(): { instance: string; pid?: number } {
  return startServiceCommand("update");
}

function scheduleServiceRestart(): void {
  const timer = setTimeout(() => {
    startServiceCommand("restart");
  }, 750);
  timer.unref();
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function renderStreamingMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatStreamingMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatStreamingMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function formatStreamingMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatStreamingTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format streaming Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function commandArgs(ctx: Context, command: string): string {
  const text = ctx.message?.text ?? "";
  return text.replace(new RegExp(`^/${command}(?:@\\w+)?\\s*`, "i"), "").trim();
}

function commandArgsAny(ctx: Context, commands: string[]): string {
  const text = ctx.message?.text ?? "";
  const pattern = commands.map(escapeRegExp).join("|");
  return text.replace(new RegExp(`^/(?:${pattern})(?:@\\w+)?\\s*`, "i"), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatWorkspaceEntryHTML(entry: WorkspaceEntry): string {
  const marker = entry.type === "dir" ? "dir " : entry.type === "symlink" ? "link" : "file";
  const suffix = entry.type === "dir" ? "/" : "";
  return `<code>${escapeHTML(marker)}</code> <code>${escapeHTML(`${entry.relativePath}${suffix}`)}</code>`;
}

function formatSessionWorkspaceLabel(group: SessionWorkspaceGroup): string {
  const newest = group.sessions[0];
  const workspaceName = trimLine(getWorkspaceShortName(group.workspace), 18) || "(unknown)";
  const count = group.sessions.length === 1 ? "1 thread" : `${group.sessions.length} threads`;
  const relativeTime = newest ? formatRelativeTime(newest.updatedAt) : "unknown";
  return `📁 ${workspaceName} · ${count} · ${relativeTime}`;
}

function parsePathAndDepth(raw: string): { pathArg: string; depth: number } {
  const parts = raw.split(/\s+/).filter(Boolean);
  const maybeDepth = Number.parseInt(parts.at(-1) ?? "", 10);
  if (Number.isInteger(maybeDepth) && parts.length > 0) {
    return {
      pathArg: parts.slice(0, -1).join(" "),
      depth: maybeDepth,
    };
  }

  return {
    pathArg: raw.trim(),
    depth: 2,
  };
}

function parseQueryAndPath(raw: string): { query: string; pathArg: string } {
  const parts = raw.split(/\s+/).filter(Boolean);
  return {
    query: parts[0] ?? "",
    pathArg: parts.slice(1).join(" "),
  };
}

function parseViewArgs(raw: string): { pathArg: string; range?: { start?: number; end?: number } } {
  const parts = raw.split(/\s+/).filter(Boolean);
  const maybeRange = parts.at(-1) ?? "";
  const rangeMatch = maybeRange.match(/^(\d*)?:(\d*)?$/);
  if (rangeMatch && parts.length > 1) {
    const start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : undefined;
    const end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : undefined;
    return {
      pathArg: parts.slice(0, -1).join(" "),
      range: { start, end },
    };
  }

  return { pathArg: raw.trim() };
}

function stripHTML(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
