"""Exercise installer platform routing without touching the host or network.

The shell boundary runs in subprocesses with a temporary OS description and
command doubles. Package managers, privilege escalation and daemon mutations
are intercepted, so these checks are safe on a developer's Mac and in Linux CI.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import pty
import shlex
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
PLATFORM = ROOT / "deploy" / "platform.sh"
INSTALLER = ROOT / "install.sh"


# Use the actual Python executable for the doubles: neither PATH nor the host's
# distribution should determine which interpreter runs a test command.
COMMAND_DOUBLE = r'''
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["FCPLCN_TEST_CALLS"], "a", encoding="utf-8") as log:
    log.write(json.dumps([name, *args]) + "\n")

if name == "uname":
    print(os.environ["FCPLCN_TEST_SYSTEM"] if "-s" in args
          else os.environ["FCPLCN_TEST_MACHINE"])
elif name == "dpkg" and args == ["--print-architecture"]:
    print(os.environ["FCPLCN_TEST_DPKG_ARCH"])
elif name == "dpkg-query":
    # A clean machine has no conflicting container runtime packages.
    pass
elif name == "root-command":
    # The privileged boundary is replaced wholesale for installation-path
    # checks. Repository contents are captured in the temporary test directory.
    if args and args[0] == "tee":
        Path(os.environ["FCPLCN_TEST_REPOSITORY"]).write_text(sys.stdin.read(), encoding="utf-8")
elif name == "sw_vers":
    print("26.1")
elif name == "docker":
    if args[:3] == ["compose", "version", "--short"]:
        print(os.environ.get("FCPLCN_TEST_COMPOSE", "2.39.1"))
    elif args[:2] == ["context", "show"]:
        print(os.environ.get("DOCKER_CONTEXT", "default"))
    elif args[:2] == ["context", "inspect"]:
        endpoint = os.environ.get("FCPLCN_TEST_ENDPOINT", "unix:///var/run/docker.sock")
        if "--format" in args or "-f" in args:
            print(endpoint)
        else:
            print(json.dumps([{"Name": "default", "Endpoints": {"docker": {"Host": endpoint}}}]))
    elif args and args[0] in ("info", "version"):
        print("FCPLCn test Docker is available")
    else:
        # Unexpected Docker commands are intercepted instead of reaching the
        # developer's real engine, including commands that create containers.
        sys.exit(93)
else:
    # Never install software, launch applications or invoke a real sudo prompt.
    sys.exit(92)
'''


class PlatformBoundaryTests(unittest.TestCase):
    """Check supported deployments and rejection before installation begins."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcplcn platform tests ")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.calls_file = self.directory / "calls.jsonl"
        self.release_file = self.directory / "os-release"
        self.home = self.directory / "home"
        self.home.mkdir()
        commands = (
            "uname", "dpkg", "dpkg-query", "root-command", "docker", "sudo", "curl", "brew", "apt", "apt-get",
            "systemctl", "service", "hdiutil", "open", "sw_vers", "git",
        )
        for name in commands:
            command = self.bin / name
            command.write_text(f"#!{sys.executable}\n" + COMMAND_DOUBLE, encoding="utf-8")
            command.chmod(0o755)

        self.environment = os.environ.copy()
        # An unrelated developer Docker context must not affect any test.
        for name in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            self.environment.pop(name, None)
        self.environment.update({
            "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.home),
            "FCPLCN_OS_RELEASE_FILE": str(self.release_file),
            "FCPLCN_TEST_CALLS": str(self.calls_file),
            "FCPLCN_TEST_SYSTEM": "Linux",
            "FCPLCN_TEST_MACHINE": "x86_64",
            "FCPLCN_TEST_DPKG_ARCH": "amd64",
            "FCPLCN_TEST_REPOSITORY": str(self.directory / "docker.sources"),
            "FCPLCN_TEST_ROOT_COMMAND": str(self.bin / "root-command"),
            "FCPLCN_PYTHON": sys.executable,
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.release('ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n')

    def release(self, contents):
        self.release_file.write_text(contents, encoding="utf-8")

    def calls(self):
        if not self.calls_file.exists():
            return []
        return [json.loads(line) for line in self.calls_file.read_text().splitlines()]

    def shell(self, body):
        return subprocess.run(
            ["/bin/bash", "-c", "set -euo pipefail\nsource " + shlex.quote(str(PLATFORM)) + "\n" + body],
            cwd=self.directory,
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=15,
        )

    def cli(self, *arguments):
        return subprocess.run(
            ["/bin/bash", str(INSTALLER), *arguments],
            cwd=self.directory,
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=15,
        )

    def terminal_cli(self, choices, *arguments):
        """Exercise the real interactive entry point using a terminal for stdin."""
        master, slave = pty.openpty()
        process = None
        try:
            command = ["/bin/bash", str(INSTALLER), *arguments]
            process = subprocess.Popen(
                command, cwd=self.directory, env=self.environment,
                stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            os.write(master, choices.encode("utf-8"))
            stdout, stderr = process.communicate(timeout=15)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate()
            os.close(slave)
            os.close(master)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_no_mutations(self):
        forbidden = {"sudo", "curl", "brew", "apt", "apt-get", "systemctl", "service", "hdiutil", "open", "git"}
        self.assertFalse([call for call in self.calls() if call[0] in forbidden], self.calls())
        allowed_docker = (("compose", "version"), ("context", "show"), ("context", "inspect"), ("info",), ("version",))
        self.assertFalse([
            call for call in self.calls()
            if call[0] == "docker" and not any(tuple(call[1:1 + len(prefix)]) == prefix for prefix in allowed_docker)
        ], self.calls())

    def detected(self):
        result = self.shell(
            "fcplcn_detect_platform\n"
            "printf 'FCPLCN_TEST_RESULT=%s|%s|%s|%s\\n' "
            '"$fcplcn_system" "$fcplcn_arch" "$fcplcn_os_base" "$fcplcn_os_codename"\n'
        )
        self.assert_success(result)
        line = next(line for line in result.stdout.splitlines() if line.startswith("FCPLCN_TEST_RESULT="))
        return line.partition("=")[2].split("|")

    def test_sourcing_library_has_no_platform_checks_or_side_effects(self):
        self.environment["FCPLCN_TEST_SYSTEM"] = "Unsupported"
        result = self.shell(":")
        self.assert_success(result)
        self.assertEqual(self.calls(), [])

    def test_help_works_on_unsupported_host_without_dependencies(self):
        self.environment["FCPLCN_TEST_SYSTEM"] = "Windows_NT"
        result = self.cli("--help")
        self.assert_success(result)
        self.assertIn("cloud", result.stdout)
        self.assertIn("hub", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_menus_dispatch_install_and_update_for_both_components(self):
        for component, role in (("1", "cloud"), ("2", "hub")):
            for choice, action in (("1", "install"), ("2", "update")):
                with self.subTest(role=role, action=action):
                    destination = self.directory / "deployment must not exist"
                    result = self.terminal_cli(
                        component + "\n" + choice + "\n",
                        "--dry-run", "--dir", str(destination),
                    )
                    self.assert_success(result)
                    self.assertIn("1. Установка", result.stdout)
                    self.assertIn("2. Обновление", result.stdout)
                    self.assertIn(f"FCPLCn {role}, действие {action}", result.stdout)
                    self.assertFalse(destination.exists())
        self.assert_no_mutations()

    def test_menu_exit_never_reaches_platform_or_dependencies(self):
        for choices in ("0\n", "1\n0\n", "2\n0\n"):
            with self.subTest(choices=choices):
                self.assert_success(self.terminal_cli(choices))
        self.assertEqual(self.calls(), [])

    def test_invalid_menu_choices_retry_before_dispatching(self):
        result = self.terminal_cli("wrong\n2\nwrong\n2\n", "--dry-run")
        self.assert_success(result)
        self.assertEqual(result.stdout.count("Введите 1, 2 или 0."), 2)
        self.assertIn("FCPLCn hub, действие update", result.stdout)
        self.assert_no_mutations()

    def test_missing_action_never_defaults_to_install_without_a_terminal(self):
        result = self.cli("hub", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("выбора установки или обновления", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_debian_13_uses_debian_repository_codename(self):
        system, architecture, base, codename = self.detected()
        self.assertEqual(system, "Linux")
        self.assertTrue(architecture)
        self.assertEqual((base, codename), ("debian", "trixie"))
        self.assert_no_mutations()

    def test_zero3_armbian_uses_arm64_and_the_debian_base_repository(self):
        # Orange Pi Zero 3 / Allwinner H618 uses a 64-bit Armbian userspace.
        self.environment.update(FCPLCN_TEST_MACHINE="aarch64", FCPLCN_TEST_DPKG_ARCH="arm64")
        self.release('ID=armbian\nID_LIKE=debian\nPRETTY_NAME="Armbian Debian 13 on Orange Pi Zero 3"\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n')
        self.assertEqual(self.detected()[2:], ["debian", "trixie"])
        result = self.shell('fcplcn_bootstrap hub install 1\nprintf "%s" "$FCPLCN_PLATFORM"')
        self.assert_success(result)
        self.assertIn("linux/arm64", result.stdout)
        self.assert_no_mutations()

    def test_armbian_ubuntu_uses_ubuntu_codename(self):
        self.environment.update(FCPLCN_TEST_MACHINE="aarch64", FCPLCN_TEST_DPKG_ARCH="arm64")
        self.release('ID=armbian\nID_LIKE="ubuntu debian"\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n')
        self.assertEqual(self.detected()[2:], ["ubuntu", "noble"])
        self.assert_no_mutations()

    def test_clean_linux_install_selects_matching_signed_docker_repository(self):
        variants = (
            ("debian", "trixie", "amd64", 'ID=debian\nVERSION_CODENAME=trixie\n'),
            ("ubuntu", "noble", "arm64", 'ID=armbian\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n'),
        )
        for base, codename, architecture, release in variants:
            with self.subTest(base=base, architecture=architecture):
                self.release(release)
                self.environment["FCPLCN_TEST_DPKG_ARCH"] = architecture
                self.calls_file.unlink(missing_ok=True)
                result = self.shell(r'''
fcplcn_detect_platform
# Model a clean host independently from the developer's installed tools.
command() {
    if [ "$#" = 2 ] && [ "$1" = -v ] && [ "$2" = docker ]; then return 1; fi
    builtin command "$@"
}
fcplcn_find_python() { return 1; }
fcplcn_root_cmd() { "$FCPLCN_TEST_ROOT_COMMAND" "$@"; }
fcplcn_linux_dependencies
''')
                self.assert_success(result)
                repository = Path(self.environment["FCPLCN_TEST_REPOSITORY"]).read_text()
                self.assertIn("URIs: https://download.docker.com/linux/" + base, repository)
                self.assertIn("Suites: " + codename, repository)
                self.assertIn("Architectures: " + architecture, repository)
                self.assertIn("Signed-By: /etc/apt/keyrings/docker.asc", repository)
                calls = self.calls()
                packages = [call for call in calls if call[:3] == ["root-command", "apt-get", "install"]]
                self.assertTrue(any("python3" in call and "git" in call for call in packages), calls)
                self.assertTrue(any("docker-ce" in call and "docker-compose-plugin" in call for call in packages), calls)
                self.assertTrue(any(call[:3] in (["root-command", "service", "docker"], ["root-command", "systemctl", "enable"]) for call in calls), calls)
                # Every privileged command was captured; no actual package
                # manager, downloader, daemon manager or sudo ran on this host.
                self.assert_no_mutations()

    def test_macos_apple_silicon_dry_run_never_installs_or_opens_desktop(self):
        self.environment.update(FCPLCN_TEST_SYSTEM="Darwin", FCPLCN_TEST_MACHINE="arm64")
        result = self.shell("fcplcn_bootstrap hub install 1")
        self.assert_success(result)
        self.assert_no_mutations()
        self.assertFalse(any(call[0] == "dpkg" for call in self.calls()), self.calls())

    def test_linux_dry_run_never_installs_packages_or_starts_services(self):
        result = self.shell("fcplcn_bootstrap cloud install 1")
        self.assert_success(result)
        self.assert_no_mutations()

    def test_cli_dry_run_does_not_create_a_deployment(self):
        before = sorted(str(path.relative_to(self.home)) for path in self.home.rglob("*"))
        state = self.directory / "deployment"
        result = self.cli("hub", "install", "--dry-run", "--dir", str(state))
        self.assert_success(result)
        self.assert_no_mutations()
        self.assertFalse(state.exists())
        after = sorted(str(path.relative_to(self.home)) for path in self.home.rglob("*"))
        self.assertEqual(after, before)

    def test_32_bit_arm_is_rejected_for_both_roles(self):
        # A 64-bit CPU with a 32-bit userspace is unsupported as well.
        for machine in ("armv7l", "aarch64"):
            self.environment.update(FCPLCN_TEST_MACHINE=machine, FCPLCN_TEST_DPKG_ARCH="armhf")
            for role in ("hub", "cloud"):
                with self.subTest(machine=machine, role=role):
                    result = self.shell("fcplcn_bootstrap " + role + " install 1")
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assert_no_mutations()

    def test_unsupported_os_and_architecture_fail_before_mutating_host(self):
        for system, machine, dpkg_arch in (("Windows_NT", "x86_64", "amd64"), ("Linux", "riscv64", "riscv64")):
            with self.subTest(system=system, machine=machine):
                self.environment.update(FCPLCN_TEST_SYSTEM=system, FCPLCN_TEST_MACHINE=machine, FCPLCN_TEST_DPKG_ARCH=dpkg_arch)
                result = self.shell("fcplcn_bootstrap hub install 1")
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_no_mutations()

    def test_remote_docker_host_is_rejected(self):
        for endpoint in ("ssh://other-server", "tcp://192.0.2.10:2376"):
            with self.subTest(endpoint=endpoint):
                self.environment["DOCKER_HOST"] = endpoint
                result = self.shell("fcplcn_require_local_docker")
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_no_mutations()

    def test_remote_named_docker_context_is_rejected(self):
        self.environment.update(DOCKER_CONTEXT="remote", FCPLCN_TEST_ENDPOINT="ssh://remote-server")
        result = self.shell("fcplcn_require_local_docker")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_no_mutations()

    def test_explicit_context_takes_precedence_over_docker_host(self):
        # Docker's actual precedence must also govern the installer guard.
        self.environment.update(
            DOCKER_CONTEXT="remote", DOCKER_HOST="unix:///var/run/docker.sock",
            FCPLCN_TEST_ENDPOINT="ssh://remote-server",
        )
        result = self.shell("fcplcn_require_local_docker")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_no_mutations()

    def test_local_docker_desktop_socket_is_allowed(self):
        self.environment["FCPLCN_TEST_ENDPOINT"] = "unix:///Users/test/.docker/run/docker.sock"
        result = self.shell("fcplcn_require_local_docker")
        self.assert_success(result)
        self.assert_no_mutations()

    def test_compose_must_support_health_wait_and_override_features(self):
        for version, accepted in (("2.24.3", False), ("2.24.4", True), ("v2.39.1", True), ("3.0.0", True)):
            with self.subTest(version=version):
                self.environment["FCPLCN_TEST_COMPOSE"] = version
                result = self.shell("fcplcn_check_compose")
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)
                self.assert_no_mutations()


if __name__ == "__main__":
    unittest.main()
