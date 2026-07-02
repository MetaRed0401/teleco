import { escapeHTML } from "./format.js";

export type TelegramResponseFormat = "rich-message" | "markdown" | "html" | "plain";
export type TelegramRichParseMode = "HTML" | "MarkdownV2";
export type TelegramPrettyMode = "off" | "on" | "once";

export interface RichMessageCandidate {
  text: string;
  parseMode?: TelegramRichParseMode;
  label: TelegramResponseFormat | "plain-fallback";
}

export const DEFAULT_TELEGRAM_RESPONSE_FORMAT: TelegramResponseFormat = "rich-message";
export const DEFAULT_TELEGRAM_PRETTY_MODE: TelegramPrettyMode = "off";

export const TELEGRAM_RESPONSE_FORMAT_OPTIONS: Array<{
  value: TelegramResponseFormat;
  label: string;
  description: string;
}> = [
  {
    value: "rich-message",
    label: "RichMessage",
    description: "Auto route for rich Telegram output: HTML first, MarkdownV2 backup, plain fallback.",
  },
  {
    value: "markdown",
    label: "Markdown",
    description: "Normalize Codex Markdown-ish output into Telegram MarkdownV2 syntax.",
  },
  {
    value: "html",
    label: "HTML",
    description: "Normalize Codex Markdown-ish output into Telegram HTML syntax.",
  },
  {
    value: "plain",
    label: "Plain",
    description: "Normalize Codex output into readable plain text.",
  },
];

export const TELEGRAM_PRETTY_MODE_OPTIONS: Array<{
  value: TelegramPrettyMode | "status";
  label: string;
  description: string;
}> = [
  {
    value: "on",
    label: "Pretty on",
    description: "Compatibility shell only; response normalization is controlled by /formatting.",
  },
  {
    value: "off",
    label: "Pretty off",
    description: "Compatibility shell only; response normalization is controlled by /formatting.",
  },
  {
    value: "once",
    label: "Pretty once",
    description: "Compatibility shell only; response normalization is controlled by /formatting.",
  },
  {
    value: "status",
    label: "Status",
    description: "Show the current compatibility-shell pretty mode.",
  },
];

const CODE_BLOCK_PREFIX = "\uE010CODE";
const CODE_BLOCK_SUFFIX = "\uE010";
const INLINE_CODE_PREFIX = "\uE011INLINE";
const INLINE_CODE_SUFFIX = "\uE011";
const LINK_PREFIX = "\uE012LINK";
const LINK_SUFFIX = "\uE012";
const BOLD_PREFIX = "\uE013BOLD";
const BOLD_SUFFIX = "\uE013";
const ITALIC_PREFIX = "\uE014ITALIC";
const ITALIC_SUFFIX = "\uE014";
const SPOILER_PREFIX = "\uE015SPOILER";
const SPOILER_SUFFIX = "\uE015";

export function normalizeTelegramResponseFormat(value: unknown): TelegramResponseFormat {
  if (isTelegramResponseFormat(value)) {
    return value;
  }
  if (value === "auto" || value === "markdown-v2") {
    return value === "markdown-v2" ? "markdown" : DEFAULT_TELEGRAM_RESPONSE_FORMAT;
  }
  return DEFAULT_TELEGRAM_RESPONSE_FORMAT;
}

export function isTelegramResponseFormat(value: unknown): value is TelegramResponseFormat {
  return value === "rich-message" || value === "markdown" || value === "html" || value === "plain";
}

export function normalizeTelegramPrettyMode(value: unknown): TelegramPrettyMode {
  return isTelegramPrettyMode(value) ? value : DEFAULT_TELEGRAM_PRETTY_MODE;
}

export function isTelegramPrettyMode(value: unknown): value is TelegramPrettyMode {
  return value === "off" || value === "on" || value === "once";
}

export function formatTelegramResponseFormatLabel(format: TelegramResponseFormat): string {
  return TELEGRAM_RESPONSE_FORMAT_OPTIONS.find((option) => option.value === format)?.label ?? format;
}

export function formatTelegramPrettyModeLabel(mode: TelegramPrettyMode): string {
  if (mode === "on") {
    return "Pretty on";
  }
  if (mode === "once") {
    return "Pretty once";
  }
  return "Pretty off";
}

export function normalizeTelegramFriendlyMarkdown(markdown: string): string {
  return normalizeCodexMarkdownToTelegramPlain(markdown);
}

export function normalizeTelegramHTMLMarkdown(markdown: string): string {
  return normalizeCodexMarkdownToTelegramHTML(markdown);
}

export function normalizeTelegramPlainMarkdown(markdown: string): string {
  return normalizeCodexMarkdownToTelegramPlain(markdown);
}

export function renderRichMessageCandidates(
  markdown: string,
  format: TelegramResponseFormat,
  _options: { pretty?: boolean } = {},
): RichMessageCandidate[] {
  const normalized = normalizeTelegramResponseFormat(format);
  const html = renderHTMLCandidate(markdown);
  const telegramMarkdown = renderMarkdownCandidate(markdown);
  const plain = renderPlainCandidate(markdown);

  if (normalized === "plain") {
    return [plain];
  }

  if (normalized === "rich-message") {
    return dedupeRichMessageCandidates([html, telegramMarkdown, plain]);
  }

  if (normalized === "html") {
    return dedupeRichMessageCandidates([html, plain]);
  }

  return dedupeRichMessageCandidates([telegramMarkdown, html, plain]);
}

export function normalizeCodexMarkdownToTelegramHTML(markdown: string): string {
  if (!markdown) {
    return "";
  }

  const placeholders: string[] = [];
  let text = normalizeCodexInput(markdown);
  text = protectCodeBlocksForHTML(text, placeholders);
  text = protectInlineCodeForHTML(text, placeholders);
  text = escapeHTML(text);
  text = renderHTMLHeadings(text);
  text = renderHTMLLinks(text, placeholders);
  text = renderHTMLSpoilers(text, placeholders);
  text = renderHTMLBold(text, placeholders);
  text = renderHTMLItalic(text, placeholders);
  text = renderHTMLBlockquotes(text, placeholders);
  text = renderTaskListsForTelegram(text);
  text = restorePlaceholders(text, placeholders);
  return normalizeMobileSpacing(text).trim();
}

export function normalizeCodexMarkdownToTelegramMarkdown(markdown: string): string {
  if (!markdown) {
    return "";
  }

  const placeholders: string[] = [];
  let text = normalizeCodexInput(markdown);
  text = protectCodeBlocksForPlain(text, placeholders);
  text = protectInlineCodeForPlain(text, placeholders);
  text = renderMarkdownHeadingsAsBold(text);
  text = restorePlaceholders(text, placeholders);
  return formatTelegramMarkdownV2(text);
}

export function normalizeCodexMarkdownToTelegramPlain(markdown: string): string {
  if (!markdown) {
    return "";
  }

  const placeholders: string[] = [];
  let text = normalizeCodexInput(markdown);
  text = protectCodeBlocksForPlain(text, placeholders);
  text = protectInlineCodeForPlain(text, placeholders);
  text = renderPlainLinks(text);
  text = renderPlainHeadings(text);
  text = renderPlainEmphasis(text);
  text = renderTaskListsForTelegram(text);
  text = stripInlineHTML(text);
  text = restorePlaceholders(text, placeholders);
  return normalizeMobileSpacing(text).trim();
}

export function formatTelegramMarkdownV2(markdown: string): string {
  if (!markdown) {
    return "";
  }

  const placeholders: string[] = [];
  let text = markdown.replace(/\r\n?/g, "\n");
  text = protectCodeBlocksForMarkdownV2(text, placeholders);
  text = protectInlineCodeForMarkdownV2(text, placeholders);
  text = protectLinksForMarkdownV2(text, placeholders);
  text = protectSpoilersForMarkdownV2(text, placeholders);
  text = protectBoldForMarkdownV2(text, placeholders);
  text = protectItalicForMarkdownV2(text, placeholders);
  text = protectBlockquotesForMarkdownV2(text, placeholders);
  text = escapeMarkdownV2(text);
  return restorePlaceholders(text, placeholders);
}

function renderMarkdownCandidate(markdown: string): RichMessageCandidate {
  return {
    text: normalizeCodexMarkdownToTelegramMarkdown(markdown),
    parseMode: "MarkdownV2",
    label: "markdown",
  };
}

function renderHTMLCandidate(markdown: string): RichMessageCandidate {
  return {
    text: normalizeCodexMarkdownToTelegramHTML(markdown),
    parseMode: "HTML",
    label: "html",
  };
}

function renderPlainCandidate(markdown: string): RichMessageCandidate {
  return {
    text: normalizeCodexMarkdownToTelegramPlain(markdown),
    label: "plain-fallback",
  };
}

function dedupeRichMessageCandidates(candidates: RichMessageCandidate[]): RichMessageCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.parseMode ?? "plain"}:${candidate.text}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeCodexInput(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  text = normalizeDetailsBlocks(text);
  text = normalizeMarkdownTables(text);
  text = normalizeNestedListIndent(text);
  return text;
}

function normalizeDetailsBlocks(markdown: string): string {
  return markdown.replace(
    /<details>\s*(?:<summary>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>/gi,
    (_match, rawSummary: string | undefined, rawBody: string) => {
      const summary = stripInlineHTML(rawSummary ?? "Details").trim();
      const body = stripInlineHTML(rawBody).trim();
      return [summary, body].filter(Boolean).join("\n\n");
    },
  );
}

function normalizeMarkdownTables(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(next)) {
      const tableLines: string[] = [line];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      output.push(formatMarkdownTableForTelegram(tableLines));
      continue;
    }

    output.push(line);
    index += 1;
  }

  return output.join("\n");
}

function renderMarkdownHeadingsAsBold(markdown: string): string {
  return markdown.replace(/^(#{1,6})\s+(.+?)\s*#*$/gm, (_match, _marker: string, title: string) => {
    return `**${title.trim()}**`;
  });
}

function renderHTMLHeadings(text: string): string {
  return text.replace(/^(#{1,6})\s+(.+?)\s*#*$/gm, (_match, _marker: string, title: string) => {
    return `<b>${title.trim()}</b>`;
  });
}

function renderPlainHeadings(text: string): string {
  return text.replace(/^(#{1,6})\s+(.+?)\s*#*$/gm, (_match, _marker: string, title: string) => title.trim());
}

function renderHTMLLinks(text: string, placeholders: string[]): string {
  return text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = safeTelegramUrl(unescapeBasicHTML(url));
    if (!safeUrl) {
      return addPlaceholder(placeholders, LINK_PREFIX, LINK_SUFFIX, `<code>${label.trim()}</code>`);
    }
    return addPlaceholder(placeholders, LINK_PREFIX, LINK_SUFFIX, `<a href="${escapeHTMLAttribute(safeUrl)}">${label.trim()}</a>`);
  });
}

function renderPlainLinks(text: string): string {
  return text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = safeTelegramUrl(url);
    return safeUrl ? `${label.trim()} (${safeUrl})` : label.trim();
  });
}

function renderHTMLBold(text: string, placeholders: string[]): string {
  let result = text.replace(/(?<!\*)\*\*(?!\s)([^\n]*?\S)\*\*(?!\*)/g, (_match, content: string) => {
    return addPlaceholder(placeholders, BOLD_PREFIX, BOLD_SUFFIX, `<b>${content}</b>`);
  });
  result = result.replace(/__(?!\s)([^_\n]*?\S)__/g, (_match, content: string) => {
    return addPlaceholder(placeholders, BOLD_PREFIX, BOLD_SUFFIX, `<b>${content}</b>`);
  });
  return result;
}

function renderHTMLItalic(text: string, placeholders: string[]): string {
  let result = text.replace(/(?<![\w_])_(?!\s)([^_\n]*?\S)_(?![\w_])/g, (_match, content: string) => {
    return addPlaceholder(placeholders, ITALIC_PREFIX, ITALIC_SUFFIX, `<i>${content}</i>`);
  });
  result = result.replace(/(?<![\w*])\*(?!\s)([^*\n]*?\S)\*(?![\w*])/g, (_match, content: string) => {
    return addPlaceholder(placeholders, ITALIC_PREFIX, ITALIC_SUFFIX, `<i>${content}</i>`);
  });
  return result;
}

function renderHTMLSpoilers(text: string, placeholders: string[]): string {
  return text.replace(/\|\|([^|\n]+)\|\|/g, (_match, content: string) => {
    return addPlaceholder(placeholders, SPOILER_PREFIX, SPOILER_SUFFIX, `<tg-spoiler>${content}</tg-spoiler>`);
  });
}

function renderHTMLBlockquotes(text: string, placeholders: string[]): string {
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(/^&gt;\s?(.*)$/);
      if (!match) {
        return line;
      }
      return addPlaceholder(placeholders, LINK_PREFIX, LINK_SUFFIX, `<blockquote>${match[1] ?? ""}</blockquote>`);
    })
    .join("\n");
}

function renderPlainEmphasis(text: string): string {
  return text
    .replace(/\*\*(?!\s)([^\n]*?\S)\*\*/g, "$1")
    .replace(/__(?!\s)([^_\n]*?\S)__/g, "$1")
    .replace(/(?<![\w_])_(?!\s)([^_\n]*?\S)_(?![\w_])/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)([^*\n]*?\S)\*(?![\w*])/g, "$1")
    .replace(/\|\|([^|\n]+)\|\|/g, "$1");
}

function renderTaskListsForTelegram(text: string): string {
  return text.replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/gm, (_match, indent: string, checked: string) => {
    return `${indent}- ${checked.trim() ? "✓ " : "☐ "}`;
  });
}

function protectCodeBlocksForHTML(text: string, placeholders: string[]): string {
  return text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, rawLanguage: string, rawCode: string) => {
    const language = rawLanguage.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
    const className = language ? ` class="language-${escapeHTMLAttribute(language)}"` : "";
    return addPlaceholder(placeholders, CODE_BLOCK_PREFIX, CODE_BLOCK_SUFFIX, `<pre><code${className}>${escapeHTML(rawCode.trimEnd())}</code></pre>`);
  });
}

function protectInlineCodeForHTML(text: string, placeholders: string[]): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return addPlaceholder(placeholders, INLINE_CODE_PREFIX, INLINE_CODE_SUFFIX, `<code>${escapeHTML(code)}</code>`);
  });
}

function protectCodeBlocksForPlain(text: string, placeholders: string[]): string {
  return text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, rawLanguage: string, rawCode: string) => {
    const language = rawLanguage.trim();
    const header = language ? `\`\`\`${language}` : "```";
    return addPlaceholder(placeholders, CODE_BLOCK_PREFIX, CODE_BLOCK_SUFFIX, `${header}\n${rawCode.trimEnd()}\n\`\`\``);
  });
}

function protectInlineCodeForPlain(text: string, placeholders: string[]): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return addPlaceholder(placeholders, INLINE_CODE_PREFIX, INLINE_CODE_SUFFIX, `\`${code}\``);
  });
}

function protectCodeBlocksForMarkdownV2(text: string, placeholders: string[]): string {
  return text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, rawLanguage: string, rawCode: string) => {
    const language = rawLanguage.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
    const code = escapeMarkdownV2Code(rawCode.trimEnd());
    const rendered = language ? `\`\`\`${language}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``;
    return addPlaceholder(placeholders, CODE_BLOCK_PREFIX, CODE_BLOCK_SUFFIX, rendered);
  });
}

function protectInlineCodeForMarkdownV2(text: string, placeholders: string[]): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return addPlaceholder(placeholders, INLINE_CODE_PREFIX, INLINE_CODE_SUFFIX, `\`${escapeMarkdownV2Code(code)}\``);
  });
}

function protectLinksForMarkdownV2(text: string, placeholders: string[]): string {
  return text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = safeTelegramUrl(url);
    if (!safeUrl) {
      return addPlaceholder(placeholders, LINK_PREFIX, LINK_SUFFIX, escapeMarkdownV2(label.trim()));
    }
    const rendered = `[${escapeMarkdownV2(label.trim())}](${escapeMarkdownV2Url(safeUrl)})`;
    return addPlaceholder(placeholders, LINK_PREFIX, LINK_SUFFIX, rendered);
  });
}

function protectBoldForMarkdownV2(text: string, placeholders: string[]): string {
  let result = text.replace(/(?<!\*)\*\*(?!\s)([^\n]*?\S)\*\*(?!\*)/g, (_match, content: string) => {
    return addPlaceholder(placeholders, BOLD_PREFIX, BOLD_SUFFIX, `*${escapeMarkdownV2(content)}*`);
  });
  result = result.replace(/__(?!\s)([^_\n]*?\S)__/g, (_match, content: string) => {
    return addPlaceholder(placeholders, BOLD_PREFIX, BOLD_SUFFIX, `*${escapeMarkdownV2(content)}*`);
  });
  return result;
}

function protectItalicForMarkdownV2(text: string, placeholders: string[]): string {
  let result = text.replace(/(?<![\w_])_(?!\s)([^_\n]*?\S)_(?![\w_])/g, (_match, content: string) => {
    return addPlaceholder(placeholders, ITALIC_PREFIX, ITALIC_SUFFIX, `_${escapeMarkdownV2(content)}_`);
  });
  result = result.replace(/(?<![\w*])\*(?!\s)([^*\n]*?\S)\*(?![\w*])/g, (_match, content: string) => {
    return addPlaceholder(placeholders, ITALIC_PREFIX, ITALIC_SUFFIX, `_${escapeMarkdownV2(content)}_`);
  });
  return result;
}

function protectSpoilersForMarkdownV2(text: string, placeholders: string[]): string {
  return text.replace(/\|\|([^|\n]+)\|\|/g, (_match, content: string) => {
    return addPlaceholder(placeholders, SPOILER_PREFIX, SPOILER_SUFFIX, `||${escapeMarkdownV2(content)}||`);
  });
}

function protectBlockquotesForMarkdownV2(text: string, placeholders: string[]): string {
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(/^>\s?(.*)$/);
      if (!match) {
        return line;
      }
      return addPlaceholder(placeholders, LINK_PREFIX, LINK_SUFFIX, `>${escapeMarkdownV2(match[1] ?? "")}`);
    })
    .join("\n");
}

function addPlaceholder(placeholders: string[], prefix: string, suffix: string, value: string): string {
  const index = placeholders.push(value) - 1;
  return `${prefix}${index}${suffix}`;
}

function restorePlaceholders(text: string, placeholders: string[]): string {
  return text.replace(/[\uE010-\uE015][A-Z]+(\d+)[\uE010-\uE015]/g, (_match, rawIndex: string) => {
    return placeholders[Number.parseInt(rawIndex, 10)] ?? "";
  });
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeMarkdownV2Code(text: string): string {
  return text.replace(/([`\\])/g, "\\$1");
}

function escapeMarkdownV2Url(text: string): string {
  return text.trim().replace(/([)\\])/g, "\\$1");
}

function escapeHTMLAttribute(text: string): string {
  return escapeHTML(text).replace(/"/g, "&quot;");
}

function unescapeBasicHTML(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"");
}

function safeTelegramUrl(rawUrl: string): string | undefined {
  const url = rawUrl.trim();
  if (!url) {
    return undefined;
  }
  if (/^(https?|tg|mailto|tel):/i.test(url)) {
    return url;
  }
  return undefined;
}

function normalizeNestedListIndent(markdown: string): string {
  return markdown.replace(/^(\s{2,})([-*+]|\d+\.)\s+/gm, (_match, indent: string, marker: string) => {
    const depth = Math.min(3, Math.max(1, Math.floor(indent.length / 2)));
    return `${"  ".repeat(depth)}${marker} `;
  });
}

function normalizeMobileSpacing(markdown: string): string {
  return markdown
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+\n/gm, "\n");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^\|?.+\|.+\|?$/.test(trimmed);
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
}

function formatMarkdownTableForTelegram(lines: string[]): string {
  return lines
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" | "),
    )
    .filter(Boolean)
    .join("\n");
}

function stripInlineHTML(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}
