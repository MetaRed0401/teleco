#!/usr/bin/env bash
set -euo pipefail

SERVICE_BASENAME="telecodex"
LEGACY_SERVICE_NAME="${SERVICE_BASENAME}.service"
TEMPLATE_SERVICE_NAME="${SERVICE_BASENAME}@.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
UNIT_SRC="${REPO_DIR}/systemd/${LEGACY_SERVICE_NAME}"
TEMPLATE_UNIT_SRC="${REPO_DIR}/systemd/${TEMPLATE_SERVICE_NAME}"
UNIT_DEST="${USER_SYSTEMD_DIR}/${LEGACY_SERVICE_NAME}"
TEMPLATE_UNIT_DEST="${USER_SYSTEMD_DIR}/${TEMPLATE_SERVICE_NAME}"
LOCK_DIR="${REPO_DIR}/.telecodex"
LOCK_FILE="${LOCK_DIR}/service-update.lock"
BIN_DIR="${HOME}/.local/bin"
BIN_LINK="${BIN_DIR}/telecodex-service"

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
Usage: scripts/telecodex-service.sh <command> [instance|--all]

Setup:
  install                  Install service units, install deps, and build
  add <instance>           Create .env.<instance> and enable telecodex@<instance>
  edit <instance>          Edit .env.<instance>
  remove <instance>        Stop/disable an instance; keep env file
  remove <instance> --delete-env
                           Stop/disable an instance and delete .env.<instance>
  list                     Show configured instances and service state

Control:
  start [instance|--all]   Start single .env service, one instance, or all instances with --all
  stop [instance|--all]    Stop single .env service, one instance, or all instances with --all
  restart [instance|--all] Restart single .env service, one instance, or all instances with --all
  status [instance|--all]  Show single .env service, one instance, or all instances with --all
  logs <instance>          Follow logs for one instance
  update [instance|--all]  Install deps, build, and restart selected service(s)

Bin:
  bin-install              Register telecodex-service in ~/.local/bin
  bin-remove               Remove ~/.local/bin/telecodex-service

Legacy:
  uninstall                Remove installed service units

Examples:
  scripts/telecodex-service.sh install
  scripts/telecodex-service.sh start
  scripts/telecodex-service.sh add main
  scripts/telecodex-service.sh edit main
  scripts/telecodex-service.sh start main
  scripts/telecodex-service.sh update main
  scripts/telecodex-service.sh update --all
USAGE
}

run_user_systemctl() {
  run_cmd systemctl --user "$@"
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

service_name_for_instance() {
  local instance="$1"
  if [[ "${instance}" == "default" ]]; then
    printf '%s\n' "${LEGACY_SERVICE_NAME}"
    return
  fi
  printf '%s@%s.service\n' "${SERVICE_BASENAME}" "${instance}"
}

require_instance_env() {
  local instance="$1"
  local env_path
  env_path="$(env_path_for_instance "${instance}")"
  [[ -f "${env_path}" ]] || fail "Missing env file for '${instance}': ${env_path}. Run: scripts/telecodex-service.sh add ${instance}"
}

install_units() {
  section "Installing systemd unit files"
  detail "Repository: ${REPO_DIR}"
  detail "Legacy unit: ${UNIT_DEST}"
  detail "Template unit: ${TEMPLATE_UNIT_DEST}"
  run_cmd mkdir -p "${USER_SYSTEMD_DIR}"
  run_cmd install -m 0644 "${UNIT_SRC}" "${UNIT_DEST}"
  run_cmd install -m 0644 "${TEMPLATE_UNIT_SRC}" "${TEMPLATE_UNIT_DEST}"
  run_user_systemctl daemon-reload
}

build_project() {
  section "Installing pnpm dependencies"
  run_cmd pnpm install --frozen-lockfile
  run_cmd node scripts/fix-node-pty-spawn-helper.mjs

  section "Building TeleCodex"
  run_cmd pnpm run build
}

install_command() {
  section "Installing TeleCodex service support"
  install_units
  build_project

  warn_env_default

  if [[ -f "${REPO_DIR}/.env" ]]; then
    section "Enabling default single-bot service"
    run_user_systemctl enable "${LEGACY_SERVICE_NAME}"
    detail ".env detected. Default single-bot service remains available."
  fi

  section "Install complete"
  detail "Single mode: scripts/telecodex-service.sh start"
  detail "Multi mode: scripts/telecodex-service.sh add main"
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
TELEGRAM_CHANNEL_ID=
CODEX_API_KEY=
CODEX_MODEL=
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
TOOL_VERBOSITY=summary
SHOW_TURN_TOKEN_USAGE=false
ENABLE_TELEGRAM_LOGIN=true
ENABLE_TELEGRAM_REACTIONS=false
ENABLE_LIFECYCLE_NOTIFICATIONS=false
OPENAI_API_KEY=
ENV
}

add_command() {
  local instance="${1:-}"
  validate_instance "${instance}"
  guard_add_instance "${instance}"
  local env_path
  env_path="$(env_path_for_instance "${instance}")"

  section "Adding TeleCodex instance: ${instance}"
  warn_env_default
  install_units

  if [[ -f "${env_path}" ]]; then
    detail "Env already exists: ${env_path}"
  else
    section "Creating env file"
    create_env_template "${env_path}"
    detail "Edit secrets and routing before starting: scripts/telecodex-service.sh edit ${instance}"
  fi

  section "Enabling service"
  run_user_systemctl enable "$(service_name_for_instance "${instance}")"

  section "Instance added"
  detail "Env: ${env_path}"
  detail "Start: scripts/telecodex-service.sh start ${instance}"
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

edit_command() {
  local instance="${1:-}"
  validate_instance "${instance}"
  require_instance_env "${instance}"
  local env_path editor
  env_path="$(env_path_for_instance "${instance}")"
  editor="$(pick_editor)"

  section "Editing env for ${instance}"
  detail "Env: ${env_path}"
  run_cmd "${editor}" "${env_path}"

  section "Edit complete"
  detail "Restart with: scripts/telecodex-service.sh restart ${instance}"
}

remove_command() {
  local instance="${1:-}"
  local delete_env="${2:-}"
  validate_instance "${instance}"
  guard_remove_instance "${instance}"
  local env_path service_name
  env_path="$(env_path_for_instance "${instance}")"
  service_name="$(service_name_for_instance "${instance}")"

  section "Removing TeleCodex instance: ${instance}"
  run_user_systemctl disable --now "${service_name}" || true

  if [[ "${delete_env}" == "--delete-env" ]]; then
    section "Deleting env file"
    run_cmd rm -f "${env_path}"
  else
    detail "Env kept: ${env_path}"
    detail "Delete it with: scripts/telecodex-service.sh remove ${instance} --delete-env"
  fi

  section "Remove complete"
}

all_instances() {
  local file instance
  for file in "${REPO_DIR}"/.env.*; do
    [[ -e "${file}" ]] || continue
    instance="${file##*/.env.}"
    [[ "${instance}" == "example" ]] && continue
    if [[ "${instance}" == "default" ]]; then
      printf '    Warning: .env.default is deprecated. Move its values into .env, then delete .env.default.\n' >&2
      continue
    fi
    printf '%s\n' "${instance}"
  done

  if [[ -f "${REPO_DIR}/.env" && "$(env_mode)" == "single" ]]; then
    printf 'default\n'
  fi
}

warn_env_default() {
  if [[ -f "${REPO_DIR}/.env.default" ]]; then
    detail "Warning: .env.default is deprecated. Use .env for the default single-bot instance."
    detail "Move all values from .env.default into .env, then delete .env.default."
  fi
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

list_command() {
  print_mode_summary
  section "TeleCodex instances"
  printf '%-16s %-10s %-10s %-28s %s\n' "INSTANCE" "ENABLED" "ACTIVE" "CHANNEL" "ENV"

  local instances=()
  local instance env_path service_name enabled active channel
  while IFS= read -r instance; do
    [[ -n "${instance}" ]] && instances+=("${instance}")
  done < <(all_instances)

  if [[ "${#instances[@]}" -eq 0 ]]; then
    detail "No instances found. Create .env for single-bot mode, or run: scripts/telecodex-service.sh add main"
    return
  fi

  for instance in "${instances[@]}"; do
    env_path="$(env_path_for_instance "${instance}")"
    service_name="$(service_name_for_instance "${instance}")"
    enabled="$(systemctl --user is-enabled "${service_name}" 2>/dev/null || true)"
    active="$(systemctl --user is-active "${service_name}" 2>/dev/null || true)"
    channel="$(env_value "${env_path}" "TELEGRAM_CHANNEL_ID")"
    [[ -n "${channel}" ]] || channel="-"
    printf '%-16s %-10s %-10s %-28s %s\n' "${instance}" "${enabled:-unknown}" "${active:-unknown}" "${channel}" "${env_path}"
  done

  warn_duplicate_env_values "TELEGRAM_BOT_TOKEN" "bot token" "${instances[@]}"
  warn_duplicate_env_values "TELEGRAM_CHANNEL_ID" "channel id" "${instances[@]}"
}

warn_duplicate_env_values() {
  local key="$1"
  local label="$2"
  shift 2
  declare -A seen=()
  local instance env_path value
  for instance in "$@"; do
    env_path="$(env_path_for_instance "${instance}")"
    value="$(env_value "${env_path}" "${key}")"
    [[ -n "${value}" ]] || continue
    if [[ -n "${seen[${value}]:-}" ]]; then
      detail "Warning: ${label} is shared by instances '${seen[${value}]}' and '${instance}'."
    else
      seen["${value}"]="${instance}"
    fi
  done
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
      fail "No env files found. Create .env for single-bot mode, or run: scripts/telecodex-service.sh add main"
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
    fail "default targets .env single-bot mode only. In multi-instance mode use an instance name such as main, second, third, or --all."
  fi

  validate_instance "${target}"
  require_instance_env "${target}"
  printf '%s\n' "${target}"
}

is_single_env_mode() {
  [[ "$(env_mode)" == "single" ]]
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

print_mode_summary() {
  local mode
  mode="$(env_mode)"
  case "${mode}" in
    single)
      detail "Mode: single (.env -> telecodex.service)"
      ;;
    multi)
      detail "Mode: multi (.env.<instance> -> telecodex@<instance>.service)"
      ;;
    mixed)
      detail "Mode: mixed"
      detail "Warning: both .env and .env.<instance> files exist."
      detail "Commands without an explicit instance are disabled. Use an instance name or --all."
      ;;
    none)
      detail "Mode: none"
      ;;
  esac
}

guard_add_instance() {
  local instance="$1"
  local mode
  mode="$(env_mode)"

  if [[ "${instance}" == "default" ]]; then
    if [[ "${mode}" == "multi" || "${mode}" == "mixed" ]]; then
      fail "Cannot add default while instance env files exist. Use .env for single-bot mode, or add a named instance."
    fi
    return
  fi

  if [[ "${mode}" == "single" ]]; then
    detail "Warning: .env already exists. Adding '${instance}' will switch operations into mixed/multi mode."
    detail "If this is intentional, keep using explicit instance names. Otherwise move .env into .env.${instance} first."
  fi
}

guard_remove_instance() {
  local instance="$1"
  if [[ "${instance}" == "default" && "$(env_mode)" != "single" ]]; then
    fail "default removal is only for single-bot .env mode."
  fi
}

guard_service_action() {
  local action="$1"
  local target="$2"
  local mode
  mode="$(env_mode)"

  if [[ "${action}" == "logs" && -z "${target}" ]]; then
    fail "logs requires an explicit instance. Use: scripts/telecodex-service.sh logs main"
  fi

  if [[ "${mode}" == "mixed" && -z "${target}" ]]; then
    fail "Both .env and .env.<instance> files exist. Refusing implicit ${action}; use an explicit instance or --all."
  fi
}

guard_update_action() {
  local target="$1"
  local mode
  mode="$(env_mode)"

  if [[ "${mode}" == "mixed" && -z "${target}" ]]; then
    fail "Both .env and .env.<instance> files exist. Refusing implicit update; use an explicit instance or --all."
  fi

  if [[ "${mode}" == "multi" && -z "${target}" ]]; then
    fail "Missing instance in multi-instance mode. Use: update <instance> or update --all."
  fi

  if [[ "${target}" == "--all" && "${mode}" == "mixed" ]]; then
    detail "Warning: --all in mixed mode will ignore .env and update only .env.<instance> services."
  fi
}

validate_env_for_instance() {
  local instance="$1"
  local env_path
  env_path="$(env_path_for_instance "${instance}")"

  if [[ ! -f "${env_path}" ]]; then
    fail "Missing env file: ${env_path}"
  fi

  if [[ -z "$(env_value "${env_path}" "TELEGRAM_BOT_TOKEN")" ]]; then
    detail "Warning: ${env_path} has empty TELEGRAM_BOT_TOKEN."
  fi
  if [[ -z "$(env_value "${env_path}" "TELEGRAM_ALLOWED_USER_IDS")" ]]; then
    detail "Warning: ${env_path} has empty TELEGRAM_ALLOWED_USER_IDS."
  fi
}

service_command() {
  local action="$1"
  local target="${2:-}"
  local instances=()
  local instance

  guard_service_action "${action}" "${target}"

  while IFS= read -r instance; do
    [[ -n "${instance}" ]] && instances+=("${instance}")
  done < <(target_instances "${target}")

  [[ "${#instances[@]}" -gt 0 ]] || fail "No instances found."
  if [[ "${action}" == "logs" && "${#instances[@]}" -ne 1 ]]; then
    fail "logs requires a single instance."
  fi

  for instance in "${instances[@]}"; do
    validate_env_for_instance "${instance}"
    section "${action^} ${instance}"
    if [[ "${action}" == "logs" ]]; then
      detail "Press Ctrl-C to stop following logs."
      run_cmd journalctl --user -u "$(service_name_for_instance "${instance}")" -f
    else
      run_user_systemctl "${action}" "$(service_name_for_instance "${instance}")"
    fi
  done
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
      detail "Active lock:"
      sed 's/^/    /' "${LOCK_FILE}" >&2
      fail "Another TeleCodex service operation is already running."
    fi
    detail "Removing stale lock: ${LOCK_FILE}"
    rm -f "${LOCK_FILE}"
  fi

  run_cmd mkdir -p "${LOCK_DIR}"
  cat >"${LOCK_FILE}" <<LOCK
pid=$$
command=${command}
target=${target}
startedAt=$(date -Is)
repo=${REPO_DIR}
LOCK
  trap release_lock EXIT
}

update_command() {
  local target="${1:-}"
  local instances=()
  local instance

  guard_update_action "${target}"

  while IFS= read -r instance; do
    [[ -n "${instance}" ]] && instances+=("${instance}")
  done < <(target_instances "${target}")

  [[ "${#instances[@]}" -gt 0 ]] || fail "No instances found."

  acquire_lock "update" "${target}"
  install_units
  build_project

  for instance in "${instances[@]}"; do
    validate_env_for_instance "${instance}"
    section "Restarting ${instance}"
    run_user_systemctl restart "$(service_name_for_instance "${instance}")"
  done

  section "Update complete"
}

bin_install_command() {
  section "Installing telecodex-service command"
  run_cmd mkdir -p "${BIN_DIR}"
  run_cmd ln -sfn "${REPO_DIR}/scripts/telecodex-service.sh" "${BIN_LINK}"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*)
      detail "${BIN_DIR} is already in PATH."
      ;;
    *)
      detail "Warning: ${BIN_DIR} is not in PATH."
      detail "Add it to your shell profile, for example: export PATH=\"${BIN_DIR}:\$PATH\""
      ;;
  esac
}

bin_remove_command() {
  section "Removing telecodex-service command"
  run_cmd rm -f "${BIN_LINK}"
}

uninstall_command() {
  section "Uninstalling TeleCodex service units"
  for instance in $(all_instances); do
    run_user_systemctl disable --now "$(service_name_for_instance "${instance}")" || true
  done
  run_user_systemctl disable --now "${LEGACY_SERVICE_NAME}" || true
  run_cmd rm -f "${UNIT_DEST}" "${TEMPLATE_UNIT_DEST}"
  run_user_systemctl daemon-reload
  section "Uninstall complete"
  detail "Env files were kept."
}

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
    service_command "${command}" "${1:-}"
    ;;
  update)
    update_command "${1:-}"
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
