# Terminal Parity Notes

TeleCodex runs Codex through Telegram, a Node.js process, systemd, and Codex app-server. That is close to a terminal workflow, but it is not identical to an interactive Codex CLI session.

## Main Gaps

- systemd does not load the user's interactive shell startup files by default.
- `PATH` can differ from the terminal, so `node`, `pnpm`, `git`, `codex`, or language tools may be missing.
- Git credential helpers and `SSH_AUTH_SOCK` may be unavailable.
- Package manager commands can fail when the service user sees a different environment.
- Telegram is a separate UI, so terminal screen output and Telegram output are not mirrored automatically.

## Implemented Diagnostics

Use `/doctor` in Telegram to inspect the service runtime:

- current user, cwd, workspace, HOME, SHELL, and PATH preview
- `node`, `pnpm`, `corepack`, `git`, and `codex` availability
- project indicators such as `package.json`, `pnpm-lock.yaml`, and `node_modules`
- Git worktree status, credential helper summary, and SSH agent presence
- secret environment variable presence without printing secret values
- Codex app-server approval bridge feasibility

Use `/locks` in Telegram to inspect runtime locks:

- Git index lock resolved through `git rev-parse --git-path index.lock`
- TeleCodex service update lock under `.telecodex/service-update.lock`
- lock age and service update metadata when available

No lock is removed automatically. A future cleanup command should require explicit confirmation and process checks.

## Approval Bridge Feasibility

TeleCodex uses Codex app-server as the primary runtime. App-server exposes structured events and server requests that allow Telegram to display tool activity and respond to approval prompts.

Important event/request families include:

- `thread/*` status and token usage notifications
- `turn/*` lifecycle notifications
- `item/*` tool, file change, message, reasoning, and compaction events
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

Telegram inline approval is supported when the selected launch profile uses an approval policy that asks for review. For unattended service operation, `approvalPolicy=never` still avoids prompts entirely.

## Practical Recommendation

For terminal-like personal workstation operation:

- keep the normal default profile conservative
- expose stronger host profiles only intentionally
- use `/doctor` before debugging `pnpm`, `git`, or tool lookup failures
- use `/locks` before assuming Codex itself is stuck
- use `/compact` after long threads to trigger TeleCodex two-stage compaction
- document any required PATH or SSH agent setup in the service environment

## Context Compact

TeleCodex uses a two-stage compact flow for better terminal parity:

```text
1. Codex app-server native compact via `thread/compact/start`
2. Codex CLI PTY reinforcement via `codex resume <thread>` and `/compact`
```

Telegram command behavior:

- `/compact` runs both compact stages for the active thread.
- `/compact status` shows the current thread, workspace, launch profile, model, and compact availability.
- `/compact preview` is not supported because the native protocol exposes a start endpoint, not a preview-only endpoint.

The thread id is preserved. Incoming Telegram prompts are queued while compact is running.

## Auto Compact

Codex app-server can emit context compaction events during a turn. TeleCodex treats that as a signal and runs the CLI PTY reinforcement after the turn finishes.

TeleCodex can also check context usage after turns:

- `AUTO_COMPACT_CONTEXT_THRESHOLD=0.80` runs compact when reported usage reaches 80%.
- `AUTO_COMPACT_AFTER_EVERY_TURN=true` checks the threshold after every turn.
- It does not compact every turn unless the threshold is reached or Codex app-server emitted a compaction event.
- `AUTO_COMPACT_COOLDOWN_TURNS` and `AUTO_COMPACT_COOLDOWN_MINUTES` reduce repeated threshold-based compacts.

## Git-capable Codex CLI sessions

Codex `workspace-write` sessions can still mount `.git` as read-only. In that mode source files are editable, but Git metadata operations fail because Git cannot create files such as `.git/index.lock` or `.git/refs/...lock`.

Use a full-access CLI session when Codex needs to commit, branch, reset, rebase, or push:

```bash
codex -s danger-full-access -a never -C /path/to/telecodex resume --last
```

For a specific thread:

```bash
codex -s danger-full-access -a never -C /path/to/telecodex resume <thread-id>
```

`/doctor` reports whether Git metadata is writable. If it says Git metadata is not writable, use a full-access Codex CLI session or run Git commands from a normal host terminal.
