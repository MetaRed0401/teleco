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

Teleco uses a persistent app-server listener as the turn owner. Linux hosts run one listener in the independent `telecodex-codex-app-server.service`, and bridge instances connect directly over a local WebSocket. A Teleco bridge restart closes only its client connection. On startup, persisted operation thread/turn IDs are reconciled through `thread/read(includeTurns: true)`; active turns are polled and offline-completed final responses are returned to the originating Telegram context. Non-Linux direct stdio remains a compatibility path and cannot preserve an active turn when Teleco exits.

App-server approval server requests are connection-scoped. Teleco persists a bounded fingerprint and Telegram route for pending approvals. After a bridge restart, old approval buttons are marked expired because their original request ID cannot be answered on the new connection. If app-server reissues the same approval, Teleco matches the fingerprint and sends a restored approval prompt; otherwise the user is directed to `/retry`.

The legacy SDK fallback is kept only as a compatibility path. New operation should use `ENABLE_CODEX_APP_SERVER_RUNTIME=true`.

The supported Codex runtime baseline for this branch is 0.144.1. It uses canonical app-server items for tool activity and includes the `0.142.5` protection against full `Responses` WebSocket request payloads being written to trace logs.

TeleCodex keeps app-server handling conservative across Codex releases. Canonical command, file change, MCP, dynamic tool, collaboration, sub-agent, web search, review, hook, and compact activity is normalized into one item-ID lifecycle. Aggregated completion output contributes only the suffix not already received through delta notifications. Unknown MCP/plugin/status notifications are ignored unless they are useful and safe to show on mobile.

MCP URL elicitations are scoped to the originating Telegram context. Only credential-free HTTPS URLs receive an authentication button, and the user must explicitly confirm completion or cancel. Structured form elicitations fail closed until Teleco provides a schema-aware form UI. Authentication prompts are never mirrored to notification channels.

The Codex `writes` mode belongs to app-tool approval configuration, not the global thread approval policy. Teleco therefore keeps `CODEX_APPROVAL_POLICY` limited to SDK/thread values and does not expose `writes` as a launch-profile option.

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

Assistant text is accumulated by default and sent once as the final response. Tool activity is sent separately so mobile output shows progress without repeatedly editing or replacing the final answer.

`RESPONSE_PREVIEW_MODE` controls optional response previews: `off`, `edit`, or `draft`. The default is `off`. `TOOL_ACTIVITY_MODE` controls progress messages: `off`, `compact`, `verbose`, or `errors-only`. `FINAL_RESPONSE_MODE` controls whether the final answer is sent as a new message or edits an existing preview: `send` or `edit`. The `/streaming` command can override these values per Telegram context without editing `.env`.

Tool events are derived from app-server item notifications:

- shell commands
- file changes
- MCP and dynamic tool calls
- reasoning summaries
- context compaction
- warnings and errors

`TOOL_VERBOSITY` controls how much detail is sent. Use `summary` for the quietest mobile-friendly default, `new` to show tool start/end messages without streaming command output, and `all` only when live tool output is useful.

Dynamic tools and MCP servers are discovered by Codex at runtime. Do not assume the first tool list is exhaustive, and do not treat plugin/catalog metadata as user-visible unless TeleCodex explicitly formats it.

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

## Time, Paths, And Proxies

Telegram-facing operational messages should prefer explicit timestamps and workspace paths because mobile users may return to a session much later. Relative wording is fine for compact labels, but recovery and status messages should include enough absolute context to resume.

When running through Docker, launchd, systemd, or a remote executor, prefer runtime-provided absolute paths over manual path assembly. Behind PAC/WPAD/static proxies, set proxy environment variables for the service/container before starting Codex app-server.
