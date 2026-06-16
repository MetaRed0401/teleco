# Runtime Architecture

TeleCodex is a personal Telegram control plane for Codex. Telegram is the UI, but Codex still runs on the host machine where your repositories, auth state, shell tools, and language CLIs live.

## Main Flow

```text
Telegram user
  -> Telegram Bot API
  -> TeleCodex Node.js service
  -> Codex app-server
  -> local workspace and tools
```

The app-server runtime is the primary path. It provides structured turn lifecycle events, assistant deltas, tool activity, file-change events, token usage, account/rate-limit status, approval requests, and native context compact.

The legacy SDK fallback is kept only as a compatibility path. New operation should use `ENABLE_CODEX_APP_SERVER_RUNTIME=true`.

## Sessions and Instances

TeleCodex keeps one active Codex thread per Telegram context. Private chats use the chat ID. Topic-aware contexts may include the topic ID.

Multiple bots can run from one checkout:

```text
.env.first  -> telecodex@first.service  -> .telecodex/first/contexts.json
.env.second -> telecodex@second.service -> .telecodex/second/contexts.json
.env.third  -> telecodex@third.service  -> .telecodex/third/contexts.json
```

Each instance should have its own Telegram token, routing settings, and optional channel ID. The source code is shared; runtime metadata is separated by instance.

## Streaming and Tool Events

Assistant text is streamed into Telegram messages. Tool activity is sent separately so mobile output does not become one large concatenated transcript.

Tool events are derived from app-server item notifications:

- shell commands
- file changes
- MCP and dynamic tool calls
- reasoning summaries
- context compaction
- warnings and errors

`TOOL_VERBOSITY` controls how much detail is sent.

## Approval Bridge

When the selected launch profile uses an approval policy that asks for review, app-server approval requests are forwarded to Telegram inline buttons.

Supported approval families include command execution, file changes, and permission profile requests. For unattended personal service operation, `CODEX_APPROVAL_POLICY=never` avoids approval prompts.

## Compact Flow

Manual compact runs two stages:

```text
1. app-server native compact on the active thread
2. Codex CLI PTY `codex resume <thread>` followed by `/compact`
```

The second stage exists because terminal parity matters. It reinforces the same compact behavior you would expect when resuming the thread in Codex CLI.

Auto compact is policy-driven:

- Codex app-server compaction event observed during a turn
- context usage reaches `AUTO_COMPACT_CONTEXT_THRESHOLD`

`AUTO_COMPACT_AFTER_EVERY_TURN=true` means TeleCodex checks the threshold after every completed turn. It does not compact every turn by itself.

## Queue, Stop, and Service Updates

Codex turns run in the background so Telegram can continue processing updates. `/stop` can interrupt an active turn without waiting for long polling to finish the previous prompt.

Incoming prompts are queued while a turn or compact is running. The next queued prompt starts after the current operation completes.

Service updates are guarded by `.telecodex/service-update.lock`. In multi-instance mode, update, restart, and stop actions require an explicit instance or `--all` to avoid touching the wrong bot.
