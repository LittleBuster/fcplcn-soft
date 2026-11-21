"""Consistent cold backups and explicit, validated full-state restoration."""
from __future__ import annotations

import datetime
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

from .common import DeploymentError, atomic_json, read_json, sha256_file
from .docker import Stack


def validate_archive(path):
    """Reject path traversal and escaping links before stopping any service."""
    try:
        with tarfile.open(path, "r:*") as archive:
            for member in archive:
                name = PurePosixPath(member.name)
                if name.is_absolute() or ".." in name.parts or member.isdev() or member.isfifo():
                    raise DeploymentError("Резервная копия содержит недопустимые пути или устройства.")
                if member.issym() or member.islnk():
                    link = PurePosixPath(member.linkname)
                    if link.is_absolute() or ".." in link.parts:
                        raise DeploymentError("Резервная копия содержит ссылку за пределы каталога.")
    except (tarfile.TarError, OSError) as error:
        raise DeploymentError("Архив резервной копии повреждён или недоступен.") from error


def make_backup(stack, *, restart=True):
    """Stop the full stack, archive all volumes, and recover on backup errors."""
    root = stack.state / "backups"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    temporary = Path(tempfile.mkdtemp(prefix=".backup-", dir=root))
    volumes = stack.volumes()
    if not volumes:
        shutil.rmtree(temporary)
        raise DeploymentError("Не найдены постоянные volumes; создание пустой копии отменено.")
    was_running = stack.running()
    stopped = False
    completed = False
    try:
        # Preserve the exact locally built image, including when no registry exists.
        stack.archive_image(temporary / "application-image.tar")
        # Stop even when Compose reports a partially started stack.
        stopped = True
        stack.stop()
        manifest = {"version": 1, "created": stamp, "role": stack.role,
                    "project": stack.project, "metadata": stack.metadata,
                    "release": stack.record, "archives": {}, "volumes": {}}
        for index, volume in enumerate(volumes):
            stack.runner.run(stack.prefix + ["volume", "inspect", volume],
                             label="Проверка постоянного volume")
            filename = f"volume-{index:02}.tar.gz"
            stack.archive(volume, temporary / filename)
            manifest["volumes"][volume] = filename
        stack.archive(str(stack.state / "runtime"), temporary / "runtime.tar.gz")
        stack.archive(str(stack.source), temporary / "source.tar.gz")
        for archive in temporary.iterdir():
            manifest["archives"][archive.name] = sha256_file(archive)
        atomic_json(temporary / "manifest.json", manifest)
        destination = root / (stamp + "-" + stack.record["revision"][:20])
        if destination.exists():
            destination = root / (destination.name + "-" + temporary.name[-6:])
        os.replace(temporary, destination)
        completed = True
        print(f"Резервная копия сохранена: {destination}")
        return destination
    finally:
        if stopped and was_running and (restart or not completed):
            stack.start()
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)


def load_backup(path, *, role, project):
    path = Path(path).expanduser().resolve()
    manifest = read_json(path / "manifest.json")
    if manifest.get("version") != 1 or manifest.get("role") != role or manifest.get("project") != project:
        raise DeploymentError("Копия принадлежит другому типу установки или Docker проекту.")
    files = manifest.get("archives", {})
    volumes = manifest.get("volumes", {})
    if not files or not volumes or not {"runtime.tar.gz", "source.tar.gz", "application-image.tar"}.issubset(files):
        raise DeploymentError("Копия неполная: нужны исходники, настройки и все volumes.")
    if not all(name in files for name in volumes.values()):
        raise DeploymentError("В копии отсутствуют архивы постоянных volumes.")
    for name, digest in files.items():
        if Path(name).name != name or not name.endswith((".tar.gz", ".tar")):
            raise DeploymentError("Некорректный список файлов резервной копии.")
        archive = path / name
        if archive.is_symlink() or sha256_file(archive) != digest:
            raise DeploymentError("Контрольная сумма резервной копии не совпала.")
        validate_archive(archive)
    return path, manifest


def extract_source(archive, destination):
    """Source snapshots contain plain files and directories, never symlinks."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                os.chmod(target, member.mode & 0o777)
            else:
                raise DeploymentError("Архив исходников содержит недопустимую ссылку.")


def restore_backup(runner, state, metadata, backup, *, current=None, confirm=None):
    """Restore a matching installation without deleting Docker volumes."""
    directory, manifest = load_backup(backup, role=metadata["role"], project=metadata["project"])
    record = manifest["release"]
    revision = record.get("revision", "")
    if not revision or Path(revision).name != revision or revision in (".", ".."):
        raise DeploymentError("В копии некорректный идентификатор релиза.")
    if manifest["metadata"].get("platform") != metadata.get("platform"):
        raise DeploymentError("Физическую копию базы можно восстановить только на той же архитектуре.")
    if confirm:
        confirm("Текущие данные будут заменены полной резервной копией. Продолжить?")
    release = Path(state) / "releases" / revision
    if not (release / "source").exists():
        extract_source(directory / "source.tar.gz", release / "source")
    target_metadata = dict(manifest["metadata"])
    target = Stack(runner, state, target_metadata, record)
    target.write_override()
    expected_image = record.get("imageId")
    if not expected_image or not expected_image.startswith("sha256:"):
        raise DeploymentError("Копия не содержит точный идентификатор Docker образа.")
    available = runner.run(target.prefix + ["image", "inspect", "--format", "{{.Id}}", expected_image], check=False)
    if available.returncode:
        with (directory / "application-image.tar").open("rb") as stream:
            runner.run(target.prefix + ["image", "load"], stdin=stream,
                       label="Загрузка точного образа из резервной копии")
        actual = runner.output(target.prefix + ["image", "inspect", "--format", "{{.Id}}", expected_image])
    else:
        actual = (available.stdout or b"").decode().strip()
    if actual != expected_image:
        raise DeploymentError("Тег Docker образа изменился. Нужен прежний образ с идентификатором из копии.")
    # Resolve expected volume names without modifying either the live data or its env.
    expected = {f"{target.project}_{suffix}" for suffix in
                (["hub-data", "broker-data"] if target.role == "hub" else
                 ["private", "broker", "cloud", "database", "caddy-data", "caddy-config"])}
    if set(manifest["volumes"]) != expected:
        raise DeploymentError("Список volumes копии не совпадает с установленным проектом.")
    if current:
        safety = make_backup(current, restart=False)
        print(f"Перед восстановлением сохранены текущие данные: {safety}")
    else:
        # Do not overwrite an existing unknown installation that lacks metadata/current.
        for volume in expected:
            found = runner.run(target.prefix + ["volume", "inspect", volume], check=False)
            if found.returncode == 0:
                raise DeploymentError("Найден существующий volume без управляемой установки. Автозамена отменена.")
    try:
        runtime = Path(state) / "runtime"
        runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.restore_archive(str(runtime), directory / "runtime.tar.gz")
        for volume, filename in manifest["volumes"].items():
            runner.run(target.prefix + ["volume", "create", volume], label="Подготовка volume для восстановления")
            target.restore_archive(volume, directory / filename)
        atomic_json(release / "release.json", record)
        atomic_json(Path(state) / "metadata.json", target_metadata)
        target.start()
        return target
    except BaseException:
        try:
            target.stop()
        except DeploymentError:
            print("Не удалось остановить все службы; проверьте status перед продолжением восстановления.")
        print("Восстановление прервано; используйте сохранённую копию для восстановления.")
        raise
