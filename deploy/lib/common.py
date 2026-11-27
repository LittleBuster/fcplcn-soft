"""Process execution, private state files and single-writer deployment locks."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time


class DeploymentError(RuntimeError):
    """An actionable error that does not disclose secret process output."""


DOCKER_ENVIRONMENT = (
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    "FCPLCN_PROJECT", "FCPLCN_DOMAIN", "FCPLCN_RUNTIME_DIR",
    "FCPLCN_CLOUD_HTTP_PORT", "FCPLCN_CLOUD_HTTPS_PORT", "FCPLCN_CLOUD_MQTT_PORT",
    "FCPLCN_CLOUD_PUBLIC_ORIGIN", "FCPLCN_CLOUD_IMAGE",
    "FCPLCN_HUB_DATABASE_PASSWORD", "FCPLCN_HUB_DATABASE_ADMIN_PASSWORD",
    "FCPLCN_HUB_BIND", "FCPLCN_HUB_BROKER_AUTH_DIR", "FCPLCN_HUB_IMAGE",
    "FCPLCN_HUB_MQTT_PASSWORD", "FCPLCN_HUB_MQTT_USERNAME", "FCPLCN_HUB_PASSWORD",
    "FCPLCN_HUB_PORT", "FCPLCN_MQTT_BIND", "FCPLCN_MQTT_PORT",
    "FCPLCN_NODE_RUNTIME_IMAGE", "FCPLCN_PLC_ID", "FCPLCN_PLC_PASSWORD",
)


def docker_prefix():
    """Preserve only named Docker/Compose inputs; secret values stay out of argv."""
    if os.environ.get("FCPLCN_DOCKER_SUDO") == "1":
        return ["sudo", "--preserve-env=" + ",".join(DOCKER_ENVIRONMENT), "docker"]
    return ["docker"]


class Runner:
    """Execute argument arrays; callers must supply a harmless operation label."""

    def run(self, arguments, *, label="Выполнение команды", env=None, stdout=None,
            stdin=None, capture=True, check=True):
        try:
            result = subprocess.run(
                [str(arg) for arg in arguments], env=env, stdin=stdin,
                stdout=stdout if stdout is not None else (subprocess.PIPE if capture else None),
                stderr=subprocess.PIPE if capture else None, check=False,
            )
        except OSError as error:
            raise DeploymentError(f"{label}: не удалось запустить программу ({error.strerror}).") from error
        if check and result.returncode:
            raise DeploymentError(f"{label}: команда завершилась с кодом {result.returncode}.")
        return result

    def output(self, arguments, **kwargs):
        result = self.run(arguments, **kwargs)
        return (result.stdout or b"").decode("utf-8", errors="replace").strip()


def atomic_json(path, value):
    """Commit one private JSON file without exposing partially written state."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DeploymentError(f"Не удалось прочитать файл состояния {Path(path).name}.") from error


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_state(role):
    if platform.system() == "Darwin":
        return Path.home() / "Library/Application Support/FCPLCn" / role
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return Path("/opt/fcplcn") / role
    return Path.home() / ".local/share/fcplcn" / role


def host_platform():
    explicit = os.environ.get("FCPLCN_PLATFORM")
    if explicit:
        if explicit not in ("linux/amd64", "linux/arm64"):
            raise DeploymentError("Поддерживаются только 64-битные архитектуры linux/amd64 и linux/arm64.")
        return explicit
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "linux/arm64"
    if machine in ("x86_64", "amd64"):
        return "linux/amd64"
    raise DeploymentError(f"Архитектура {machine} пока не поддерживается.")


@contextlib.contextmanager
def deployment_lock(state):
    """Use an atomic directory lock and remove an abandoned local PID lock."""
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = state / ".deployment-lock"
    for attempt in range(2):
        try:
            lock.mkdir(mode=0o700)
            atomic_json(lock / "owner.json", {"pid": os.getpid(), "created": time.time()})
            break
        except FileExistsError:
            try:
                owner = read_json(lock / "owner.json")
                pid = int(owner["pid"])
                if pid <= 0:
                    raise ValueError("invalid pid")
                os.kill(pid, 0)
            except ProcessLookupError:
                (lock / "owner.json").unlink(missing_ok=True)
                try:
                    lock.rmdir()
                except OSError:
                    pass
                continue
            except (DeploymentError, KeyError, ValueError, PermissionError):
                pass
            raise DeploymentError("Другая операция FCPLCn уже выполняется. Проверьте каталог блокировки.")
    else:
        raise DeploymentError("Не удалось получить блокировку установки.")
    try:
        yield
    finally:
        (lock / "owner.json").unlink(missing_ok=True)
        lock.rmdir()


def point_release(state, name, release):
    """Atomically publish a relative link, also on macOS with Unicode paths."""
    state = Path(state)
    temporary = state / ("." + name + "-next")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(os.path.relpath(release, state), target_is_directory=True)
    os.replace(temporary, state / name)
