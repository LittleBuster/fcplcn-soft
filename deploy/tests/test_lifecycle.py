"""Lifecycle regression tests: no Docker daemon or host changes are required."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEPLOY))
from lib.backups import load_backup, make_backup, restore_backup, validate_archive
from lib.common import DOCKER_ENVIRONMENT, DeploymentError, atomic_json, deployment_lock, docker_prefix, host_platform, point_release, read_json
from lib.docker import HUB_DATABASE_CREDENTIALS, Stack
from lib.lifecycle import deploy, initial_metadata, operate, renew_certificates, rollback, validate_identity
from lib.sources import default_image, github_repository, prepare_source, schema_digest, tree_digest

spec = importlib.util.spec_from_file_location("fcplcn_cli", DEPLOY / "fcplcn.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.config = {"volumes": {"hub-data": {"name": "test_hub-data"},
                                   "broker-data": {"name": "test_broker-data"}},
                       "services": {"hub": {"image": "fcplcn-hub:test"},
                                    "broker": {"image": "mosquitto:test"},
                                    "broker-setup": {"image": "mosquitto:test", "profiles": ["setup"]}}}
        self.proposed_config = None
        self.image_ids = {"mosquitto:test": "sha256:previous-mosquitto"}
        self.per_pull = {}
        self.postgres_env = {}
        self.fail = None

    def run(self, arguments, **kwargs):
        arguments = [str(value) for value in arguments]
        self.calls.append((arguments, kwargs))
        if self.fail and self.fail(arguments):
            raise DeploymentError("Имитированная ошибка команды")
        if "config" in arguments:
            current = any(argument.endswith("installer.compose.json") for argument in arguments)
            config = self.config if current or self.proposed_config is None else self.proposed_config
            output = json.dumps(config).encode()
        elif "pull" in arguments:
            image = arguments[-1]
            if image in self.per_pull:
                self.image_ids[image] = self.per_pull[image]
            output = b""
        elif "--status" in arguments:
            output = b"hub\nbroker\n"
        elif "container" in arguments and "inspect" in arguments:
            output = b"sha256:previous-mosquitto\n"
        elif "image" in arguments and "inspect" in arguments:
            if "--format" not in arguments:
                return subprocess.CompletedProcess(arguments, 0, b"[]", b"")
            index = arguments.index("--format")
            if arguments[index + 1] == "{{json .Config.Env}}":
                output = json.dumps(self.postgres_env.get(arguments[-1], [
                    "PG_MAJOR=18", "PGDATA=/var/lib/postgresql/18/docker",
                ])).encode()
            else:
                output = "\n".join(self.image_ids.get(
                    image, image if image.startswith("sha256:") else "sha256:verified-image"
                ) for image in arguments[index + 2:]).encode()
        else:
            output = b""
        if kwargs.get("stdout"):
            with tarfile.open(fileobj=kwargs["stdout"], mode="w:gz") as archive:
                item = tarfile.TarInfo("state.json")
                item.size = 2
                archive.addfile(item, io.BytesIO(b"{}"))
        code = 0
        if "volume" in arguments and "inspect" in arguments and arguments[-1] not in {
                value["name"] for value in self.config["volumes"].values()}:
            code = 1
        return subprocess.CompletedProcess(arguments, code, output, b"")

    def output(self, arguments, **kwargs):
        return self.run(arguments, **kwargs).stdout.decode().strip()


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcplcn lifecycle ")
        self.root = Path(self.temporary.name).resolve()
        self.state = self.root / "состояние хаба"
        self.state.mkdir()
        self.runner = FakeRunner()
        self.metadata = {"version": 1, "role": "hub", "project": "test", "platform": "linux/arm64", "ports": {"http": 3100, "mqtt": 1890}}
        self.record = {"revision": "a" * 40, "commit": "a" * 40, "content": "b" * 64,
                       "schema": hashlib.sha256().hexdigest(), "image": "fcplcn-hub:test",
                       "imageId": "sha256:verified-image"}
        self.stack = Stack(self.runner, self.state, self.metadata, self.record)
        self.stack.source.mkdir(parents=True)
        (self.state / "runtime").mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def args(self, *arguments):
        return cli.parser().parse_args(list(arguments))

    def source_fixture(self):
        root = self.root / "исходники"
        (root / "config").mkdir(parents=True)
        (root / "config/product.json").write_text('{"name":"FCPLCn"}')
        (root / "hub/deploy").mkdir(parents=True)
        (root / "hub/deploy/compose.yaml").write_text("services: {}\n")
        return root

    def test_snapshot_never_copies_secrets_or_follows_links(self):
        source = self.source_fixture()
        for name in ("runtime", "node_modules", "dist", "data", ".git", ".venv"):
            (source / name).mkdir()
            (source / name / "secret").write_text("private")
        (source / ".env").write_text("PASSWORD=private")
        (source / ".env.production").write_text("PASSWORD=private")
        (source / ".env.example").write_text("PASSWORD=")
        (source / "outside-link").symlink_to(source / "runtime/secret")
        with patch("lib.sources.git_details", return_value=(None, None)):
            record = prepare_source(self.runner, self.state, source, role="hub")
        copied = self.state / "releases" / record["revision"] / "source"
        self.assertTrue((copied / ".env.example").exists())
        self.assertFalse((copied / ".env").exists())
        self.assertFalse((copied / "runtime").exists())
        self.assertFalse((copied / "outside-link").exists())
        self.assertEqual(record["content"], tree_digest(copied))

    def test_snapshot_supports_parent_software_directory(self):
        source = self.source_fixture()
        (source / "fcplcn-soft").mkdir()
        # The normal source root remains preferred over a similarly named folder.
        with patch("lib.sources.git_details", return_value=(None, None)):
            record = prepare_source(self.runner, self.state, source, role="hub")
        self.assertTrue(record["revision"].startswith("local-"))

    def test_registry_uses_full_sha_and_owner(self):
        record = dict(self.record, repo="git@github.com:MyOwner/fcplcn-soft.git")
        self.assertEqual(default_image("hub", record, "linux/arm64"),
                         "ghcr.io/myowner/fcplcn-hub:sha-" + "a" * 40)

    def test_repository_credentials_and_non_github_urls_rejected(self):
        for remote in ("https://secret@github.com/a/b", "https://example.com/a/b", "--upload-pack=bad"):
            with self.assertRaises(DeploymentError):
                github_repository(remote)

    def test_32_bit_images_are_rejected_even_with_github_remote(self):
        for record in ({"content": "c" * 64},
                       dict(self.record, repo="https://github.com/owner/repository")):
            with self.assertRaises(DeploymentError):
                default_image("hub", record, "linux/arm/v7")

    def test_both_roles_reject_32_bit_installations(self):
        for role in ("hub", "cloud"):
            with self.assertRaises(DeploymentError):
                initial_metadata(self.args(role, "install", "--domain", "cloud.example.com"), "linux/arm/v7")

    def test_explicit_platform_cannot_bypass_64_bit_requirement(self):
        for architecture in ("linux/arm/v7", "linux/arm/v6", "linux/386"):
            with patch.dict(os.environ, {"FCPLCN_PLATFORM": architecture}):
                with self.assertRaises(DeploymentError):
                    host_platform()

    def test_detected_32_bit_machine_is_rejected(self):
        with patch.dict(os.environ, {"FCPLCN_PLATFORM": ""}), \
             patch("lib.common.platform.machine", return_value="armv7l"):
            with self.assertRaises(DeploymentError):
                host_platform()

    def test_compose_uses_fixed_project_and_absolute_runtime(self):
        self.stack.write_override()
        command = self.stack.command(["ps"])
        self.assertIn(str(self.state / "runtime/hub.env"), command)
        self.assertEqual(command[command.index("--project-name") + 1], "test")
        override = read_json(self.stack.release / "installer.compose.json")
        self.assertIn(str(self.state / "runtime/broker"), override["services"]["broker"]["volumes"][0])
        self.assertEqual(self.stack.environment()["FCPLCN_HUB_PORT"], "3100")

    def test_arm64_runtime_uses_node24_without_broker_architecture_override(self):
        self.stack.prepare_image(image="custom/hub:arm64", source_build=True)
        self.stack.pin_release()
        build = next(args for args, _ in self.runner.calls if "build" in args)
        self.assertIn("FCPLCN_NODE_RUNTIME_IMAGE=node:24.22.3-bookworm-slim", build)
        self.assertEqual(build[build.index("--platform") + 1], "linux/arm64")
        override = read_json(self.stack.release / "installer.compose.json")
        self.assertNotIn("platform", override["services"]["broker"])
        self.assertNotIn("platform", override["services"]["broker-setup"])

    def test_sudo_docker_prefix_does_not_change_compose_identity(self):
        with patch.dict(os.environ, {"FCPLCN_DOCKER_SUDO": "1"}):
            stack = Stack(self.runner, self.state, self.metadata, self.record)
        command = stack.command(["ps"])
        self.assertEqual(command[0], "sudo")
        self.assertTrue(command[1].startswith("--preserve-env="))
        self.assertEqual(command[2:4], ["docker", "compose"])
        self.assertEqual(command[command.index("--project-name") + 1], "test")

    def test_sudo_preserves_compose_and_docker_inputs_by_name_only(self):
        with patch.dict(os.environ, {"FCPLCN_DOCKER_SUDO": "1",
                                    "FCPLCN_PLC_PASSWORD": "private-tablet-password",
                                    "DOCKER_HOST": "unix:///private/socket"}):
            prefix = docker_prefix()
        preserved = set(prefix[1].removeprefix("--preserve-env=").split(","))
        self.assertEqual(preserved, set(DOCKER_ENVIRONMENT))
        self.assertTrue({"FCPLCN_PLC_ID", "FCPLCN_PLC_PASSWORD", "FCPLCN_HUB_BROKER_AUTH_DIR",
                         "FCPLCN_CLOUD_HTTPS_PORT", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"}.issubset(preserved))
        self.assertNotIn("private-tablet-password", " ".join(prefix))
        self.assertNotIn("unix:///private/socket", " ".join(prefix))
        self.assertNotIn("-E", prefix)

    def test_sudo_environment_allowlist_covers_all_compose_variables(self):
        referenced = set()
        for role in ("hub", "cloud"):
            compose = DEPLOY.parent / role / "deploy/compose.yaml"
            referenced.update(re.findall(r"\$\{([A-Z_][A-Z0-9_]*)", compose.read_text()))
        self.assertTrue(referenced.issubset(set(DOCKER_ENVIRONMENT)), referenced - set(DOCKER_ENVIRONMENT))

    def test_sudo_plc_credentials_remain_in_environment(self):
        with patch.dict(os.environ, {"FCPLCN_DOCKER_SUDO": "1"}):
            stack = Stack(self.runner, self.state, self.metadata, self.record)
        stack.compose(["run", "--rm", "broker-setup", "plc"],
                      extra={"FCPLCN_PLC_ID": "test-plc", "FCPLCN_PLC_PASSWORD": "secret-plc-password"})
        command, options = self.runner.calls[-1]
        self.assertIn("FCPLCN_PLC_PASSWORD", command[1].split("=", 1)[1].split(","))
        self.assertNotIn("secret-plc-password", " ".join(command))
        self.assertEqual(options["env"]["FCPLCN_PLC_PASSWORD"], "secret-plc-password")

    def enable_hub_database(self, stack):
        bootstrap = stack.source / "hub/deploy/postgres-init.sh"
        bootstrap.parent.mkdir(parents=True, exist_ok=True)
        bootstrap.write_text("# database bootstrap\n")

    def hub_database_compose(self):
        return {
            "services": {**self.runner.config["services"], "db": {
                "image": "postgres:18-alpine",
                "volumes": [{"type": "volume", "source": "hub-db-data", "target": "/var/lib/postgresql"}],
            }},
            "volumes": {**self.runner.config["volumes"], "hub-db-data": {"name": "test_hub-db-data"}},
        }

    def test_hub_database_credentials_are_private_and_never_change_on_retry(self):
        self.enable_hub_database(self.stack)
        self.stack.prepare_hub_environment()
        database_env = self.stack.hub_database_env
        first = database_env.read_text()
        passwords = [line.split("=", 1)[1] for line in first.splitlines()]
        self.assertTrue(all(re.fullmatch("[a-f0-9]{64}", password) for password in passwords))
        self.assertEqual(len(set(passwords)), 2)
        self.assertEqual(database_env.stat().st_mode & 0o777, 0o600)
        self.stack.prepare_hub_environment()
        self.assertEqual(database_env.read_text(), first)
        command = self.stack.command(["config"])
        self.assertEqual(command.count("--env-file"), 2)
        self.assertIn(str(database_env), command)
        self.assertFalse(any(password in " ".join(command) for password in passwords))
        with patch.dict(os.environ, dict.fromkeys(HUB_DATABASE_CREDENTIALS, "unintended-override")):
            self.assertTrue(all(name not in self.stack.environment() for name in HUB_DATABASE_CREDENTIALS))

    def test_missing_credentials_never_overwrite_a_populated_hub_database(self):
        self.enable_hub_database(self.stack)
        self.runner.config = self.hub_database_compose()
        with self.assertRaisesRegex(DeploymentError, "без файла паролей"):
            self.stack.prepare_hub_database()
        self.assertFalse(self.stack.hub_database_env.exists())

    def test_hub_password_is_generated_once_and_never_printed(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.stack.initialize()
            first = (self.state / "runtime/hub.env").read_text()
            self.stack.initialize()
        self.assertEqual(first, (self.state / "runtime/hub.env").read_text())
        password = first.split("FCPLCN_HUB_MQTT_PASSWORD=")[1].strip()
        self.assertGreaterEqual(len(password), 32)
        self.assertNotIn(password, output.getvalue())

    def test_backup_stops_all_services_before_archiving(self):
        with contextlib.redirect_stdout(io.StringIO()):
            backup = make_backup(self.stack)
        manifest = load_backup(backup, role="hub", project="test")[1]
        self.assertEqual(set(manifest["volumes"]), {"test_hub-data", "test_broker-data"})
        calls = [arguments for arguments, _ in self.runner.calls]
        stop = next(index for index, arguments in enumerate(calls) if "stop" in arguments)
        archive = next(index for index, arguments in enumerate(calls) if "-czpf" in arguments)
        self.assertLess(stop, archive)
        self.assertIn("up", calls[-1])
        self.assertFalse(any("down" in arguments or "prune" in arguments for arguments in calls))

    def test_backup_failure_restarts_old_stack(self):
        self.runner.fail = lambda arguments: "-czpf" in arguments
        with self.assertRaises(DeploymentError):
            make_backup(self.stack, restart=False)
        self.assertIn("up", self.runner.calls[-1][0])
        self.assertFalse(list((self.state / "backups").glob("*/manifest.json")))

    def test_successful_update_backup_does_not_restart_old_version(self):
        with contextlib.redirect_stdout(io.StringIO()):
            make_backup(self.stack, restart=False)
        self.assertFalse(any("up" in arguments for arguments, _ in self.runner.calls))

    def test_backup_checksum_is_validated_before_restore(self):
        with contextlib.redirect_stdout(io.StringIO()):
            backup = make_backup(self.stack)
        (backup / "runtime.tar.gz").write_bytes(b"corruption")
        with self.assertRaisesRegex(DeploymentError, "Контрольная сумма"):
            load_backup(backup, role="hub", project="test")

    def test_backup_for_other_project_is_rejected(self):
        with contextlib.redirect_stdout(io.StringIO()):
            backup = make_backup(self.stack)
        with self.assertRaises(DeploymentError):
            load_backup(backup, role="hub", project="production")

    def test_archive_traversal_is_rejected(self):
        path = self.root / "bad.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            item = tarfile.TarInfo("../../outside")
            item.size = 1
            archive.addfile(item, io.BytesIO(b"x"))
        with self.assertRaises(DeploymentError):
            validate_archive(path)

    def test_archive_escaping_symlink_is_rejected(self):
        path = self.root / "link.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            item = tarfile.TarInfo("unsafe")
            item.type = tarfile.SYMTYPE
            item.linkname = "/etc/passwd"
            archive.addfile(item)
        with self.assertRaises(DeploymentError):
            validate_archive(path)

    def test_single_writer_lock_and_stale_recovery(self):
        with deployment_lock(self.state):
            with self.assertRaises(DeploymentError):
                with deployment_lock(self.state):
                    self.fail("concurrent writer acquired lock")
        lock = self.state / ".deployment-lock"
        lock.mkdir()
        atomic_json(lock / "owner.json", {"pid": 999999})
        with patch("lib.common.os.kill", side_effect=ProcessLookupError):
            with deployment_lock(self.state):
                self.assertTrue(lock.exists())
        self.assertFalse(lock.exists())

    def test_atomic_pointer_preserves_unicode_paths(self):
        point_release(self.state, "current", self.stack.release)
        self.assertEqual((self.state / "current").resolve(), self.stack.release)

    def test_schema_change_blocks_code_rollback_without_stopping(self):
        atomic_json(self.stack.release / "release.json", self.record)
        atomic_json(self.state / "metadata.json", self.metadata)
        point_release(self.state, "current", self.stack.release)
        previous = self.state / "releases/previous"
        previous.mkdir()
        atomic_json(previous / "release.json", dict(self.record, schema="changed"))
        point_release(self.state, "previous", previous)
        with self.assertRaisesRegex(DeploymentError, "схема БД"):
            rollback(self.args("hub", "rollback", "--yes"), self.runner, self.state)
        self.assertEqual(self.runner.calls, [])

    def test_failed_image_build_cannot_stop_existing_stack(self):
        atomic_json(self.stack.release / "release.json", self.record)
        atomic_json(self.state / "metadata.json", self.metadata)
        point_release(self.state, "current", self.stack.release)
        next_record = dict(self.record, revision="c" * 40, content="d" * 64)
        args = self.args("hub", "update", "--repo", "https://github.com/test/repository", "--source-build")
        with patch("lib.lifecycle.host_platform", return_value="linux/arm64"), \
             patch("lib.lifecycle.prepare_source", return_value=next_record), \
             patch.object(Stack, "prepare_image", side_effect=DeploymentError("build failed")):
            with self.assertRaises(DeploymentError):
                deploy(args, self.runner, self.state, self.root)
        self.assertEqual((self.state / "current").resolve(), self.stack.release)
        self.assertFalse(any("stop" in arguments for arguments, _ in self.runner.calls))

    def update_fixture(self, role="hub"):
        self.metadata["ports"]["https"] = 443
        if role == "cloud":
            self.metadata.update(role=role, domain="cloud.example.com")
            self.runner.config["services"] = {
                "cloud": {"image": "cloud:test"},
                "broker": {"image": "mosquitto:test"},
                "db": {"image": "postgres:18-alpine"},
                "caddy": {"image": "caddy:test"},
            }
        self.record["repo"] = "https://github.com/test/repository"
        self.stack = Stack(self.runner, self.state, self.metadata, self.record)
        self.stack.write_override()
        atomic_json(self.stack.release / "release.json", self.record)
        atomic_json(self.state / "metadata.json", self.metadata)
        point_release(self.state, "current", self.stack.release)
        return self.args(role, "update")

    def run_update(self, args, record=None):
        with patch("lib.lifecycle.host_platform", return_value=self.metadata["platform"]), \
             patch("lib.lifecycle.prepare_source", return_value=dict(record or self.record)), \
             contextlib.redirect_stdout(io.StringIO()):
            deploy(args, self.runner, self.state, self.root)

    def test_legacy_hub_update_adds_only_its_postgresql_volume(self):
        args = self.update_fixture()
        runtime = self.state / "runtime/hub.env"
        runtime.write_text("FCPLCN_HUB_MQTT_PASSWORD=legacy-password\n")
        next_record = dict(self.record, revision="d" * 40, content="e" * 64)
        candidate = Stack(self.runner, self.state, self.metadata, next_record)
        self.enable_hub_database(candidate)
        next_record["schema"] = schema_digest(candidate.source, "hub")
        self.assertNotEqual(next_record["schema"], self.record["schema"])
        self.runner.proposed_config = self.hub_database_compose()
        self.run_update(args, next_record)
        active = read_json(self.state / "current/release.json")
        self.assertIn("db", active["serviceImages"])
        self.assertTrue(candidate.hub_database_env.is_file())
        self.assertEqual(runtime.read_text(), "FCPLCN_HUB_MQTT_PASSWORD=legacy-password\n")
        copies = list((self.state / "backups").glob("*/manifest.json"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(set(read_json(copies[0])["volumes"]), {"test_hub-data", "test_broker-data"})
        with patch("lib.lifecycle.host_platform", return_value=self.metadata["platform"]):
            with self.assertRaisesRegex(DeploymentError, "схема"):
                rollback(self.args("hub", "rollback", "--yes"), self.runner, self.state)
        self.assertFalse(any("broker-setup" in command or "down" in command
                             for command, _ in self.runner.calls))

    def test_legacy_hub_update_rejects_unrelated_additional_volume(self):
        args = self.update_fixture()
        next_record = dict(self.record, revision="d" * 40, content="e" * 64)
        self.enable_hub_database(Stack(self.runner, self.state, self.metadata, next_record))
        self.runner.proposed_config = self.hub_database_compose()
        self.runner.proposed_config["volumes"]["unrelated"] = {"name": "test_unrelated"}
        with self.assertRaisesRegex(DeploymentError, "подключения постоянных данных"):
            self.run_update(args, next_record)
        self.assertFalse(any("stop" in command for command, _ in self.runner.calls))

    def test_legacy_restore_keeps_later_hub_database_dormant(self):
        self.update_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            legacy = make_backup(self.stack)
        next_record = dict(self.record, revision="d" * 40, content="e" * 64)
        current = Stack(self.runner, self.state, self.metadata, next_record)
        self.enable_hub_database(current)
        current.prepare_hub_environment()
        self.runner.config = self.hub_database_compose()
        self.runner.calls.clear()
        with contextlib.redirect_stdout(io.StringIO()):
            target = restore_backup(self.runner, self.state, self.metadata, legacy, current=current)
        self.assertFalse(target.uses_hub_database)
        self.assertTrue(target.hub_database_fence.is_file())
        self.assertFalse(any("rm" in command and "test_hub-db-data" in command
                             for command, _ in self.runner.calls))
        with self.assertRaisesRegex(DeploymentError, "до PostgreSQL"):
            current.prepare_hub_database()

    def test_same_commit_can_update_broker_without_overwriting_hub_runtime(self):
        args = self.update_fixture()
        runtime = self.state / "runtime/hub.env"
        runtime.write_text("FCPLCN_HUB_MQTT_PASSWORD=custom-secret\n")
        self.runner.per_pull["mosquitto:test"] = "sha256:new-mosquitto"
        self.run_update(args)
        active = read_json(self.state / "current/release.json")
        previous = read_json(self.state / "previous/release.json")
        self.assertEqual(active["content"], previous["content"])
        self.assertEqual(active["serviceImages"], {"broker": "sha256:new-mosquitto"})
        self.assertEqual(previous["serviceImages"], {"broker": "sha256:previous-mosquitto"})
        self.assertEqual(runtime.read_text(), "FCPLCN_HUB_MQTT_PASSWORD=custom-secret\n")
        override = read_json(self.state / "current/installer.compose.json")
        self.assertEqual(override["services"]["broker"]["image"], "sha256:new-mosquitto")
        calls = [command for command, _ in self.runner.calls]
        stop = next(index for index, command in enumerate(calls) if "stop" in command)
        self.assertEqual(len([command for command in calls[:stop] if "pull" in command]), 2)
        self.assertFalse(any("broker-setup" in command or "down" in command for command in calls))
        save = next(command for command in calls if "save" in command)
        self.assertIn("sha256:previous-mosquitto", save)
        self.assertEqual(calls[-1][calls[-1].index("--pull") + 1], "never")

    def test_unchanged_service_image_ids_skip_downtime(self):
        args = self.update_fixture()
        self.run_update(args)
        self.assertTrue(any("pull" in command and command[-1] == "mosquitto:test"
                            for command, _ in self.runner.calls))
        self.assertFalse(any("stop" in command for command, _ in self.runner.calls))
        self.assertEqual((self.state / "current").resolve(), self.stack.release)

    def test_failed_auxiliary_pull_keeps_existing_stack_online(self):
        args = self.update_fixture()
        self.runner.fail = lambda command: "pull" in command and command[-1] == "mosquitto:test"
        with self.assertRaises(DeploymentError):
            self.run_update(args)
        self.assertFalse(any("stop" in command for command, _ in self.runner.calls))
        self.assertEqual((self.state / "current").resolve(), self.stack.release)

    def test_cloud_update_pulls_postgres_broker_and_caddy(self):
        args = self.update_fixture("cloud")
        self.runner.per_pull.update({"postgres:18-alpine": "sha256:postgres-new",
                                     "mosquitto:test": "sha256:mosquitto-new",
                                     "caddy:test": "sha256:caddy-new"})
        self.run_update(args)
        pinned = read_json(self.state / "current/release.json")["serviceImages"]
        self.assertEqual(pinned, {"db": "sha256:postgres-new", "broker": "sha256:mosquitto-new",
                                  "caddy": "sha256:caddy-new"})

    def test_postgres_minor_updates_keep_pgdata_and_major_updates_are_blocked(self):
        args = self.update_fixture("cloud")
        self.runner.per_pull["postgres:18-alpine"] = "sha256:postgres-incompatible"
        for environment in (["PG_MAJOR=19", "PGDATA=/var/lib/postgresql/18/docker"],
                            ["PG_MAJOR=18", "PGDATA=/var/lib/postgresql/18/moved"]):
            with self.subTest(environment=environment):
                self.runner.postgres_env["sha256:postgres-incompatible"] = environment
                with self.assertRaisesRegex(DeploymentError, "отдельный перенос базы"):
                    self.run_update(args)
        self.assertFalse(any("stop" in command for command, _ in self.runner.calls))

    def test_persistent_volume_mount_cannot_be_changed_by_update(self):
        args = self.update_fixture()
        self.runner.config["services"]["hub"]["volumes"] = [
            {"type": "volume", "source": "hub-data", "target": "/var/lib/fcplcn"},
        ]
        self.runner.proposed_config = dict(self.runner.config, services={
            **self.runner.config["services"],
            "hub": {"image": "fcplcn-hub:test", "volumes": [
                {"type": "volume", "source": "hub-data", "target": "/new-data"},
            ]},
        })
        with self.assertRaisesRegex(DeploymentError, "подключения постоянных данных"):
            self.run_update(args)
        self.assertFalse(any("stop" in command for command, _ in self.runner.calls))

    def test_dry_run_never_executes_commands_or_creates_state(self):
        directory = self.root / "must-not-exist"
        with contextlib.redirect_stdout(io.StringIO()):
            result = cli.main(["hub", "install", "--dir", str(directory), "--dry-run"], self.runner)
        self.assertEqual(result, 0)
        self.assertFalse(directory.exists())
        self.assertEqual(self.runner.calls, [])

    def test_ports_and_project_arguments_are_validated(self):
        with self.assertRaises(DeploymentError):
            initial_metadata(self.args("hub", "install", "--http-port", "70000"), "linux/amd64")
        with self.assertRaises(DeploymentError):
            initial_metadata(self.args("hub", "install", "--project", "../outside"), "linux/amd64")

    def test_invalid_domain_is_rejected_before_state_is_created(self):
        for domain in ("localhost", "a..example.com", "a-.example.com", "https://example.com"):
            with self.assertRaises(DeploymentError):
                initial_metadata(self.args("cloud", "install", "--domain", domain), "linux/arm64")

    def test_partial_stop_failure_still_recovers_old_services(self):
        self.runner.fail = lambda arguments: "stop" in arguments
        with self.assertRaises(DeploymentError):
            make_backup(self.stack, restart=False)
        self.assertIn("up", self.runner.calls[-1][0])

    def test_source_build_uses_local_tag_even_with_github_remote(self):
        self.stack.record["repo"] = "https://github.com/owner/repository"
        self.stack.metadata["platform"] = "linux/arm64"
        with contextlib.redirect_stdout(io.StringIO()):
            selected = self.stack.prepare_image(source_build=True)
            self.stack.pin_release()
        self.assertTrue(selected.startswith("fcplcn-hub:local-"))
        override = read_json(self.stack.release / "installer.compose.json")
        self.assertEqual(override["services"]["hub"]["image"], "sha256:verified-image")

    def test_backup_contains_exact_application_image(self):
        with contextlib.redirect_stdout(io.StringIO()):
            backup = make_backup(self.stack)
        manifest = load_backup(backup, role="hub", project="test")[1]
        self.assertIn("application-image.tar", manifest["archives"])
        save = next(arguments for arguments, _ in self.runner.calls if "save" in arguments)
        self.assertEqual(save[-1], self.record["imageId"])

    def test_restore_rejects_wrong_image_before_stopping(self):
        with contextlib.redirect_stdout(io.StringIO()):
            backup = make_backup(self.stack)
        original = self.runner.run
        def wrong_image(arguments, **kwargs):
            if "image" in arguments and "inspect" in arguments:
                return subprocess.CompletedProcess(arguments, 0, b"sha256:wrong", b"")
            return original(arguments, **kwargs)
        self.runner.calls.clear()
        with patch.object(self.runner, "run", side_effect=wrong_image):
            with self.assertRaisesRegex(DeploymentError, "Тег Docker"):
                restore_backup(self.runner, self.state, self.metadata, backup, current=self.stack)
        self.assertFalse(any("stop" in arguments for arguments, _ in self.runner.calls))

    def test_restore_failed_start_stops_partially_started_services(self):
        with contextlib.redirect_stdout(io.StringIO()):
            backup = make_backup(self.stack)
        with patch("lib.backups.make_backup", return_value=self.root / "safety"), \
             patch.object(Stack, "start", side_effect=DeploymentError("unhealthy")), \
             patch.object(Stack, "stop") as stop, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(DeploymentError):
                restore_backup(self.runner, self.state, self.metadata, backup, current=self.stack)
        stop.assert_called_once()

    def test_cloud_changed_migration_never_automatically_reverts_database(self):
        metadata = dict(self.metadata, role="cloud", domain="cloud.example.com")
        atomic_json(self.state / "metadata.json", metadata)
        atomic_json(self.stack.release / "release.json", self.record)
        point_release(self.state, "current", self.stack.release)
        self.runner.config["services"] = {
            "cloud": {"image": "cloud:test"}, "db": {"image": "postgres:18-alpine"},
        }
        next_record = dict(self.record, revision="c" * 40, content="d" * 64, schema="new-schema")
        args = self.args("cloud", "update", "--repo", "https://github.com/test/repository")
        with patch("lib.lifecycle.host_platform", return_value="linux/arm64"), \
             patch("lib.lifecycle.prepare_source", return_value=next_record), \
             patch("lib.lifecycle.make_backup", return_value=self.root / "copy"), \
             patch.object(Stack, "prepare_image"), patch.object(Stack, "pin_release"), \
             patch.object(Stack, "stop"), \
             patch.object(Stack, "start", side_effect=DeploymentError("unhealthy")) as start, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(DeploymentError):
                deploy(args, self.runner, self.state, self.root)
        self.assertEqual(start.call_count, 1)
        self.assertEqual((self.state / "current").resolve(), self.stack.release.resolve())

    def test_first_install_rejects_foreign_volumes_before_build(self):
        args = self.args("hub", "install", "--project", "test")
        with patch("lib.lifecycle.host_platform", return_value="linux/arm64"):
            with self.assertRaisesRegex(DeploymentError, "неуправляемой"):
                deploy(args, self.runner, self.state, self.root)
        self.assertFalse(any("build" in arguments for arguments, _ in self.runner.calls))

    def test_new_install_publishes_only_a_healthy_pinned_release(self):
        source = self.source_fixture()
        args = self.args("hub", "install", "--project", "fresh", "--source-build")
        with patch("lib.lifecycle.host_platform", return_value="linux/arm64"), \
             contextlib.redirect_stdout(io.StringIO()):
            deploy(args, self.runner, self.state, source)
        record = read_json(self.state / "current/release.json")
        self.assertIn("-img-", record["revision"])
        override = read_json(self.state / "current/installer.compose.json")
        self.assertEqual(override["services"]["hub"]["image"], record["imageId"])
        self.assertIn("up", self.runner.calls[-1][0])

    def test_existing_project_and_domain_cannot_silently_change(self):
        with patch("lib.lifecycle.host_platform", return_value="linux/arm64"):
            with self.assertRaises(DeploymentError):
                validate_identity(self.args("hub", "update", "--project", "different"), self.metadata)

    def test_low_memory_default_local_build_requires_explicit_choice(self):
        record = dict(self.record)
        record.pop("commit", None)
        stack = Stack(self.runner, self.state, self.metadata, record)
        with patch.dict(os.environ, {"FCPLCN_LOW_MEMORY": "1"}):
            with self.assertRaisesRegex(DeploymentError, "--source-build"):
                stack.prepare_image()
        self.assertEqual(self.runner.calls, [])

    def test_low_memory_explicit_source_build_is_allowed(self):
        with patch.dict(os.environ, {"FCPLCN_LOW_MEMORY": "1"}), \
             contextlib.redirect_stdout(io.StringIO()):
            self.stack.prepare_image(source_build=True)
        self.assertTrue(any("build" in arguments for arguments, _ in self.runner.calls))

    def test_certificate_renewal_backs_up_before_initializing_and_starting(self):
        events = []
        with patch("lib.lifecycle.make_backup", side_effect=lambda *args, **kwargs: events.append("backup") or self.root), \
             patch.object(Stack, "initialize", side_effect=lambda: events.append("initialize")), \
             patch.object(Stack, "start", side_effect=lambda: events.append("start")), \
             contextlib.redirect_stdout(io.StringIO()):
            renew_certificates(self.stack)
        self.assertEqual(events, ["backup", "initialize", "start"])

    def test_certificate_setup_failure_restarts_old_cloud(self):
        with patch("lib.lifecycle.make_backup", return_value=self.root), \
             patch.object(Stack, "initialize", side_effect=DeploymentError("setup failed")), \
             patch.object(Stack, "start") as start:
            with self.assertRaisesRegex(DeploymentError, "setup failed"):
                renew_certificates(self.stack)
        start.assert_called_once()

    def test_certificate_backup_failure_does_not_change_certificates(self):
        with patch("lib.lifecycle.make_backup", side_effect=DeploymentError("backup failed")), \
             patch.object(Stack, "initialize") as initialize:
            with self.assertRaises(DeploymentError):
                renew_certificates(self.stack)
        initialize.assert_not_called()

    def test_certificates_action_rejects_hub_before_reading_installation(self):
        with self.assertRaisesRegex(DeploymentError, "только для облака"):
            operate(self.args("hub", "certificates"), self.runner, self.state, self.root)
        self.assertEqual(self.runner.calls, [])


if __name__ == "__main__":
    unittest.main()
