import { createHash } from "node:crypto";

import { createBot, registerCommands, sendRecoveredTurnItem } from "./bot.js";
import {
  acknowledgeActiveOperationItem,
  claimActiveOperationRecovery,
  finishActiveOperation,
  markInterruptedOperations,
  setActiveOperationDeliveryState,
  updateActiveOperation,
  type ActiveOperationRecord,
} from "./active-operations.js";
import { checkAuthStatus } from "./codex-auth.js";
import type { CodexTurnRecoveryItem } from "./codex-session.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig, type TeleCodexConfig } from "./config.js";
import { escapeHTML } from "./format.js";
import { consumeServiceOperationMarkers, type ServiceOperationMarker } from "./service-operation-marker.js";
import { SessionRegistry } from "./session-registry.js";
import { installRuntimeFileLogger } from "./runtime-log.js";
import {
  claimTelegramDelivery,
  completeTelegramDelivery,
  failTelegramDelivery,
  scheduleTelegramDeliveryCleanup,
} from "./telegram-delivery-store.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let config: TeleCodexConfig | undefined;
let shuttingDown = false;
const COMMAND_REGISTRATION_TIMEOUT_MS = 10_000;
const RECOVERY_DELIVERY_MAX_ATTEMPTS = 3;
const recoveringOperationIds = new Set<string>();

try {
  config = loadConfig();
  const runtimeLogPath = installRuntimeFileLogger(config);
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  await registerCommandsSafely(bot);

  console.log("TeleCodex running");
  if (runtimeLogPath) {
    console.log(`Runtime file log: ${runtimeLogPath}`);
  }
  const authStatus = await checkAuthStatus(config.codexApiKey);
  console.log(`Auth: ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
  if (!authStatus.authenticated) {
    console.warn("Warning: Codex is not authenticated. Use /login or set CODEX_API_KEY.");
  }
  console.log(`Workspace: ${config.workspace}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
  await notifyLifecycle("started");
  await notifyServiceOperationRecovery();
  await notifyInterruptedOperations();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TeleCodex: ${message}`);
  registry?.disposeAll();
  process.exit(1);
}

const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  void (async () => {
    console.log(`Received ${signal}, shutting down TeleCodex...`);
    await notifyLifecycle("stopping", signal);
    if (bot) bot.stop();
  })().finally(() => {
    registry?.disposeAll();
    console.log("TeleCodex stopped.");
    process.exit(0);
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function registerCommandsSafely(telegramBot: NonNullable<typeof bot>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      registerCommands(telegramBot),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out after ${COMMAND_REGISTRATION_TIMEOUT_MS / 1000}s`)),
          COMMAND_REGISTRATION_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to register Telegram commands; continuing with polling: ${message}`);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: false,
      onStart: () => {
        restartAttempts = 0;
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();

async function notifyLifecycle(event: "started" | "stopping", signal?: NodeJS.Signals): Promise<void> {
  if (!bot || !config?.enableLifecycleNotifications) {
    return;
  }

  const instance = process.env.TELECODEX_INSTANCE?.trim() || "default";
  const lines =
    event === "started"
      ? [
          "<b>👋 TeleCodex is online.</b>",
          "<i>The Telegram bridge is connected and ready.</i>",
          "",
          `<b>Instance:</b> <code>${escapeHTML(instance)}</code>`,
          `<b>Workspace:</b> <code>${escapeHTML(config.workspace)}</code>`,
          `<b>Sandbox:</b> <code>${escapeHTML(config.codexSandboxMode)}</code>`,
          `<b>Approval:</b> <code>${escapeHTML(config.codexApprovalPolicy)}</code>`,
          "",
          "Send <code>/start</code> or <code>/status</code> to check the bot.",
        ]
      : [
          "<b>TeleCodex is stopping.</b>",
          signal ? `<b>Signal:</b> <code>${escapeHTML(signal)}</code>` : undefined,
          `<b>Instance:</b> <code>${escapeHTML(instance)}</code>`,
          `<b>Workspace:</b> <code>${escapeHTML(config.workspace)}</code>`,
        ];

  const message = lines.filter((line): line is string => Boolean(line)).join("\n");
  const chatIds = new Set(config.telegramAllowedUserIds);
  if (config.telegramChannelId !== undefined) {
    chatIds.add(config.telegramChannelId);
  }

  for (const chatId of chatIds) {
    try {
      await withTimeout(bot.api.sendMessage(chatId, message, { parse_mode: "HTML" }), 1500);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to send lifecycle notification to ${redactLogId(chatId)}: ${detail}`);
    }
  }
}

async function notifyInterruptedOperations(): Promise<void> {
  if (!bot || !config) {
    return;
  }

  const interrupted = markInterruptedOperations(config);
  for (const operation of interrupted) {
    if (operation.statusMessageId) {
      await bot.api.deleteMessage(operation.chatId, operation.statusMessageId).catch(() => undefined);
    }
    void recoverInterruptedOperation(operation);
  }
}

async function recoverInterruptedOperation(operation: ActiveOperationRecord): Promise<void> {
  if (recoveringOperationIds.has(operation.id)) {
    return;
  }
  const releaseRecoveryClaim = claimActiveOperationRecovery(config!, operation.id);
  if (!releaseRecoveryClaim) {
    return;
  }
  recoveringOperationIds.add(operation.id);
  try {
    await recoverClaimedInterruptedOperation(operation);
  } finally {
    recoveringOperationIds.delete(operation.id);
    releaseRecoveryClaim();
    if (config) {
      scheduleTelegramDeliveryCleanup(config);
    }
  }
}

async function recoverClaimedInterruptedOperation(operation: ActiveOperationRecord): Promise<void> {
  if (!bot || !config || !registry || !operation.threadId || operation.operation !== "turn") {
    await sendInterruptedOperationFallback(operation);
    return;
  }

  if (operation.deliveryState === "delivered") {
    finishActiveOperation(config, operation.id, "completed");
    return;
  }

  let recoveryMessageId: number | undefined;
  const deliveredItemIds = new Set(operation.deliveredItemIds ?? []);
  try {
    const session = await registry.getOrCreate(operation.contextKey, { deferThreadStart: true });
    if (session.getInfo().threadId !== operation.threadId) {
      await registry.resumeThread(operation.contextKey, session, operation.threadId);
      registry.updateMetadata(operation.contextKey, session);
    }

    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    while (!shuttingDown && Date.now() < deadline) {
      const snapshot = await session.getTurnRecoverySnapshot(operation.turnId);
      await replayRecoveredItems(operation, snapshot.items, deliveredItemIds);
      if (snapshot.threadStatus === "active" || snapshot.turnStatus === "inProgress") {
        if (!recoveryMessageId) {
          const message = await bot.api.sendMessage(
            operation.chatId,
            [
              "<b>Teleco reconnected to active Codex work.</b>",
              `<b>Thread:</b> <code>${escapeHTML(snapshot.threadId)}</code>`,
              snapshot.turnId ? `<b>Turn:</b> <code>${escapeHTML(snapshot.turnId)}</code>` : undefined,
              "The Codex daemon is still working. Missed messages are replayed individually while recovery continues.",
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
            {
              parse_mode: "HTML",
              ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
            },
          );
          recoveryMessageId = message.message_id;
          updateActiveOperation(config, operation.id, {
            statusMessageId: recoveryMessageId,
            turnId: snapshot.turnId ?? operation.turnId,
          });
        }
        await bot.api.sendChatAction(operation.chatId, "typing", {
          ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
        }).catch(() => undefined);
        await delay(5000);
        continue;
      }

      if (recoveryMessageId) {
        await bot.api.deleteMessage(operation.chatId, recoveryMessageId).catch(() => undefined);
      }
      if (snapshot.turnStatus === "completed") {
        setActiveOperationDeliveryState(config, operation.id, "completed-undelivered");
        if (snapshot.items.length === 0 && snapshot.agentText) {
          const delivered = await deliverRecoveredResponseWithRetry(operation, snapshot.agentText);
          if (!delivered) {
            await sendInterruptedOperationFallback(
              operation,
              `Final response delivery failed after ${RECOVERY_DELIVERY_MAX_ATTEMPTS} attempts.`,
            );
            finishActiveOperation(config, operation.id, "failed");
            return;
          }
        }
        setActiveOperationDeliveryState(config, operation.id, "delivered");
        finishActiveOperation(config, operation.id, "completed");
        return;
      }

      const terminalStatus = snapshot.turnStatus ?? snapshot.threadStatus;
      await bot.api.sendMessage(
        operation.chatId,
        [
          "<b>Codex work did not continue after restart.</b>",
          `<b>Status:</b> <code>${escapeHTML(terminalStatus)}</code>`,
          `<b>Thread:</b> <code>${escapeHTML(snapshot.threadId)}</code>`,
          snapshot.error ? `<b>Error:</b> <code>${escapeHTML(snapshot.error)}</code>` : undefined,
          "The thread history remains available and can be continued with a new prompt.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        {
          parse_mode: "HTML",
          ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
        },
      );
      finishActiveOperation(config, operation.id, snapshot.turnStatus === "interrupted" ? "aborted" : "failed");
      return;
    }

    throw new Error("Timed out waiting for recovered Codex turn completion.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to recover active operation for ${redactLogId(operation.chatId)}: ${detail}`);
    await sendInterruptedOperationFallback(operation, detail);
  }
}

async function replayRecoveredItems(
  operation: ActiveOperationRecord,
  items: CodexTurnRecoveryItem[],
  deliveredItemIds: Set<string>,
): Promise<void> {
  if (!bot || !config || !registry) {
    return;
  }

  for (const item of items) {
    if (deliveredItemIds.has(item.id)) {
      continue;
    }
    const deliveryKey = `operation:${operation.id}:item:${item.id}`;
    const claim = claimTelegramDelivery(config, {
      deliveryKey,
      contextKey: operation.contextKey,
      chatId: operation.chatId,
      messageThreadId: operation.messageThreadId,
      operationId: operation.id,
      itemId: item.id,
      kind: "recovered-item",
      payload: item.kind === "response" ? item.text : `${item.toolName}\n${item.detail}\n${item.isError ? "error" : "ok"}`,
    });
    if (claim !== "send") {
      deliveredItemIds.add(item.id);
      acknowledgeActiveOperationItem(config, operation.id, item.id);
      continue;
    }
    try {
      const messageId = await retryRecoveryTelegramCall(() => sendRecoveredTurnItem(bot!, registry!, operation, item));
      completeTelegramDelivery(config, deliveryKey, messageId);
    } catch (error) {
      failTelegramDelivery(config, deliveryKey, error);
      throw error;
    }
    deliveredItemIds.add(item.id);
    acknowledgeActiveOperationItem(config, operation.id, item.id);
  }
}

async function deliverRecoveredResponseWithRetry(
  operation: ActiveOperationRecord,
  agentText: string,
): Promise<boolean> {
  if (!config) {
    return false;
  }

  const previousAttempts = operation.deliveryAttempts ?? 0;
  const deliveryKey = `operation:${operation.id}:final`;
  for (let attempt = previousAttempts; attempt < RECOVERY_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
    setActiveOperationDeliveryState(config, operation.id, "delivery-in-progress");
    const claim = claimTelegramDelivery(config, {
      deliveryKey,
      contextKey: operation.contextKey,
      chatId: operation.chatId,
      messageThreadId: operation.messageThreadId,
      operationId: operation.id,
      kind: "recovered-final",
      payload: agentText,
    });
    if (claim !== "send") {
      return true;
    }
    try {
      const messageId = await deliverRecoveredResponse(operation, agentText);
      completeTelegramDelivery(config, deliveryKey, messageId);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failTelegramDelivery(config, deliveryKey, error);
      setActiveOperationDeliveryState(config, operation.id, "delivery-failed", detail);
      if (isPermanentTelegramDeliveryError(error) || attempt + 1 >= RECOVERY_DELIVERY_MAX_ATTEMPTS) {
        return false;
      }
      await delay(1000 * 2 ** attempt);
    }
  }
  return false;
}

async function retryRecoveryTelegramCall<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < RECOVERY_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (isPermanentTelegramDeliveryError(error) || attempt + 1 >= RECOVERY_DELIVERY_MAX_ATTEMPTS) {
        throw error;
      }
      await delay(1000 * 2 ** attempt);
    }
  }
  throw new Error("Telegram recovery delivery exhausted without a result.");
}

function isPermanentTelegramDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:400|401|403)\b|bot was blocked|chat not found|topic.*(?:closed|deleted)|message thread not found/i.test(message);
}

async function deliverRecoveredResponse(operation: ActiveOperationRecord, agentText: string): Promise<number | undefined> {
  if (!bot || !config) {
    return undefined;
  }

  const chunks = splitRecoveryText(agentText || "Codex completed the turn, but no final agent message was stored.");
  const first = `<b>Recovered response after service restart</b>\n\n${escapeHTML(chunks[0] ?? "")}`;
  let responseMessageId = operation.responseMessageId;
  if (responseMessageId) {
    try {
      await bot.api.editMessageText(operation.chatId, responseMessageId, first, { parse_mode: "HTML" });
    } catch {
      responseMessageId = undefined;
    }
  }
  if (!responseMessageId) {
    const sent = await bot.api.sendMessage(operation.chatId, first, {
      parse_mode: "HTML",
      ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
    });
    responseMessageId = sent.message_id;
    updateActiveOperation(config, operation.id, { responseMessageId });
  }

  for (const chunk of chunks.slice(1)) {
    const sent = await bot.api.sendMessage(operation.chatId, escapeHTML(chunk), {
      parse_mode: "HTML",
      ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
    });
    responseMessageId = sent.message_id;
  }
  return responseMessageId;
}

async function sendInterruptedOperationFallback(operation: ActiveOperationRecord, detail?: string): Promise<void> {
  if (!bot) {
    return;
  }
  const message = [renderInterruptedOperationMessage(operation), detail ? `\n<b>Recovery detail:</b> <code>${escapeHTML(detail)}</code>` : undefined]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  try {
    await bot.api.sendMessage(operation.chatId, message, {
      parse_mode: "HTML",
      ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
    });
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to send interrupted operation notification to ${redactLogId(operation.chatId)}: ${errorDetail}`);
  }
}

function splitRecoveryText(value: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 3200) {
    chunks.push(value.slice(offset, offset + 3200));
  }
  return chunks.length > 0 ? chunks : [""];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyServiceOperationRecovery(): Promise<void> {
  if (!bot || !config) {
    return;
  }

  const markers = consumeServiceOperationMarkers(config);
  for (const marker of markers) {
    const message = renderServiceOperationRecoveryMessage(marker);
    try {
      await withTimeout(
        bot.api.sendMessage(marker.chatId, message, {
          parse_mode: "HTML",
          ...(marker.messageThreadId ? { message_thread_id: marker.messageThreadId } : {}),
        }),
        1500,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to send service operation recovery notification to ${redactLogId(marker.chatId)}: ${detail}`);
    }
  }
}

function renderServiceOperationRecoveryMessage(marker: ServiceOperationMarker): string {
  const title = marker.type === "update" ? "update" : "restart";
  return [
    `<b>TeleCodex is back after service ${escapeHTML(title)}.</b>`,
    "",
    `<b>Instance:</b> <code>${escapeHTML(marker.instance)}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(marker.workspace)}</code>`,
    marker.pid ? `<b>Launcher PID:</b> <code>${marker.pid}</code>` : undefined,
    `<b>Started:</b> <code>${escapeHTML(new Date(marker.startedAt).toISOString())}</code>`,
    `<b>Elapsed:</b> <code>${escapeHTML(formatElapsedSince(marker.startedAt))}</code>`,
    "",
    "Use <code>/status</code> or <code>/doctor</code> to verify the current runtime.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function redactLogId(value: string | number): string {
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
  return `id:${digest}`;
}

function renderInterruptedOperationMessage(operation: ActiveOperationRecord): string {
  const title = operation.operation === "compact" ? "compact" : "Codex turn";
  return [
    "<b>TeleCodex restarted during active work.</b>",
    `Previous <code>${escapeHTML(title)}</code> may have been interrupted.`,
    "",
    `<b>Thread:</b> <code>${escapeHTML(operation.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(operation.workspace)}</code>`,
    operation.promptSummary ? `<b>Last user:</b> <code>${escapeHTML(operation.promptSummary)}</code>` : undefined,
    "",
    "The thread metadata is preserved. Use <code>/status</code>, <code>/reconnect</code>, <code>/retry</code>, or send a new prompt to continue.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatElapsedSince(startedAt: number): string {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
