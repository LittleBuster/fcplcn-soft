#!/usr/bin/env bash
# Shared shell interface for FCPLCn installation, update and maintenance.
. "$fcplcn_source_dir/deploy/platform.sh"

fcplcn_wants_help() {
    local argument
    for argument in "$@"; do
        case "$argument" in --help|-h) return 0 ;; esac
    done
    return 1
}

fcplcn_cli_error() {
    printf 'FCPLCn: %s\n' "$*" >&2
    return 2
}

fcplcn_deployment_usage() {
    local action=$1
    cat <<HELP
FCPLCn — Future City PLC Next

Использование: ./$action.sh [cloud|hub] [ОПЦИИ]
Без аргументов: 1. cloud / 2. hub / 0. Выход.

  --repo URL --ref main  Версия исходников из GitHub.
  --dir PATH             Постоянный каталог установки.
  --image IMAGE          Явно указать образ приложения.
  --source-build         Собрать приложение из исходников.
  --yes                  Запуск без дополнительных вопросов.
  --dry-run              Показать план без изменений.
  --help                 Показать справку.
HELP
    if [ "$action" = install ]; then
        cat <<'HELP'
  --domain NAME          Публичный домен облака.
  --project NAME         Имя проекта Docker Compose.
  --http-port N          Внешний HTTP-порт.
  --https-port N         Внешний HTTPS-порт облака.
  --mqtt-port N          Внешний MQTT-порт.
HELP
    fi
    printf '\nОбслуживание: ./deploy/manage.sh --help\nДокументация: deploy/README.md\n'
}

fcplcn_deployment_command() {
    local action=$1 title=$2 role=${3:-}
    shift 2
    if fcplcn_wants_help "$@"; then
        fcplcn_deployment_usage "$action"
        return
    fi
    case "$role" in
        cloud|hub|1|2|0) shift ;;
        ''|--*) role= ;;
        *) fcplcn_cli_error 'Укажите cloud (1) или hub (2).'; return 2 ;;
    esac
    if [ -z "$role" ]; then
        if [ ! -t 0 ]; then
            fcplcn_cli_error "Для выбора компонента запустите ./$action.sh в терминале или укажите cloud / hub."
            return 2
        fi
        while :; do
            printf '\nFCPLCn — %s\n  1. cloud — облако / VPS\n  2. hub   — локальный хаб\n  0. Выход\nВыберите пункт: ' "$title"
            IFS= read -r role || return 0
            case "$role" in
                1|2|cloud|hub|0) break ;;
                *) printf '%s\n' 'Введите 1, 2 или 0.' ;;
            esac
        done
    fi
    case "$role" in
        1|cloud) role=cloud ;;
        2|hub) role=hub ;;
        0) return 0 ;;
    esac
    if [ "$action" = install ] && [ "${1:-}" = install ]; then
        shift
    fi
    case "${1:-}" in
        ''|--*) fcplcn_dispatch "$role" "$action" "$@" ;;
        update) fcplcn_cli_error "Для обновления используйте ./update.sh $role." ;;
        status|logs|backup|rollback|restore|doctor|plc|certificates)
            fcplcn_cli_error "Для обслуживания используйте ./deploy/manage.sh $role $1." ;;
        *) fcplcn_cli_error "Неизвестный аргумент: $1. Справка: ./$action.sh --help." ;;
    esac
}

fcplcn_dispatch() {
    local role=$1 action=$2 dry_run=0 argument
    shift 2
    for argument in "$@"; do
        case "$argument" in --dry-run) dry_run=1 ;; esac
    done
    fcplcn_bootstrap "$role" "$action" "$dry_run"
    if [ -z "${FCPLCN_PYTHON:-}" ]; then
        [ "$dry_run" = 1 ] && return 0
        fcplcn_fail 'Требуется Python 3.10 или новее.'
        return 1
    fi
    exec "$FCPLCN_PYTHON" "$fcplcn_source_dir/deploy/fcplcn.py" "$role" "$action" "$@"
}
