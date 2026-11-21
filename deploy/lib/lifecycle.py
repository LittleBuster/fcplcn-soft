"""Installation, reviewed GitHub updates, code rollback and operator commands."""
from __future__ import annotations

import copy
import os
from pathlib import Path
import re
import sys

from .backups import make_backup, restore_backup
from .common import DeploymentError, atomic_json, docker_prefix, host_platform, point_release, read_json
from .docker import Stack, installed_stack
from .sources import prepare_source


def confirm(question, yes=False):
    if yes:
        return
    if not sys.stdin.isatty():
        raise DeploymentError("Для этой операции требуется явное --yes или запуск в терминале.")
    if input(question + " [да/нет]: ").strip().lower() not in ("да", "yes", "y"):
        raise DeploymentError("Операция отменена.")


def initial_metadata(args, architecture):
    if architecture not in ("linux/amd64", "linux/arm64"):
        raise DeploymentError("Для FCPLCn нужна 64-битная система amd64 или arm64.")
    project = args.project or ("fcplcn" if args.role == "hub" else "fcplcn-cloud")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", project):
        raise DeploymentError("Имя Docker проекта: 1–40 строчных латинских букв, цифр, '_' или '-'.")
    domain = args.domain
    if args.role == "cloud" and not domain and sys.stdin.isatty() and not args.yes:
        domain = input("Домен облака (например cloud.example.com): ").strip()
    if args.role == "cloud" and not domain:
        raise DeploymentError("Для облака укажите --domain cloud.example.com.")
    if domain and (len(domain) > 253 or not re.fullmatch(
            r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", domain)):
        raise DeploymentError("Укажите DNS имя без протокола, порта и пути.")
    return {"version": 1, "role": args.role, "project": project, "platform": architecture,
            "domain": (domain or "").lower(), "ports": selected_ports(args)}


def selected_ports(args, previous=None):
    ports = dict(previous or {})
    for name, default in (("http", 3000 if args.role == "hub" else 80),
                          ("https", 443), ("mqtt", 1883 if args.role == "hub" else 8883)):
        value = getattr(args, name + "_port", None)
        ports[name] = value if value is not None else ports.get(name, default)
        if not 1 <= ports[name] <= 65535:
            raise DeploymentError("Порт должен находиться в диапазоне 1–65535.")
    return ports


def validate_identity(args, metadata):
    if metadata["role"] != args.role:
        raise DeploymentError("Каталог принадлежит другому типу установки FCPLCn.")
    if args.project and args.project != metadata["project"]:
        raise DeploymentError("Имя проекта существующей установки менять нельзя.")
    if args.domain and args.domain.lower() != metadata.get("domain", ""):
        raise DeploymentError("Домен существующего облака менять этой командой нельзя.")
    if metadata["platform"] != host_platform():
        raise DeploymentError("Архитектура установки отличается от текущей машины.")


def publish(stack, previous=None):
    atomic_json(stack.release / "release.json", stack.record)
    if previous and previous.release != stack.release:
        point_release(stack.state, "previous", previous.release)
    atomic_json(stack.state / "metadata.json", stack.metadata)
    point_release(stack.state, "current", stack.release)


def deploy(args, runner, state, checkout):
    path = state / "metadata.json"
    existing_metadata = read_json(path) if path.exists() else None
    old = installed_stack(runner, state) if (state / "current/release.json").is_file() else None
    if existing_metadata:
        validate_identity(args, existing_metadata)
    if args.action == "update" and not old:
        raise DeploymentError("Сначала выполните install.")
    if args.action == "install" and old:
        print("FCPLCn уже установлен. Настройки сохранены; новые изменения применяет команда update.")
        old.start()
        return
    metadata = copy.deepcopy(existing_metadata or initial_metadata(args, host_platform()))
    metadata["ports"] = selected_ports(args, metadata.get("ports"))
    if not existing_metadata:
        prefix = docker_prefix()
        suffixes = (["hub-data", "broker-data"] if args.role == "hub" else
                    ["private", "broker", "cloud", "database", "caddy-data", "caddy-config"])
        for suffix in suffixes:
            result = runner.run(prefix + ["volume", "inspect", metadata["project"] + "_" + suffix], check=False)
            if result.returncode == 0:
                raise DeploymentError("Найдены данные прежней неуправляемой установки. Сохраните их и выберите другой --project; автоматическая замена отменена.")
    remote = args.repo or (old.record.get("repo") if old else None)
    if args.action == "update" and not remote:
        raise DeploymentError("Для обновления укажите --repo https://github.com/owner/repository.git.")
    record = prepare_source(runner, state, checkout, role=args.role, repo=remote,
                            ref=args.ref or (old.record.get("ref", "main") if old else "main"),
                            fetch=args.action == "update" or bool(args.repo))
    if (old and record["content"] == old.record["content"] and not args.image
            and not args.source_build and metadata.get("ports") == old.metadata.get("ports")):
        print("Уже установлена эта версия FCPLCn. Данные и службы не изменены.")
        return
    candidate = Stack(runner, state, metadata, record)
    # All downloads/builds finish before interrupting a running installation.
    candidate.prepare_image(image=args.image, source_build=args.source_build)
    if not existing_metadata:
        # A failed first start can be retried without mistaking our volumes for foreign data.
        atomic_json(state / "metadata.json", metadata)
    candidate.initialize() if not old else None
    backup = make_backup(old, restart=False) if old else None
    try:
        if old:
            # Regenerate hub ACL safely / renew cloud leaf certificates after backup.
            candidate.initialize()
        candidate.start()
    except BaseException:
        try:
            candidate.stop()
        except DeploymentError:
            print("Не все службы удалось остановить; проверьте status перед повторным запуском.")
        if old:
            if record["schema"] == old.record["schema"]:
                old.start()
                print("Новая версия не запустилась; прежняя версия кода снова работает.")
            else:
                print("Миграция могла изменить БД. Службы остановлены; автоматического отката БД нет.")
                print(f"Для полного восстановления используйте restore --backup '{backup}'.")
        raise
    publish(candidate, old)
    print(f"FCPLCn {args.role} запущен. Версия: {record['revision']}.")
    ports = metadata["ports"]
    address = (f"http://<IP этого компьютера>:{ports['http']}" if args.role == "hub" else
               f"https://{metadata['domain']}" + (f":{ports['https']}" if ports['https'] != 443 else ""))
    print("Веб-интерфейс: " + address)
    if not old:
        print("Первый вход: admin, пароль пустой. Изменить учётную запись можно в веб-интерфейсе.")


def rollback(args, runner, state):
    old = installed_stack(runner, state)
    previous = state / "previous/release.json"
    if not previous.is_file():
        raise DeploymentError("Предыдущего успешно установленного релиза пока нет.")
    record = read_json(previous)
    if record["schema"] != old.record["schema"]:
        raise DeploymentError("Изменилась схема БД. Используйте restore --backup с согласованной копией.")
    confirm("Вернуть предыдущую версию кода, сохранив текущие данные?", args.yes)
    target = Stack(runner, state, old.metadata, record)
    backup = make_backup(old, restart=False)
    try:
        target.start()
    except BaseException:
        old.start()
        raise
    publish(target, old)
    print(f"Возвращена предыдущая версия кода. Данные сохранены; копия: {backup}")


def provision_plc(args, stack):
    if args.role != "hub":
        raise DeploymentError("Учётные записи PLC добавляются только на локальном хабе.")
    identifier = args.plc_id
    if not identifier and sys.stdin.isatty() and not args.yes:
        identifier = input("deviceId контроллера: ").strip()
    if not identifier or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identifier):
        raise DeploymentError("Укажите --plc-id с deviceId контроллера (латиница, цифры, '_' или '-').")
    import secrets
    password = secrets.token_urlsafe(24)
    stack.compose(["run", "--rm", "--no-deps", "broker-setup", "plc"],
                  extra={"FCPLCN_PLC_ID": identifier, "FCPLCN_PLC_PASSWORD": password},
                  label="Добавление отдельной учётной записи PLC")
    stack.compose(["restart", "broker"], label="Применение MQTT учётной записи")
    print(f"MQTT логин PLC: {identifier}\nMQTT пароль PLC: {password}")
    print("Пароль показан только по явной команде plc; сохраните его в настройках контроллера.")


def renew_certificates(stack):
    """Renew an expiring cloud leaf certificate with a recoverable cold snapshot."""
    backup = make_backup(stack, restart=False)
    try:
        stack.initialize()
        stack.start()
    except BaseException:
        try:
            stack.start()
        except DeploymentError:
            print("Не удалось запустить все службы; проверьте status и сохранённую резервную копию.")
        raise
    print("Сертификаты облачного MQTT проверены; при приближении срока выполнено продление.")
    print(f"Резервная копия перед проверкой: {backup}")


def operate(args, runner, state, checkout):
    if args.action == "certificates" and args.role != "cloud":
        raise DeploymentError("Команда certificates предназначена только для облака FCPLCn.")
    if args.action in ("install", "update"):
        return deploy(args, runner, state, checkout)
    if args.action == "doctor":
        prefix = docker_prefix()
        print("Архитектура контейнеров: " + host_platform())
        runner.run(prefix + ["info"], label="Проверка доступности Docker")
        print("Docker доступен. " + runner.output(prefix + ["compose", "version"]))
        print("Каталог установки: " + str(state))
        return
    if args.action == "restore":
        if not args.backup:
            raise DeploymentError("Укажите каталог полной копии: restore --backup /path/to/backup.")
        current = installed_stack(runner, state) if (state / "current/release.json").is_file() else None
        if current:
            metadata = current.metadata
        else:
            saved = read_json(args.backup.expanduser().resolve() / "manifest.json")
            metadata = saved.get("metadata", {})
            expected = args.project or ("fcplcn" if args.role == "hub" else "fcplcn-cloud")
            if metadata.get("project") != expected:
                raise DeploymentError("Имя проекта копии отличается; укажите соответствующий --project.")
        validate_identity(args, metadata)
        target = restore_backup(runner, state, metadata, args.backup, current=current,
                                confirm=lambda question: confirm(question, args.yes))
        publish(target, current)
        print("FCPLCn восстановлен из полной резервной копии.")
        return
    stack = installed_stack(runner, state)
    validate_identity(args, stack.metadata)
    if args.action == "status":
        print(f"FCPLCn {args.role}; проект {stack.project}; версия {stack.record['revision']}")
        stack.compose(["ps"], capture=False, label="Состояние служб")
    elif args.action == "logs":
        stack.compose(["logs", "--tail", "100"] + (["--follow"] if args.follow else []),
                      capture=False, label="Журнал служб")
    elif args.action == "backup":
        make_backup(stack)
    elif args.action == "rollback":
        rollback(args, runner, state)
    elif args.action == "plc":
        provision_plc(args, stack)
    elif args.action == "certificates":
        renew_certificates(stack)
