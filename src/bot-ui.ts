import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Session",
      commands: [
        ["/new", "Start a new thread"],
        ["/status", "Codex auth & session status"],
        ["/doctor", "Check runtime environment"],
        ["/locks", "Show runtime lock files"],
        ["/reconnect", "Reconnect Codex app-server"],
        ["/compact", "Compact current Codex context"],
        ["/session", "Current thread details"],
        ["/sessions", "Browse & switch threads"],
        ["/switch <id>", "Switch to a thread by ID"],
        ["/attach", "Bind a Codex thread to this topic"],
        ["/handback", "Hand thread back to Codex CLI"],
        ["/abort", "Cancel current operation"],
        ["/stop", "Cancel current operation"],
        ["/approvals", "List pending approvals"],
        ["/retry", "Resend the last prompt"],
        ["/queue", "View or add queued prompts"],
        ["/steer", "Steer the active Codex turn"],
        ["/ask <prompt>", "Send command-looking text as prompt"],
        ["/prompt <prompt>", "Alias for /ask"],
      ],
    },
    {
      title: "🤖 Model",
      commands: [
        ["/permission", "Select runtime permission profile"],
        ["/profile", "Alias for /permission"],
        ["/launch_profiles", "Alias for /permission"],
        ["/model", "Select model"],
        ["/think", "Select thinking effort"],
        ["/fast", "Toggle Codex fast mode"],
        ["/formatting", "Select Telegram output format"],
        ["/pretty", "Compatibility shell for old pretty mode"],
        ["/streaming", "Configure Telegram streaming UX"],
      ],
    },
    {
      title: "🧭 Workspace",
      commands: [
        ["/files [path]", "List files"],
        ["/tree [path] [depth]", "Show directory tree"],
        ["/find <query> [path]", "Find files by name"],
        ["/search <query> [path]", "Search files quickly"],
        ["/view <path> [start:end]", "View file contents"],
        ["/sendfile <path>", "Send file as attachment"],
        ["/grep <text> [path]", "Search text"],
      ],
    },
    {
      title: "🔐 Auth",
      commands: [
        ["/auth", "Check auth status"],
        ["/login", "Start authentication"],
        ["/logout", "Sign out"],
      ],
    },
    {
      title: "ℹ️ Utility",
      commands: [
        ["/start", "Welcome & status"],
        ["/help", "This reference"],
        ["/voice", "Voice transcription status"],
        ["/update", "Update current service instance"],
        ["/service_update", "Alias for update"],
        ["/restart", "Restart current service"],
        ["/force_restart", "Alias for /restart"],
        ["/service_restart", "Alias for /restart"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  htmlLines.push(
    "",
    "<b>⚠️ Slash/path note</b>",
    "Text starting with <code>/</code> is treated as a Telegram command. For paths, use <code>/view &lt;path&gt;</code>, <code>/sendfile &lt;path&gt;</code>, or send a sentence such as <code>Use this path: /home/me/project</code>. Use <code>/ask &lt;prompt&gt;</code> to send command-looking text to Codex.",
  );
  plainLines.push(
    "",
    "⚠️ Slash/path note",
    "Text starting with / is treated as a Telegram command. For paths, use /view <path>, /sendfile <path>, or send a sentence such as Use this path: /home/me/project. Use /ask <prompt> to send command-looking text to Codex.",
  );

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 Welcome to TeleCodex.</b>",
    "<i>Your Telegram bridge to Codex is connected and ready.</i>",
    "",
    "Send a message here and Codex will work in this project workspace.",
    "You can also send voice notes, screenshots, or documents.",
    "",
    "Good first commands:",
    "<code>/status</code> check connection",
    "<code>/new</code> start fresh",
    "<code>/help</code> show all commands",
  ];
  const plainLines = [
    "👋 Welcome to TeleCodex.",
    "Your Telegram bridge to Codex is connected and ready.",
    "",
    "Send a message here and Codex will work in this project workspace.",
    "You can also send voice notes, screenshots, or documents.",
    "",
    "Good first commands:",
    "/status check connection",
    "/new start fresh",
    "/help show all commands",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCodex (topic session)" : "TeleCodex";

  const htmlLines = [
    `<b>👋 Welcome back to ${escapeHTML(label)}.</b>`,
    "<i>Connected and ready for the next turn.</i>",
    "",
    sessionHtml,
    "",
    "Send a message, or use <code>/new</code> for a fresh thread.",
  ];
  const plainLines = [
    `👋 Welcome back to ${label}.`,
    "Connected and ready for the next turn.",
    "",
    sessionPlain,
    "",
    "Send a message, or use /new for a fresh thread.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "(unknown)";
  const title = trimLabel(options.title || "(untitled)", 20) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
