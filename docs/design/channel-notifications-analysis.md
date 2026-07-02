# Channel Notification Analysis

## Summary

Telegram channel notifications are possible, but they should be treated as an explicit notification target configuration, not as an automatic extension of the current session model.

The current runtime maps each active Codex session to a Telegram context key:

- private chat: `chatId`
- forum topic: `chatId:messageThreadId`

Lifecycle notifications currently send only to `TELEGRAM_ALLOWED_USER_IDS`, using those user IDs as private chat IDs. That is safe for a personal bot, but it does not model channel targets.

## Option 1: Single Bot, Multiple Sessions, Channel Notifications

This is feasible.

Requirements:

- the bot must be an admin in the target channel
- the channel chat ID must be configured explicitly, usually as a negative ID such as `-100...`
- TeleCodex needs a mapping from session/context to notification target

Recommended shape:

```json
[
  { "contextKey": "<private-chat-id>", "chatId": "-100<channel-id>" },
  { "contextKey": "<private-chat-id>:<topic-id>", "chatId": "-100<channel-id>" }
]
```

This keeps one bot token and routes selected session events to one or more channels. It fits the existing `SessionRegistry` best because sessions already have stable context keys.

Main limitation: channel posts are broadcast-style. Users cannot safely control sessions from a channel unless command handling remains restricted to allowed private users.

## Option 2: Multiple Bots, Multiple Sessions, One-to-One Channel Notifications

This is also feasible, but more operationally expensive.

Requirements:

- multiple bot tokens
- one TeleCodex process per bot, or a larger process-level bot manager
- separate `.env`, service unit, workspace/auth assumptions, and lifecycle handling per bot
- explicit channel target per bot/session

Recommended implementation path is one process per bot first. A single process managing many bot tokens would require deeper changes to startup, command registration, lifecycle notification routing, polling conflict handling, and session persistence namespacing.

## Recommendation

Implement single-bot channel notification targets first. The first implementation should use one optional `TELEGRAM_CHANNEL_ID` and mirror final Codex responses to that chat/channel only when it is configured.

Suggested config:

```text
TELEGRAM_NOTIFICATION_TARGETS_JSON=[
  {"name":"main","chatId":"-1001111111111","events":["lifecycle","session"]}
]
```

Later, add optional `contextKey` filters if per-session routing is needed.

Keep command authorization based on `TELEGRAM_ALLOWED_USER_IDS`. Channels should receive notifications, not become trusted command surfaces by default.

For channel mirrored responses, include a header on every channel message:

- project path
- truncated last user message
- part number when the response is split

This prevents responses from different sessions or workspaces from being confused in the same channel.
