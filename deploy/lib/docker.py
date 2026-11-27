"""Docker/Compose operations with stable project identity and private settings."""
from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile

from .common import DeploymentError, atomic_json, docker_prefix, read_json
from .sources import default_image

HELPER_IMAGE = "alpine:3.23"
HUB_DATABASE_VOLUME = "hub-db-data"
HUB_DATABASE_CREDENTIALS = ("FCPLCN_HUB_DATABASE_PASSWORD", "FCPLCN_HUB_DATABASE_ADMIN_PASSWORD")


class Stack:
    """One immutable release attached to an installation's persistent volumes."""

    def __init__(self, runner, state, metadata, record):
        self.runner = runner
        self.state = Path(state)
        self.metadata = metadata
        self.record = record
        self.role = metadata["role"]
        if metadata["platform"] not in ("linux/amd64", "linux/arm64"):
            raise DeploymentError("FCPLCn поддерживает только 64-битные системы amd64 и arm64.")
        self.project = metadata["project"]
        self.release = self.state / "releases" / record["revision"]
        self.source = self.release / "source"
        self.prefix = docker_prefix()

    @property
    def uses_hub_database(self):
        """Recognize schema-bearing hub releases, including restored source snapshots."""
        return self.role == "hub" and (self.source / "hub/deploy/postgres-init.sh").is_file()

    @property
    def hub_database_env(self):
        return self.state / "runtime/hub-database.env"

    @property
    def hub_database_volume(self):
        return f"{self.project}_{HUB_DATABASE_VOLUME}"

    @property
    def hub_database_fence(self):
        return self.state / ".hub-database-dormant"

    def expected_volumes(self):
        if self.role == "cloud":
            names = ["private", "broker", "cloud", "database", "caddy-data", "caddy-config"]
        else:
            names = ["hub-data", "broker-data"]
            if self.uses_hub_database:
                names.append(HUB_DATABASE_VOLUME)
        return {f"{self.project}_{name}" for name in names}

    def environment(self, extra=None):
        environment = os.environ.copy()
        environment.update({
            "FCPLCN_PROJECT": self.project,
            "FCPLCN_DOMAIN": self.metadata.get("domain", ""),
            "FCPLCN_RUNTIME_DIR": str(self.state / "runtime/cloud"),
            "FCPLCN_HUB_BROKER_AUTH_DIR": str(self.state / "runtime/broker"),
            "FCPLCN_HUB_IMAGE": self.record.get("imageId", self.record["image"]),
            "FCPLCN_CLOUD_IMAGE": self.record.get("imageId", self.record["image"]),
        })
        ports = self.metadata.get("ports", {})
        if self.role == "hub":
            environment["FCPLCN_HUB_PORT"] = str(ports.get("http", 3000))
            environment["FCPLCN_MQTT_PORT"] = str(ports.get("mqtt", 1883))
            # Compose prefers the shell over --env-file. Keep stored DB credentials authoritative.
            for name in HUB_DATABASE_CREDENTIALS:
                environment.pop(name, None)
        else:
            environment["FCPLCN_CLOUD_HTTP_PORT"] = str(ports.get("http", 80))
            environment["FCPLCN_CLOUD_HTTPS_PORT"] = str(ports.get("https", 443))
            environment["FCPLCN_CLOUD_MQTT_PORT"] = str(ports.get("mqtt", 8883))
            if ports.get("https", 443) != 443:
                environment["FCPLCN_CLOUD_PUBLIC_ORIGIN"] = (
                    f"https://{self.metadata['domain']}:{ports['https']}"
                )
        if extra:
            environment.update(extra)
        return environment

    def command(self, arguments, *, override=True):
        environment = self.state / ("runtime/cloud/.env" if self.role == "cloud" else "runtime/hub.env")
        env_files = ["--env-file", str(environment)]
        if self.uses_hub_database:
            env_files += ["--env-file", str(self.hub_database_env)]
        files = ["-f", str(self.source / self.role / "deploy/compose.yaml")]
        if override:
            files += ["-f", str(self.release / "installer.compose.json")]
        return self.prefix + ["compose", "--project-name", self.project, *env_files, *files, *arguments]

    def compose(self, arguments, **kwargs):
        return self.runner.run(self.command(arguments), env=self.environment(kwargs.pop("extra", None)), **kwargs)

    def output(self, arguments, *, override=True):
        return self.runner.output(self.command(arguments, override=override), env=self.environment())

    def write_override(self):
        services = {name: {"image": image_id}
                    for name, image_id in self.record.get("serviceImages", {}).items()}
        services[self.role] = {"image": self.record.get("imageId", self.record["image"])}
        if self.role == "hub":
            services.setdefault("broker", {})["volumes"] = [
                f"{self.state / 'runtime/broker'}:/mosquitto/auth:ro",
            ]
            services["broker-setup"] = {"volumes": [
                f"{self.state / 'runtime/broker'}:/mosquitto/auth",
            ]}
        path = self.release / "installer.compose.json"
        value = {"services": services}
        if not path.exists() or read_json(path) != value:
            atomic_json(path, value)

    def initialize(self):
        runtime = self.state / "runtime"
        runtime.mkdir(mode=0o700, exist_ok=True)
        if self.role == "cloud":
            self.runner.run(["sh", self.source / "cloud/deploy/setup.sh", self.metadata["domain"]],
                            env=self.environment(), label="Подготовка закрытых данных облака")
        else:
            self.prepare_hub_environment()
            (runtime / "broker").mkdir(exist_ok=True)
            # Re-running this operation preserves all existing PLC accounts.
            self.compose(["run", "--rm", "--no-deps", "broker-setup", "hub"],
                         label="Подготовка MQTT учётной записи хаба")

    def prepare_hub_environment(self):
        runtime = self.state / "runtime"
        runtime.mkdir(mode=0o700, exist_ok=True)
        environment_file = runtime / "hub.env"
        if not environment_file.exists():
            descriptor = os.open(environment_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write("FCPLCN_HUB_MQTT_USERNAME=fcplcn-hub\n")
                stream.write("FCPLCN_HUB_MQTT_PASSWORD=" + secrets.token_hex(32) + "\n")
        self.prepare_hub_database()

    def prepare_hub_database(self):
        """Bootstrap a separate credential file once. Never edit the existing hub config."""
        if not self.uses_hub_database:
            return
        if self.hub_database_fence.exists() and self.volume_exists(self.hub_database_volume):
            raise DeploymentError(
                "Хаб восстановлен из копии до PostgreSQL, а более поздняя база сохранена отдельно. "
                "Восстановите копию с PostgreSQL или установите хаб в другой --project и --dir."
            )
        path = self.hub_database_env
        if path.is_symlink():
            raise DeploymentError("Файл паролей PostgreSQL хаба должен быть обычным файлом.")
        if path.exists():
            if not path.is_file() or path.stat().st_size > 1024 or path.stat().st_mode & 0o077:
                raise DeploymentError("Файл паролей PostgreSQL хаба должен быть закрыт правами 0600.")
            try:
                data = path.read_text(encoding="ascii")
            except (OSError, UnicodeError) as error:
                raise DeploymentError("Не удалось прочитать файл паролей PostgreSQL хаба.") from error
            if not re.fullmatch("".join(f"{key}=[0-9a-f]{{64}}\n" for key in HUB_DATABASE_CREDENTIALS), data):
                raise DeploymentError("Повреждён файл паролей PostgreSQL хаба. Восстановите его из копии.")
            return
        if self.volume_exists(self.hub_database_volume):
            raise DeploymentError("Найден PostgreSQL хаба без файла паролей. Восстановите согласованную копию.")
        path.parent.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".database-", dir=path.parent) as staged:
            new_path = Path(staged) / "passwords.env"
            descriptor = os.open(new_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="ascii") as stream:
                for key in HUB_DATABASE_CREDENTIALS:
                    stream.write(f"{key}={secrets.token_hex(32)}\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(new_path, path)

    def volume_exists(self, name):
        return self.runner.run(self.prefix + ["volume", "inspect", name], check=False).returncode == 0

    def prepare_image(self, *, image=None, source_build=False):
        local_tag = f"fcplcn-{self.role}:local-{self.record['content'][:24]}"
        selected = image or (local_tag if source_build else
                             default_image(self.role, self.record, self.metadata["platform"]))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,240}", selected):
            raise DeploymentError("Некорректное имя Docker образа.")
        self.record["image"] = selected
        local = selected.startswith(f"fcplcn-{self.role}:local-")
        if local and not source_build and os.environ.get("FCPLCN_LOW_MEMORY") == "1":
            raise DeploymentError(
                "Для этой машины мало памяти для автоматической сборки. Укажите --repo с опубликованным "
                "GitHub образом или готовый --image. Принудительная сборка: --source-build."
            )
        exact_local = bool(image and re.fullmatch(r"sha256:[a-f0-9]{64}", image))
        if source_build or local:
            print("Собираем образ из исходников; настройки работающей установки сохраняются.")
            self.runner.run(self.prefix + ["build", "--platform", self.metadata["platform"],
                            "--build-arg", "FCPLCN_NODE_RUNTIME_IMAGE=node:24.22.3-bookworm-slim", "-t", selected,
                            "-f", self.source / self.role / "deploy/Dockerfile", self.source],
                            label="Сборка образа FCPLCn")
        elif not exact_local:
            self.runner.run(self.prefix + ["pull", "--platform", self.metadata["platform"], selected],
                            label="Загрузка готового образа FCPLCn")
        self.record["imageId"] = self.image_id(selected)
        return selected

    def image_id(self, image):
        image_id = self.runner.output(self.prefix + ["image", "inspect", "--format", "{{.Id}}", image])
        if not image_id.startswith("sha256:"):
            raise DeploymentError("Docker не вернул идентификатор образа.")
        return image_id

    def resolved_config(self, *, override=True):
        try:
            return json.loads(self.output(["config", "--format", "json"], override=override))
        except ValueError as error:
            raise DeploymentError("Не удалось прочитать конфигурацию Docker Compose.") from error

    def service_images(self, config):
        """Read image references for the long-running Compose services."""
        services = {name: value.get("image") for name, value in config.get("services", {}).items()
                    if not value.get("profiles")}
        if self.role not in services or not all(services.values()):
            raise DeploymentError("В Compose отсутствуют образы рабочих служб FCPLCn.")
        services.pop(self.role)
        return services

    def current_service_ids(self, config):
        """Record what legacy installations were actually running before moving tags."""
        pinned = self.record.get("serviceImages", {})
        found = {}
        for service, image in self.service_images(config).items():
            if service in pinned:
                found[service] = pinned[service]
                continue
            containers = self.output(["ps", "--all", "--quiet", service]).splitlines()
            if not containers:
                found[service] = self.image_id(image)
                continue
            images = self.runner.output(self.prefix + ["container", "inspect", "--format",
                                        "{{.Image}}", *containers]).splitlines()
            if len(set(images)) != 1 or not images[0].startswith("sha256:"):
                raise DeploymentError(f"Не удалось зафиксировать текущий образ службы {service}.")
            found[service] = images[0]
        return found

    def pull_services(self, config):
        images = {}
        for service, image in self.service_images(config).items():
            self.runner.run(self.prefix + ["pull", "--platform", self.metadata["platform"], image],
                            label=f"Загрузка образа службы {service}")
            images[service] = self.image_id(image)
        self.record["serviceImages"] = images
        return images

    def postgres_identity(self, config, image_id):
        """Match the PostgreSQL major version and actual data directory across upgrades."""
        environment = self.runner.output(self.prefix + ["image", "inspect", "--format",
                                                        "{{json .Config.Env}}", image_id])
        try:
            values = dict(value.split("=", 1) for value in json.loads(environment))
            data = config["services"]["db"].get("environment", {}).get("PGDATA", values.get("PGDATA"))
            if not values["PG_MAJOR"].isdigit() or not isinstance(data, str) or not data.startswith("/"):
                raise ValueError
            return values["PG_MAJOR"], data
        except (ValueError, TypeError, KeyError) as error:
            raise DeploymentError("Не удалось проверить версию или каталог данных PostgreSQL.") from error

    def persistent_mounts(self, config):
        names = self.volume_names(config)
        mounts = set()
        runtime = self.state / "runtime"
        for service, definition in config.get("services", {}).items():
            if definition.get("profiles"):
                continue
            for mount in definition.get("volumes", []):
                source = mount.get("source")
                if mount["type"] == "volume" and source in names:
                    mounts.add((service, names[source], mount["target"]))
                elif mount["type"] == "bind" and source and Path(source).is_relative_to(runtime):
                    mounts.add((service, source, mount["target"]))
        return mounts

    def pin_release(self):
        # Source revisions and runnable releases are separate: mutable image tags
        # can never rewrite a previous deployment's rollback record.
        pins = self.record["imageId"]
        if self.record.get("serviceImages"):
            pins = json.dumps(self.image_ids(), sort_keys=True)
        fingerprint = hashlib.sha256(pins.encode()).hexdigest()[:16]
        revision = self.record["revision"] + "-img-" + fingerprint
        release = self.state / "releases" / revision
        if not (release / "source").exists():
            with tempfile.TemporaryDirectory(prefix=".release-", dir=release.parent) as staged:
                snapshot = Path(staged) / "release"
                shutil.copytree(self.source, snapshot / "source")
                os.replace(snapshot, release)
        self.record["sourceRevision"] = self.record["revision"]
        self.record["revision"] = revision
        self.release, self.source = release, release / "source"
        if (release / "release.json").exists():
            saved = read_json(release / "release.json")
            if (saved.get("imageId") != self.record["imageId"]
                    or saved.get("serviceImages", {}) != self.record.get("serviceImages", {})):
                raise DeploymentError("Не совпадает идентификатор неизменяемого релиза.")
            self.record.update(saved)
        self.write_override()

    def image_ids(self):
        return {self.role: self.record["imageId"], **self.record.get("serviceImages", {})}

    def volume_names(self, config):
        return {key: value.get("name", f"{self.project}_{key}")
                for key, value in config.get("volumes", {}).items()}

    def volumes(self):
        try:
            return sorted(set(self.volume_names(self.resolved_config()).values()))
        except AttributeError as error:
            raise DeploymentError("Не удалось определить постоянные Docker volumes.") from error

    def running(self):
        return bool(self.output(["ps", "--services", "--status", "running"]))

    def stop(self):
        self.compose(["stop", "--timeout", "60"], label="Остановка служб для согласованной копии")

    def start(self):
        pull = ["--pull", "never"] if self.record.get("serviceImages") else []
        self.compose(["up", "--detach", "--no-build", *pull, "--wait", "--wait-timeout", "180"],
                     label="Запуск и проверка готовности FCPLCn")

    def prepare_archive_helper(self):
        available = self.runner.run(self.prefix + ["image", "inspect", HELPER_IMAGE], check=False)
        if available.returncode:
            self.runner.run(self.prefix + ["pull", "--platform", self.metadata["platform"], HELPER_IMAGE],
                            label="Загрузка образа для резервного копирования")

    def archive(self, mount, target):
        with Path(target).open("wb") as stream:
            os.chmod(target, 0o600)
            self.runner.run(self.prefix + ["run", "--rm", "--network", "none", "--user", "0:0",
                            "-v", mount + ":/data:ro", HELPER_IMAGE, "tar", "-czpf", "-", "-C", "/data", "."],
                            stdout=stream, label="Сохранение постоянных данных")

    def archive_image(self, target):
        with Path(target).open("wb") as stream:
            os.chmod(target, 0o600)
            images = list(dict.fromkeys(self.image_ids().values()))
            self.runner.run(self.prefix + ["image", "save", *images],
                            stdout=stream, label="Сохранение точных образов")

    def restore_archive(self, mount, archive):
        with Path(archive).open("rb") as stream:
            self.runner.run(self.prefix + ["run", "--rm", "--interactive", "--network", "none",
                            "--user", "0:0", "-v", mount + ":/data", HELPER_IMAGE, "sh", "-ec",
                            "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzpf - -C /data"],
                            stdin=stream, label="Восстановление постоянных данных")


def installed_stack(runner, state):
    metadata = read_json(Path(state) / "metadata.json")
    current = Path(state) / "current/release.json"
    if not current.is_file():
        raise DeploymentError("Работающая установка ещё не создана. Сначала запустите ./install.sh.")
    return Stack(runner, state, metadata, read_json(current))
