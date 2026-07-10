#!/usr/bin/env bash
set -euo pipefail

SERVICE_BASENAME="telecodex"
LAUNCHD_DOMAIN="kr.telecodex"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
RUNNER_SRC="${REPO_DIR}/launchd/start.sh"
LOG_DIR="${REPO_DIR}/.telecodex/logs"
LOCK_DIR="${REPO_DIR}/.telecodex"
LOCK_FILE="${LOCK_DIR}/service-update.lock"
BIN_DIR="${HOME}/.local/bin"
BIN_LINK="${BIN_DIR}/telecodex-launchd"

section() {
  printf '\n==> %s\n' "$*"
}

detail() {
  printf '    %s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

run_cmd() {
  detail "+ $*"
  "$@"
}

usage() {
  cat <<USAGE
Usage: scripts/telecodex-launchd.sh <command> [instance|--all] [--force]

Setup:
  install                  Install deps, build, and write LaunchAgent plist(s)
  add <instance>           Create .env.<instance> and write its LaunchAgent plist
  edit <instance>          Edit .env.<instance>
  remove <instance>        Stop/unload an instance; keep env file
  remove <instance> --delete-env
                           Stop/unload an instance and delete .env.<instance>
  list                     Show configured instances and launchd state

Control:
  start [instance|--all]   Start single .env service, one instance, or all instances with --all
  stop [instance|--all]    Stop single .env service, one instance, or all instances with --all
  restart [instance|--all] Restart only when no live operation owns the instance
  restart [instance|--all] --force
                           Restart immediately even when work is active
  status [instance|--all]  Show launchd service state
  logs <instance>          Follow stdout/stderr logs for one instance
  update [instance|--all]  Install deps, build, rewrite plist(s), and restart selected service(s)

Bin:
  bin-install              Register telecodex-launchd in ~/.local/bin
  bin-remove               Remove ~/.local/bin/telecodex-launchd

Legacy:
  uninstall                Stop/unload and remove installed LaunchAgent plist(s)

Examples:
  scripts/telecodex-launchd.sh install
  scripts/telecodex-launchd.sh start
  scripts/telecodex-launchd.sh add first
  scripts/telecodex-launchd.sh start first
  scripts/telecodex-launchd.sh update --all
USAGE
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "launchd helper is for macOS only. Use scripts/telecodex-service.sh on Linux."
}

require_user_launchagent_context() {
  if [[ "$(id -u)" == "0" ]]; then
    fail "Do not run telecodex-launchd with sudo/root. LaunchAgents must be managed by the logged-in macOS user. Re-run this command as your normal user."
  fi
}

validate_instance() {
  local instance="${1:-}"
  if [[ ! "${instance}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    fail "Invalid instance name: ${instance}. Use only letters, numbers, underscore, and dash."
  fi
  if [[ "${instance}" == "example" ]]; then
    fail "Instance name 'example' is reserved."
  fi
}

env_path_for_instance() {
  local instance="$1"
  if [[ "${instance}" == "default" ]]; then
    printf '%s/.env\n' "${REPO_DIR}"
    return
  fi
  printf '%s/.env.%s\n' "${REPO_DIR}" "${instance}"
}

env_value() {
  local env_path="$1"
  local name="$2"
  local key value
  [[ -f "${env_path}" ]] || return 0
  while IFS='=' read -r key value || [[ -n "${key}" ]]; do
    key="${key#export }"
    [[ "${key}" == "${name}" ]] || continue
    value="${value%$'\r'}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s\n' "${value}"
    return 0
  done <"${env_path}"
}

workspace_for_instance() {
  local instance="$1"
  local env_path workspace
  env_path="$(env_path_for_instance "${instance}")"
  workspace="$(env_value "${env_path}" "TELECODEX_WORKSPACE")"
  if [[ -n "${workspace}" ]]; then
    printf '%s\n' "${workspace}"
    return
  fi
  printf '%s\n' "${REPO_DIR}"
}

active_operations_path_for_instance() {
  local instance="$1"
  local workspace
  workspace="$(workspace_for_instance "${instance}")"
  if [[ "${instance}" == "default" ]]; then
    printf '%s/.telecodex/active-operations.json\n' "${workspace}"
    return
  fi
  printf '%s/.telecodex/%s/active-operations.json\n' "${workspace}" "${instance}"
}

guard_instance_active_work() {
  local instance="$1"
  local force="${2:-}"
  [[ "${force}" == "--force" ]] && return 0

  local operations_path status
  operations_path="$(active_operations_path_for_instance "${instance}")"
  if node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    if (!fs.existsSync(file)) process.exit(0);
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      const live = Array.isArray(rows) && rows.some((row) => {
        if (row?.status !== "running" || !Number.isInteger(row?.ownerPid)) return false;
        try { process.kill(row.ownerPid, 0); return true; } catch { return false; }
      });
      process.exit(live ? 2 : 0);
    } catch { process.exit(0); }
  ' "${operations_path}"; then
    return 0
  else
    status=$?
  fi
  if [[ "${status}" == "2" ]]; then
    fail "Instance '${instance}' has active Codex work. Retry when idle or append --force."
  fi
}

label_for_instance() {
  local instance="$1"
  if [[ "${instance}" == "default" ]]; then
    printf '%s\n' "${LAUNCHD_DOMAIN}.${SERVICE_BASENAME}"
    return
  fi
  printf '%s.%s.%s\n' "${LAUNCHD_DOMAIN}" "${SERVICE_BASENAME}" "${instance}"
}

plist_path_for_instance() {
  local instance="$1"
  printf '%s/%s.plist\n' "${LAUNCH_AGENT_DIR}" "$(label_for_instance "${instance}")"
}

require_instance_env() {
  local instance="$1"
  local env_path
  env_path="$(env_path_for_instance "${instance}")"
  [[ -f "${env_path}" ]] || fail "Missing env file for '${instance}': ${env_path}. Run: scripts/telecodex-launchd.sh add ${instance}"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "${value}"
}

write_plist() {
  local instance="$1"
  local env_path label plist_path stdout_path stderr_path
  require_instance_env "${instance}"
  env_path="$(env_path_for_instance "${instance}")"
  label="$(label_for_instance "${instance}")"
  plist_path="$(plist_path_for_instance "${instance}")"
  stdout_path="${LOG_DIR}/${instance}.out.log"
  stderr_path="${LOG_DIR}/${instance}.err.log"

  run_cmd mkdir -p "${LAUNCH_AGENT_DIR}" "${LOG_DIR}"
  detail "+ write ${plist_path}"
  cat >"${plist_path}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "${label}")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "${RUNNER_SRC}")</string>
    <string>$(xml_escape "${REPO_DIR}")</string>
    <string>$(xml_escape "${env_path}")</string>
    <string>$(xml_escape "${instance}")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${REPO_DIR}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "${HOME}")</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${stdout_path}")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${stderr_path}")</string>
</dict>
</plist>
PLIST
}

build_project() {
  section "Installing pnpm dependencies"
  run_cmd pnpm install --frozen-lockfile
  run_cmd node scripts/fix-node-pty-spawn-helper.mjs

  section "Building TeleCodex"
  run_cmd pnpm run build
}

create_env_template() {
  local env_path="$1"
  if [[ -f "${REPO_DIR}/.env.example" ]]; then
    run_cmd cp "${REPO_DIR}/.env.example" "${env_path}"
    return
  fi

  detail "+ create ${env_path}"
  cat >"${env_path}" <<'ENV'
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
CODEX_MODEL=
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
ENABLE_CODEX_APP_SERVER_RUNTIME=true
TOOL_VERBOSITY=summary
ENABLE_TELEGRAM_LOGIN=true
ENABLE_LIFECYCLE_NOTIFICATIONS=false
ENV
}

pick_editor() {
  if [[ -n "${EDITOR:-}" ]]; then
    printf '%s\n' "${EDITOR}"
    return
  fi
  if command -v nano >/dev/null 2>&1; then
    printf 'nano\n'
    return
  fi
  printf 'vi\n'
}

has_instance_envs() {
  local file instance
  for file in "${REPO_DIR}"/.env.*; do
    [[ -e "${file}" ]] || continue
    instance="${file##*/.env.}"
    [[ "${instance}" == "example" || "${instance}" == "default" ]] && continue
    return 0
  done
  return 1
}

env_mode() {
  local has_single=0
  local has_multi=0
  [[ -f "${REPO_DIR}/.env" ]] && has_single=1
  if has_instance_envs; then
    has_multi=1
  fi

  if [[ "${has_single}" -eq 1 && "${has_multi}" -eq 1 ]]; then
    printf 'mixed\n'
    return
  fi
  if [[ "${has_multi}" -eq 1 ]]; then
    printf 'multi\n'
    return
  fi
  if [[ "${has_single}" -eq 1 ]]; then
    printf 'single\n'
    return
  fi
  printf 'none\n'
}

all_instances() {
  local file instance
  for file in "${REPO_DIR}"/.env.*; do
    [[ -e "${file}" ]] || continue
    instance="${file##*/.env.}"
    [[ "${instance}" == "example" || "${instance}" == "default" ]] && continue
    printf '%s\n' "${instance}"
  done

  if [[ -f "${REPO_DIR}/.env" && "$(env_mode)" == "single" ]]; then
    printf 'default\n'
  fi
}

target_instances() {
  local target="${1:-}"
  local mode
  mode="$(env_mode)"

  if [[ -z "${target}" ]]; then
    if [[ "${mode}" == "single" ]]; then
      printf 'default\n'
      return
    fi
    if [[ "${mode}" == "none" ]]; then
      fail "No env files found. Create .env for single-bot mode, or run: scripts/telecodex-launchd.sh add first"
    fi
    fail "Missing instance in multi-instance mode. Use an instance name or --all."
  fi

  if [[ "${target}" == "--all" ]]; then
    if [[ "${mode}" == "single" ]]; then
      printf 'default\n'
      return
    fi
    if [[ "${mode}" == "none" ]]; then
      fail "No env files found. Nothing to do."
    fi
    all_instances
    return
  fi

  if [[ "${target}" == "default" && "${mode}" == "multi" ]]; then
    fail "default targets .env single-bot mode only. In multi-instance mode use an instance name or --all."
  fi

  validate_instance "${target}"
  require_instance_env "${target}"
  printf '%s\n' "${target}"
}

launchd_domain() {
  printf 'gui/%s\n' "$(id -u)"
}

launchd_service_target() {
  local label="$1"
  printf '%s/%s\n' "$(launchd_domain)" "${label}"
}

ensure_launchd_domain() {
  local domain
  domain="$(launchd_domain)"
  if ! launchctl print "${domain}" >/dev/null 2>&1; then
    fail "LaunchAgent domain is not available: ${domain}. Log in to the macOS desktop session as this user, then run the command again without sudo."
  fi
}

bootstrap_service() {
  local label="$1"
  ensure_launchd_domain
  run_cmd launchctl bootstrap "$(launchd_domain)" "${LAUNCH_AGENT_DIR}/${label}.plist"
}

bootstrap_service_with_retry() {
  local label="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if bootstrap_service "${label}"; then
      return 0
    fi
    detail "bootstrap failed; retrying ${label} (${attempt}/5)"
    sleep 1
  done
  return 1
}

bootout_service() {
  local label="$1"
  ensure_launchd_domain
  run_cmd launchctl bootout "$(launchd_service_target "${label}")" || true
}

kickstart_service() {
  local label="$1"
  ensure_launchd_domain
  run_cmd launchctl kickstart -k "$(launchd_service_target "${label}")"
}

service_state() {
  local label="$1"
  launchctl print "$(launchd_service_target "${label}")" >/dev/null 2>&1 && printf 'loaded' || printf 'unloaded'
}

install_command() {
  section "Installing TeleCodex LaunchAgent support"
  build_project

  if [[ -f "${REPO_DIR}/.env" && "$(env_mode)" != "multi" ]]; then
    write_plist default
  fi

  if has_instance_envs; then
    local instance
    while IFS= read -r instance; do
      [[ -n "${instance}" ]] && write_plist "${instance}"
    done < <(all_instances)
  fi

  section "Install complete"
  detail "Single mode: scripts/telecodex-launchd.sh start"
  detail "Multi mode: scripts/telecodex-launchd.sh add first"
}

add_command() {
  local instance="${1:-}"
  validate_instance "${instance}"
  [[ "${instance}" != "default" ]] || fail "Use .env for default single-bot mode; use a named instance for multi-bot mode."
  local env_path
  env_path="$(env_path_for_instance "${instance}")"

  section "Adding TeleCodex LaunchAgent instance: ${instance}"
  build_project
  if [[ -f "${env_path}" ]]; then
    detail "Env already exists: ${env_path}"
  else
    section "Creating env file"
    create_env_template "${env_path}"
    detail "Edit secrets and routing before starting: scripts/telecodex-launchd.sh edit ${instance}"
  fi
  write_plist "${instance}"
  section "Instance added"
  detail "Start: scripts/telecodex-launchd.sh start ${instance}"
}

edit_command() {
  local instance="${1:-}"
  validate_instance "${instance}"
  require_instance_env "${instance}"
  local editor env_path
  editor="$(pick_editor)"
  env_path="$(env_path_for_instance "${instance}")"
  run_cmd "${editor}" "${env_path}"
}

remove_command() {
  local instance="${1:-}"
  local delete_env="${2:-}"
  validate_instance "${instance}"
  require_instance_env "${instance}"
  local label plist_path env_path
  label="$(label_for_instance "${instance}")"
  plist_path="$(plist_path_for_instance "${instance}")"
  env_path="$(env_path_for_instance "${instance}")"

  section "Removing LaunchAgent instance: ${instance}"
  bootout_service "${label}"
  run_cmd rm -f "${plist_path}"
  if [[ "${delete_env}" == "--delete-env" ]]; then
    run_cmd rm -f "${env_path}"
  else
    detail "Env kept: ${env_path}"
  fi
}

list_command() {
  section "TeleCodex LaunchAgent instances"
  printf '%-16s %-12s %-38s %s\n' "INSTANCE" "STATE" "LABEL" "ENV"
  local instance label env_path
  while IFS= read -r instance; do
    [[ -n "${instance}" ]] || continue
    label="$(label_for_instance "${instance}")"
    env_path="$(env_path_for_instance "${instance}")"
    printf '%-16s %-12s %-38s %s\n' "${instance}" "$(service_state "${label}")" "${label}" "${env_path}"
  done < <(all_instances)
}

service_command() {
  local action="$1"
  local target="${2:-}"
  local force="${3:-}"
  local instance label plist_path
  if [[ "${action}" == "logs" && -z "${target}" ]]; then
    fail "logs requires an explicit instance. Use: scripts/telecodex-launchd.sh logs first"
  fi

  while IFS= read -r instance; do
    [[ -n "${instance}" ]] || continue
    label="$(label_for_instance "${instance}")"
    plist_path="$(plist_path_for_instance "${instance}")"
    if [[ "${action}" == "restart" ]]; then
      guard_instance_active_work "${instance}" "${force}"
    fi
    section "${action} ${instance}"
    case "${action}" in
      start)
        [[ -f "${plist_path}" ]] || write_plist "${instance}"
        bootstrap_service_with_retry "${label}" || kickstart_service "${label}"
        ;;
      stop)
        bootout_service "${label}"
        ;;
      restart)
        [[ -f "${plist_path}" ]] || write_plist "${instance}"
        bootout_service "${label}"
        bootstrap_service_with_retry "${label}"
        ;;
      status)
        detail "Label: ${label}"
        detail "State: $(service_state "${label}")"
        ;;
      logs)
        detail "Press Ctrl-C to stop following logs."
        run_cmd tail -f "${LOG_DIR}/${instance}.out.log" "${LOG_DIR}/${instance}.err.log"
        ;;
    esac
  done < <(target_instances "${target}")
}

read_lock_pid() {
  local key value
  [[ -f "${LOCK_FILE}" ]] || return 0
  while IFS='=' read -r key value || [[ -n "${key}" ]]; do
    [[ "${key}" == "pid" ]] || continue
    printf '%s\n' "${value}"
    return 0
  done <"${LOCK_FILE}"
}

release_lock() {
  local pid
  pid="$(read_lock_pid)"
  if [[ "${pid}" == "$$" ]]; then
    rm -f "${LOCK_FILE}"
  fi
}

acquire_lock() {
  local command="$1"
  local target="$2"
  local existing_pid
  if [[ -f "${LOCK_FILE}" ]]; then
    existing_pid="$(read_lock_pid)"
    if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
      fail "Another TeleCodex service operation is already running."
    fi
    rm -f "${LOCK_FILE}"
  fi

  run_cmd mkdir -p "${LOCK_DIR}"
  cat >"${LOCK_FILE}" <<LOCK
pid=$$
command=${command}
target=${target}
startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo=${REPO_DIR}
LOCK
  trap release_lock EXIT
}

update_command() {
  local target="${1:-}"
  local force="${2:-}"
  local instances=()
  local instance
  while IFS= read -r instance; do
    [[ -n "${instance}" ]] && instances+=("${instance}")
  done < <(target_instances "${target}")
  [[ "${#instances[@]}" -gt 0 ]] || fail "No instances found."

  for instance in "${instances[@]}"; do
    guard_instance_active_work "${instance}" "${force}"
  done

  acquire_lock "update" "${target}"
  build_project
  for instance in "${instances[@]}"; do
    write_plist "${instance}"
    service_command restart "${instance}"
  done
}

bin_install_command() {
  section "Installing telecodex-launchd command"
  run_cmd mkdir -p "${BIN_DIR}"
  run_cmd ln -sfn "${REPO_DIR}/scripts/telecodex-launchd.sh" "${BIN_LINK}"
  detail "Add ${BIN_DIR} to PATH if needed."
}

bin_remove_command() {
  section "Removing telecodex-launchd command"
  run_cmd rm -f "${BIN_LINK}"
}

uninstall_command() {
  section "Uninstalling TeleCodex LaunchAgents"
  local instance label plist_path
  while IFS= read -r instance; do
    [[ -n "${instance}" ]] || continue
    label="$(label_for_instance "${instance}")"
    plist_path="$(plist_path_for_instance "${instance}")"
    bootout_service "${label}"
    run_cmd rm -f "${plist_path}"
  done < <(all_instances)
  section "Uninstall complete"
  detail "Env files were kept."
}

require_macos
require_user_launchagent_context
command="${1:-}"
if [[ -z "${command}" ]]; then
  usage
  exit 1
fi
shift || true

case "${command}" in
  install)
    install_command
    ;;
  add)
    add_command "${1:-}"
    ;;
  edit)
    edit_command "${1:-}"
    ;;
  remove)
    remove_command "${1:-}" "${2:-}"
    ;;
  list)
    list_command
    ;;
  start | stop | restart | status | logs)
    service_command "${command}" "${1:-}" "${2:-}"
    ;;
  update)
    update_command "${1:-}" "${2:-}"
    ;;
  bin-install)
    bin_install_command
    ;;
  bin-remove)
    bin_remove_command
    ;;
  uninstall)
    uninstall_command
    ;;
  *)
    usage
    exit 1
    ;;
esac
