#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-}"
ENV_PATH="${2:-}"
INSTANCE="${3:-default}"

if [[ -z "${REPO_DIR}" || -z "${ENV_PATH}" ]]; then
  echo "Usage: launchd/start.sh <repo-dir> <env-path> [instance]" >&2
  exit 64
fi

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "TeleCodex repo not found: ${REPO_DIR}" >&2
  exit 66
fi

if [[ ! -f "${ENV_PATH}" ]]; then
  echo "TeleCodex env file not found: ${ENV_PATH}" >&2
  exit 66
fi

export TELECODEX_INSTANCE="${INSTANCE}"

cd "${REPO_DIR}"
set -a
# shellcheck disable=SC1090
source "${ENV_PATH}"
set +a
export PATH="${TELECODEX_LAUNCHD_PATH:-/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin:${HOME}/bin}"

exec /usr/bin/env node dist/index.js
