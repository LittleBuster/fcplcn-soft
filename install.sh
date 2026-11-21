#!/usr/bin/env bash
# FCPLCn installer entry point. Compatible with macOS Bash 3.2.
set -euo pipefail
umask 077

fcplcn_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$fcplcn_source_dir/deploy/platform.sh"

fcplcn_usage() {
    cat <<'EOF'
FCPLCn — Future City PLC Next

Usage: ./install.sh
Interactive menus: 1. cloud / 2. hub, then 1. Установка / 2. Обновление.
Optional: ./install.sh [cloud|hub] [action] [options] for automation.

Actions:
  install    Prepare Docker, dependencies and the application.
  update     Deploy a Git revision, keeping configuration and a backup.
  status     Show the installed release and container status.
  logs       Show container logs.
  backup     Stop services briefly and create a consistent backup.
  rollback   Return to the previous application release.
  restore    Restore an explicitly selected backup.
  doctor     Check the platform and prerequisites without installing anything.
  certificates  Renew the cloud MQTT certificate when due, preserving the CA.
  plc        Create local MQTT credentials for a PLC (hub only).

Common options:
  --repo URL --ref main       Git source for installation / updates.
  --dir PATH                 Persistent installation directory.
  --domain cloud.example.com Public DNS name for cloud installation.
  --image IMAGE              Use an explicit container image.
  --source-build             Build locally instead of pulling a GitHub image.
  --project NAME             Separate Docker project (saved after installation).
  --http-port N              Published web port (hub 3000, cloud 80).
  --https-port N             Published cloud HTTPS port (443).
  --mqtt-port N              Published MQTT port (hub 1883, cloud 8883).
  --backup PATH              Backup directory for restore.
  --plc-id ID                PLC deviceId for the plc command.
  --follow                   Follow service logs.
  --dry-run                  Preview the operation without changing the host.
  --yes                      Non-interactive operation.
  --help                     Show this help.

Examples:
  ./install.sh
  ./install.sh hub install
  ./install.sh cloud install --domain cloud.example.com
  ./install.sh hub update --repo https://github.com/OWNER/fcplcn-soft.git
  ./install.sh hub backup

Documentation: deploy/README.md
EOF
}

# Help must work even before Python or Docker is installed.
for fcplcn_argument in "$@"; do
    case "$fcplcn_argument" in --help|-h) fcplcn_usage; exit 0 ;; esac
done

fcplcn_role=${1:-}
case "$fcplcn_role" in
    cloud|hub|1|2|0) shift ;;
    ''|--*) fcplcn_role= ;;
    *) fcplcn_fail 'Выберите cloud (1) или hub (2).'; exit 2 ;;
esac
if [ -z "$fcplcn_role" ]; then
    if [ ! -t 0 ]; then
        printf '%s\n' 'Для выбора компонента запустите ./install.sh в терминале.' >&2
        fcplcn_usage >&2
        exit 2
    fi
    while :; do
        printf '\nFCPLCn — выбор компонента\n  1. cloud — облако / VPS\n  2. hub   — локальный хаб\n  0. Выход\nВыберите пункт: '
        IFS= read -r fcplcn_role || exit 0
        case "$fcplcn_role" in
            1|2|cloud|hub|0) break ;;
            *) printf '%s\n' 'Введите 1, 2 или 0.' ;;
        esac
    done
fi
case "$fcplcn_role" in
    1|cloud) fcplcn_role=cloud ;;
    2|hub) fcplcn_role=hub ;;
    0) exit 0 ;;
    *) fcplcn_fail 'Выберите cloud (1) или hub (2).'; exit 2 ;;
esac

fcplcn_action=
if [ "$#" -gt 0 ]; then
    case "$1" in
        install|update|status|logs|backup|rollback|restore|doctor|plc|certificates)
            fcplcn_action=$1; shift ;;
        --*) ;;
        *) fcplcn_fail "Неизвестное действие: $1"; exit 2 ;;
    esac
fi
if [ -z "$fcplcn_action" ]; then
    if [ ! -t 0 ]; then
        printf '%s\n' 'Для выбора установки или обновления запустите ./install.sh в терминале.' >&2
        exit 2
    fi
    while :; do
        printf '\nFCPLCn — %s\n  1. Установка\n  2. Обновление\n  0. Выход\nВыберите действие: ' "$fcplcn_role"
        IFS= read -r fcplcn_choice || exit 0
        case "$fcplcn_choice" in
            1) fcplcn_action=install; break ;;
            2) fcplcn_action=update; break ;;
            0) exit 0 ;;
            *) printf '%s\n' 'Введите 1, 2 или 0.' ;;
        esac
    done
fi
fcplcn_dry_run=0
for fcplcn_argument in "$@"; do
    case "$fcplcn_argument" in --dry-run) fcplcn_dry_run=1 ;; esac
done

fcplcn_bootstrap "$fcplcn_role" "$fcplcn_action" "$fcplcn_dry_run"
if [ -z "${FCPLCN_PYTHON:-}" ]; then
    [ "$fcplcn_dry_run" = 1 ] && exit 0
    fcplcn_fail 'Требуется Python 3.10 или новее.'
    exit 1
fi
exec "$FCPLCN_PYTHON" "$fcplcn_source_dir/deploy/fcplcn.py" \
    "$fcplcn_role" "$fcplcn_action" "$@"
