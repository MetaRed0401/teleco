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

if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  runtime_dir="${XDG_RUNTIME_DIR}/telecodex"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  runtime_dir="${TMPDIR:-/tmp}/telecodex-$(id -u)"
else
  runtime_dir="/run/user/$(id -u)/telecodex"
fi
mkdir -p -m 0700 "$runtime_dir"

lock_dir="$runtime_dir/codex-app-server.lock"
if ! mkdir -m 0700 "$lock_dir" 2>/dev/null; then
  owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    echo "A TeleCodex Codex app-server runtime is already active (pid $owner_pid)." >&2
    exit 75
  fi
  rm -f "$lock_dir/pid"
  if ! rmdir "$lock_dir" 2>/dev/null || ! mkdir -m 0700 "$lock_dir" 2>/dev/null; then
    echo "Unable to reclaim stale TeleCodex app-server lock: $lock_dir" >&2
    exit 75
  fi
fi
printf '%s\n' "$$" >"$lock_dir/pid"

apply_codex_environment_override() {
  local source_name="$1"
  local target_name="$2"
  local value="${!source_name:-}"
  if [[ -n "$value" ]]; then
    export "$target_name=$value"
  fi
  unset "$source_name"
}

apply_codex_environment_override CODEX_HTTP_PROXY HTTP_PROXY
apply_codex_environment_override CODEX_HTTPS_PROXY HTTPS_PROXY
apply_codex_environment_override CODEX_NO_PROXY NO_PROXY
apply_codex_environment_override CODEX_NODE_EXTRA_CA_CERTS NODE_EXTRA_CA_CERTS

codex_bin="$(resolve_codex)"
exec "$codex_bin" app-server --listen "ws://127.0.0.1:45123"
