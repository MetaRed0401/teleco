import { createBot, registerCommands } from "./bot.js";
import { markInterruptedOperations, type ActiveOperationRecord } from "./active-operations.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig, type TeleCodexConfig } from "./config.js";
import { escapeHTML } from "./format.js";
import { consumeServiceOperationMarkers, type ServiceOperationMarker } from "./service-operation-marker.js";
import { SessionRegistry } from "./session-registry.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let config: TeleCodexConfig | undefined;

try {
  config = loadConfig();
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  await registerCommands(bot);

  console.log("TeleCodex running");
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

let shuttingDown = false;
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

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: true,
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
      console.warn(`Failed to send lifecycle notification to ${chatId}: ${detail}`);
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

    const message = renderInterruptedOperationMessage(operation);
    try {
      await withTimeout(
        bot.api.sendMessage(operation.chatId, message, {
          parse_mode: "HTML",
          ...(operation.messageThreadId ? { message_thread_id: operation.messageThreadId } : {}),
        }),
        1500,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to send interrupted operation notification to ${operation.chatId}: ${detail}`);
    }
  }
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
      console.warn(`Failed to send service operation recovery notification to ${marker.chatId}: ${detail}`);
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
