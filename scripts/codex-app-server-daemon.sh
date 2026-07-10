#!/usr/bin/env bash
set -euo pipefail

resolve_codex() {
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return
  fi

  local candidate
  for candidate in \
    "$HOME/.local/bin/codex" \
    "/home/linuxbrew/.linuxbrew/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex" \
    "/usr/bin/codex"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  echo "Codex CLI executable not found." >&2
  exit 127
}

runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/telecodex"
mkdir -p "$runtime_dir"
exec 9>"$runtime_dir/codex-app-server.lock"
if ! flock -n 9; then
  echo "A TeleCodex Codex app-server runtime is already active." >&2
  exit 75
fi

codex_bin="$(resolve_codex)"
exec "$codex_bin" app-server --listen "ws://127.0.0.1:45123"
