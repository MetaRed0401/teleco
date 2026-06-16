# Repository Guidelines

## Project Structure & Module Organization

TeleCodex is a TypeScript Telegram bridge for the OpenAI Codex SDK. Runtime code lives in `src/`. The main entrypoint is `src/index.ts`, Telegram bot behavior is in `src/bot.ts`, Codex session handling is in `src/codex-session.ts`, configuration parsing is in `src/config.ts`, and workspace browsing helpers are in `src/workspace-browser.ts`.

Tests live in `test/` and mirror source modules with `*.test.ts` files. Build output is emitted to `dist/` and should be treated as generated. Operational docs and service templates live under `docs/`, `scripts/`, `systemd/`, and `launchd/`.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies from `pnpm-lock.yaml`.
- `pnpm run dev` runs the bot locally with `tsx src/index.ts`.
- `pnpm run build` compiles TypeScript into `dist/`.
- `pnpm test` runs the Vitest suite once.
- `scripts/telecodex-service.sh install` installs the Linux user systemd service.
- `scripts/telecodex-service.sh update` rebuilds and restarts the service.

Use Docker only when isolation is required. For a personal development machine, prefer the host service path so Codex can access local tools and auth state.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules. Follow the existing style: 2-space indentation, double quotes, semicolons, and explicit `.js` extensions in relative imports. Keep modules small and feature-focused. Use camelCase for functions and variables, PascalCase for exported types/classes, and uppercase snake case for environment variables such as `TELEGRAM_BOT_TOKEN`.

## Testing Guidelines

Tests use Vitest with files named `test/**/*.test.ts`. Add or update tests when changing config parsing, formatting, session behavior, workspace browsing, or Telegram command rendering. Prefer focused test runs, for example:

```bash
pnpm exec vitest run test/config.test.ts
```

Run `pnpm run build` after changing exported types, entrypoints, or runtime wiring.

## Commit & Pull Request Guidelines

Keep commits concise and scoped to one logical change. Existing history uses short descriptive subjects, for example: `Initial TeleCodex implementation - Telegram bridge for OpenAI Codex CLI SDK`.

Pull requests should describe behavior changes, note config or service impacts, and mention test/build commands run. Include Telegram message examples when changing bot UX.

## Security & Configuration Tips

Never commit `.env`, Telegram tokens, Codex credentials, or API keys. Keep `TELEGRAM_ALLOWED_USER_IDS` restricted to trusted users. Use `ENABLE_UNSAFE_LAUNCH_PROFILES=true` only when the host environment is trusted. Prefer `ENABLE_LIFECYCLE_NOTIFICATIONS=true` for host service monitoring.
