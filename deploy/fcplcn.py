#!/usr/bin/env python3
"""FCPLCn installer lifecycle. Host dependencies are prepared by install.sh."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from lib.common import DeploymentError, Runner, default_state, deployment_lock
from lib.lifecycle import operate


def parser():
    command = argparse.ArgumentParser(description="Установка и обслуживание FCPLCn без удаления постоянных данных.")
    command.add_argument("role", choices=("cloud", "hub"))
    command.add_argument("action", choices=("install", "update", "status", "logs", "backup", "rollback", "restore", "doctor", "plc", "certificates"))
    command.add_argument("--dir", type=Path, help="Постоянный каталог установки вне исходников")
    command.add_argument("--repo", help="GitHub URL исходников; токены в URL не допускаются")
    command.add_argument("--ref", help="Ветка, тег или commit; по умолчанию main")
    command.add_argument("--domain", help="Публичный DNS домен cloud")
    command.add_argument("--project", help="Фиксированное имя Docker проекта")
    command.add_argument("--image", help="Готовый Docker образ приложения")
    command.add_argument("--source-build", action="store_true", help="Явно собрать приложение из исходников")
    command.add_argument("--http-port", type=int, help="Внешний HTTP порт; hub 3000, cloud 80")
    command.add_argument("--https-port", type=int, help="Внешний HTTPS порт cloud; по умолчанию 443")
    command.add_argument("--mqtt-port", type=int, help="Внешний MQTT порт; hub 1883, cloud 8883")
    command.add_argument("--backup", type=Path, help="Каталог полной копии для restore")
    command.add_argument("--plc-id", help="deviceId для явного создания MQTT учётной записи PLC")
    command.add_argument("--follow", action="store_true", help="Следить за журналом служб")
    command.add_argument("--yes", "--non-interactive", dest="yes", action="store_true", help="Явно подтвердить операцию без вопросов")
    command.add_argument("--dry-run", action="store_true", help="Показать действие без изменений и запуска Docker")
    return command


def main(arguments=None, runner=None):
    args = parser().parse_args(arguments)
    state = (args.dir or default_state(args.role)).expanduser().resolve()
    checkout = Path(__file__).resolve().parent.parent
    if args.dry_run:
        print(f"Проверка без изменений: FCPLCn {args.role}, действие {args.action}.")
        print(f"Постоянный каталог: {state}")
        print("Исходники, Docker, данные и настройки не изменены.")
        return 0
    # Keeping state inside the source would recursively copy data/secrets into a release.
    if state == checkout or checkout in state.parents:
        print("Ошибка: --dir должен находиться вне каталога исходников FCPLCn.", file=sys.stderr)
        return 1
    os.umask(0o077)
    runner = runner or Runner()
    try:
        if args.action in ("status", "logs", "doctor"):
            operate(args, runner, state, checkout)
        else:
            with deployment_lock(state):
                operate(args, runner, state, checkout)
        return 0
    except (DeploymentError, OSError, ValueError, KeyError) as error:
        # Subprocess output is intentionally excluded: it can include credentials.
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Операция прервана.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
