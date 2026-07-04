import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";

export type ToolVerbosity = "all" | "new" | "summary" | "errors-only" | "none";
export type ResponsePreviewMode = "off" | "edit" | "draft";
export type ToolActivityMode = "off" | "compact" | "verbose" | "errors-only";
export type FinalResponseMode = "send" | "edit";

export interface TeleCodexConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  telegramChannelId?: number;
  workspace: string;
  maxFileSize: number;
  codexApiKey?: string;
  codexModel?: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  toolVerbosity: ToolVerbosity;
  responsePreviewMode: ResponsePreviewMode;
  toolActivityMode: ToolActivityMode;
  finalResponseMode: FinalResponseMode;
  showTurnTokenUsage: boolean;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  enableTelegramDraftStreaming: boolean;
  telegramReactionProcessingEmoji?: string;
  telegramReactionSuccessEmoji?: string;
  telegramReactionFailureEmoji?: string;
  enableLifecycleNotifications: boolean;
  enableCodexAppServerRuntime: boolean;
  autoCompactEnabled: boolean;
  autoCompactContextThreshold: number;
  autoCompactAfterCodexAutoCompact: boolean;
  autoCompactAfterEveryTurn: boolean;
  autoCompactCooldownTurns: number;
  autoCompactCooldownMinutes: number;
  toolDiffPreviewTtlMinutes: number;
}

export function loadConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const telegramChannelId = parseOptionalTelegramChatId(optionalString(process.env.TELEGRAM_CHANNEL_ID));
  const workspace = resolveWorkspace();
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const responsePreviewMode = parseResponsePreviewMode(optionalString(process.env.RESPONSE_PREVIEW_MODE));
  const toolActivityMode = parseToolActivityMode(
    optionalString(process.env.TOOL_ACTIVITY_MODE),
    optionalString(process.env.TOOL_VERBOSITY),
  );
  const finalResponseMode = parseFinalResponseMode(optionalString(process.env.FINAL_RESPONSE_MODE));
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const enableTelegramLogin = parseBooleanEnv(optionalString(process.env.ENABLE_TELEGRAM_LOGIN), true);
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const enableTelegramDraftStreaming = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_DRAFT_STREAMING),
    true,
  );
  const telegramReactionProcessingEmoji = parseOptionalEmojiEnv(
    optionalString(process.env.TELEGRAM_REACTION_PROCESSING_EMOJI),
    "👀",
  );
  const telegramReactionSuccessEmoji = parseOptionalEmojiEnv(
    optionalString(process.env.TELEGRAM_REACTION_SUCCESS_EMOJI),
    "👍",
  );
  const telegramReactionFailureEmoji = parseOptionalEmojiEnv(
    optionalString(process.env.TELEGRAM_REACTION_FAILURE_EMOJI),
    undefined,
  );
  const enableLifecycleNotifications = parseBooleanEnv(
    optionalString(process.env.ENABLE_LIFECYCLE_NOTIFICATIONS),
    false,
  );
  const enableCodexAppServerRuntime = parseBooleanEnv(
    optionalString(process.env.ENABLE_CODEX_APP_SERVER_RUNTIME),
    true,
  );
  const autoCompactEnabled = parseBooleanEnv(optionalString(process.env.AUTO_COMPACT_ENABLED), true);
  const autoCompactContextThreshold = parseRatioEnv(
    optionalString(process.env.AUTO_COMPACT_CONTEXT_THRESHOLD),
    0.8,
    "AUTO_COMPACT_CONTEXT_THRESHOLD",
  );
  const autoCompactAfterCodexAutoCompact = parseBooleanEnv(
    optionalString(process.env.AUTO_COMPACT_AFTER_CODEX_AUTO_COMPACT),
    false,
  );
  const autoCompactAfterEveryTurn = parseBooleanEnv(
    optionalString(process.env.AUTO_COMPACT_AFTER_EVERY_TURN),
    false,
  );
  const autoCompactCooldownTurns = parseIntegerEnv(
    optionalString(process.env.AUTO_COMPACT_COOLDOWN_TURNS),
    3,
    "AUTO_COMPACT_COOLDOWN_TURNS",
  );
  const autoCompactCooldownMinutes = parseIntegerEnv(
    optionalString(process.env.AUTO_COMPACT_COOLDOWN_MINUTES),
    10,
    "AUTO_COMPACT_COOLDOWN_MINUTES",
  );
  const toolDiffPreviewTtlMinutes = parseIntegerEnv(
    optionalString(process.env.TOOL_DIFF_PREVIEW_TTL_MINUTES),
    4320,
    "TOOL_DIFF_PREVIEW_TTL_MINUTES",
  );

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    telegramChannelId,
    workspace,
    maxFileSize,
    codexApiKey,
    codexModel,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    toolVerbosity,
    responsePreviewMode,
    toolActivityMode,
    finalResponseMode,
    showTurnTokenUsage,
    enableTelegramLogin,
    enableTelegramReactions,
    enableTelegramDraftStreaming,
    telegramReactionProcessingEmoji,
    telegramReactionSuccessEmoji,
    telegramReactionFailureEmoji,
    enableLifecycleNotifications,
    enableCodexAppServerRuntime,
    autoCompactEnabled,
    autoCompactContextThreshold,
    autoCompactAfterCodexAutoCompact,
    autoCompactAfterEveryTurn,
    autoCompactCooldownTurns,
    autoCompactCooldownMinutes,
    toolDiffPreviewTtlMinutes,
  };
}

/**
 * Workspace is derived automatically:
 * - TELECODEX_WORKSPACE: explicit override
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveWorkspace(): string {
  const explicitWorkspace = optionalString(process.env.TELECODEX_WORKSPACE);
  if (explicitWorkspace) {
    return path.resolve(explicitWorkspace);
  }

  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseOptionalTelegramChatId(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed === 0) {
    throw new Error(`Invalid Telegram chat id in TELEGRAM_CHANNEL_ID: ${raw}`);
  }

  return parsed;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseOptionalEmojiEnv(raw: string | undefined, defaultValue: string | undefined): string | undefined {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "none" || lower === "off" || lower === "false" || lower === "disabled") {
    return undefined;
  }

  return raw;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parseIntegerEnv(raw: string | undefined, defaultValue: number, name: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`Invalid ${name} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

function parseRatioEnv(raw: string | undefined, defaultValue: number, name: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio > 1) {
    console.warn(`Invalid ${name} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return ratio;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "new":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, new, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parseResponsePreviewMode(raw: string | undefined): ResponsePreviewMode {
  if (!raw) {
    return "off";
  }

  switch (raw) {
    case "off":
    case "edit":
    case "draft":
      return raw;
    default:
      console.warn(
        `Invalid RESPONSE_PREVIEW_MODE value: "${raw}". Expected one of: off, edit, draft. Falling back to "off".`,
      );
      return "off";
  }
}

function parseToolActivityMode(raw: string | undefined, legacyVerbosityRaw?: string): ToolActivityMode {
  if (!raw) {
    if (legacyVerbosityRaw) {
      return toolVerbosityToActivityMode(parseToolVerbosity(legacyVerbosityRaw));
    }
    return "compact";
  }

  switch (raw) {
    case "off":
    case "compact":
    case "verbose":
    case "errors-only":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_ACTIVITY_MODE value: "${raw}". Expected one of: off, compact, verbose, errors-only. Falling back to "compact".`,
      );
      return "compact";
  }
}

function parseFinalResponseMode(raw: string | undefined): FinalResponseMode {
  if (!raw) {
    return "send";
  }

  switch (raw) {
    case "send":
    case "edit":
      return raw;
    default:
      console.warn(
        `Invalid FINAL_RESPONSE_MODE value: "${raw}". Expected one of: send, edit. Falling back to "send".`,
      );
      return "send";
  }
}

function toolVerbosityToActivityMode(verbosity: ToolVerbosity): ToolActivityMode {
  switch (verbosity) {
    case "all":
      return "verbose";
    case "errors-only":
      return "errors-only";
    case "none":
      return "off";
    case "new":
    case "summary":
      return "compact";
  }
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}
