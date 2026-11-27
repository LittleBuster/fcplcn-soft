#!/usr/bin/env bash
# FCPLCn maintenance commands for configured installations.
set -euo pipefail
umask 077

fcplcn_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$fcplcn_source_dir/deploy/entrypoint.sh"

if fcplcn_wants_help "$@"; then
    cat <<'HELP'
FCPLCn — обслуживание

Использование: ./deploy/manage.sh [cloud|hub] ДЕЙСТВИЕ [ОПЦИИ]

  status        Показать версию и состояние контейнеров.
  logs          Показать журнал контейнеров. --follow следит за журналом.
  backup        Создать согласованную резервную копию.
  rollback      Запустить предыдущий релиз с текущими данными.
  restore       Восстановить копию из каталога --backup PATH.
  doctor        Проверить платформу и Docker.
  certificates  Продлить сертификат MQTT облака при необходимости.
  plc           Создать учётную запись MQTT хаба для --plc-id ID.

  --dir PATH    Каталог существующей установки.
  --yes         Подтвердить действие без дополнительных вопросов.
  --dry-run     Показать план без изменений.

Документация: deploy/README.md
HELP
    exit 0
fi

fcplcn_role=${1:-}
fcplcn_action=${2:-}
case "$fcplcn_role" in
    cloud|hub) ;;
    *) fcplcn_cli_error 'Укажите cloud или hub. Справка: ./deploy/manage.sh --help.' ;;
esac
case "$fcplcn_action" in
    status|logs|backup|rollback|restore|doctor|certificates|plc) ;;
    *) fcplcn_cli_error 'Укажите действие. Справка: ./deploy/manage.sh --help.' ;;
esac
shift 2
fcplcn_dispatch "$fcplcn_role" "$fcplcn_action" "$@"
