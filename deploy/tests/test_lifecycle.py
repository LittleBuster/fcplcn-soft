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
from lib.docker import Stack
from lib.lifecycle import deploy, initial_metadata, operate, renew_certificates, rollback, validate_identity
from lib.sources import default_image, github_repository, prepare_source, schema_digest, tree_digest

spec = importlib.util.spec_from_file_location("fcplcn_cli", DEPLOY / "fcplcn.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.config = {"volumes": {"hub-data": {"name": "test_hub-data"},
                                   "broker-data": {"name": "test_broker-data"}}}
        self.fail = None

    def run(self, arguments, **kwargs):
        arguments = [str(value) for value in arguments]
        self.calls.append((arguments, kwargs))
        if self.fail and self.fail(arguments):
            raise DeploymentError("Имитированная ошибка команды")
        if "config" in arguments:
            output = json.dumps(self.config).encode()
        elif "--status" in arguments:
            output = b"hub\nbroker\n"
        elif "image" in arguments and "inspect" in arguments:
            output = b"sha256:verified-image"
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
        next_record = dict(self.record, revision="c" * 40, content="d" * 64, schema="new-schema")
        args = self.args("cloud", "update", "--repo", "https://github.com/test/repository")
        with patch("lib.lifecycle.host_platform", return_value="linux/arm64"), \
             patch("lib.lifecycle.prepare_source", return_value=next_record), \
             patch("lib.lifecycle.make_backup", return_value=self.root / "copy"), \
             patch.object(Stack, "prepare_image"), patch.object(Stack, "initialize"), \
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
