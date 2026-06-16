# Codex Terminal Persistence Analysis

## Summary

TeleCodex uses Codex app-server, not an interactive Codex terminal UI. Work started through Telegram can be persisted as a Codex thread, but it will not appear as live output inside an already-open `codex` terminal session.

## Why terminal output is missing

TeleCodex starts Codex app-server as a subprocess and consumes structured stream events such as agent messages, tool calls, file changes, approvals, token usage, and turn completion. TeleCodex renders those events into Telegram messages.

There is no attached interactive terminal UI in this flow, so the normal Codex terminal screen does not receive:

- assistant streaming text
- Telegram-formatted status messages
- tool progress messages
- service/channel mirrored responses

Those outputs exist in the TeleCodex process and Telegram, not in a separate Codex terminal process.

## What is still shared

The important shared object is the Codex thread id. TeleCodex stores and resumes Codex threads through app-server, and `/handback` prints:

```bash
cd '/path/to/project' && codex resume '<thread-id>'
```

That lets a terminal Codex CLI continue the same thread when the Codex persistence layer has the session state available.

## Practical implication

TeleCodex and Codex terminal are two clients over the same underlying Codex session model. They are not the same UI. Telegram-side status/tool formatting should not be expected to show up in the terminal transcript automatically.

If terminal-side auditability is required, the right implementation path is to add an explicit TeleCodex transcript/log mirror, for example:

- write final assistant responses to `.telecodex/transcripts/<instance>/<thread-id>.md`
- optionally include tool summaries and file changes
- keep Telegram-specific formatting out of the transcript

This would provide a stable local record without pretending that an interactive Codex terminal session was active.
