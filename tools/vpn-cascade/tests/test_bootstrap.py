"""Side-effect-free checks for the privileged shell installer boundary."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_installers", ROOT / "build_installers.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.template = (ROOT / "src" / "bootstrap.sh").read_text(encoding="utf-8")

    def script(self, role, payload="raise SystemExit('payload must not run')"):
        return self.template.replace("@ROLE@", role).replace("@PYTHON_PAYLOAD@", payload)

    def test_bash_syntax_both_roles(self):
        for role in ("arm", "ru"):
            result = subprocess.run(["bash", "-n"], input=self.script(role), text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_help_without_root_os_or_docker_checks(self):
        for role in ("arm", "ru"):
            for flag in ("--help", "-h"):
                result = subprocess.run(
                    ["bash", "-s", "--", flag], input=self.script(role), text=True, capture_output=True
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("sudo bash install_" + role + ".sh", result.stdout)
                self.assertNotIn("payload must not run", result.stdout + result.stderr)

    def test_unknown_argument_rejected_before_host_checks(self):
        result = subprocess.run(
            ["bash", "-s", "--", "--unexpected"], input=self.script("ru"), text=True, capture_output=True
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Неизвестные параметры", result.stderr)
        self.assertNotIn("предназначен для Linux", result.stderr)

    def test_runtime_receives_stdin_and_original_copied_path(self):
        payload = (
            "import json, sys\n"
            "print(json.dumps({'args': sys.argv[1:], 'line': input(), 'runtime': __file__}))\n"
        )
        script = self.script("ru", payload)
        # Exercise the actual embedding/launch/cleanup boundary independently
        # from its root/Linux/apt preflight; no package/daemon calls are run.
        prefix = script.split('if [[ "${1:-}" == --help', 1)[0]
        marker = 'WORK_DIR="$(mktemp -d /tmp/vpn-cascade-installer.XXXXXXXX)"'
        self.assertEqual(script.count(marker), 1)
        tail = marker + script.split(marker, 1)[1]
        with tempfile.TemporaryDirectory(prefix="vpn bootstrap test ") as folder:
            path = Path(folder) / "copied installer.sh"
            path.write_text(prefix + '\nINSTALLER="$0"\n' + tail, encoding="utf-8")
            result = subprocess.run(
                ["bash", str(path)], input="interactive answer\n", text=True, capture_output=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(output["args"], ["--role", "ru", "--installer", str(path)])
            self.assertEqual(output["line"], "interactive answer")
            self.assertFalse(Path(output["runtime"]).exists(), "temporary runtime was not cleaned up")

    def test_builder_embeds_role_and_rejects_heredoc_collision(self):
        original_root = builder.ROOT
        with tempfile.TemporaryDirectory(prefix="vpn-builder-test-") as folder:
            fixture = Path(folder)
            (fixture / "src").mkdir()
            (fixture / "src" / "bootstrap.sh").write_text(self.template, encoding="utf-8")
            runtime = fixture / "src" / "cascade.py"
            runtime.write_text("print('safe payload')\n", encoding="utf-8")
            builder.ROOT = fixture
            try:
                for role in ("arm", "ru"):
                    rendered = builder.render(role)
                    self.assertIn("ROLE='" + role + "'", rendered)
                    self.assertNotIn("@PYTHON_PAYLOAD@", rendered)
                runtime.write_text(builder.DELIMITER + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "heredoc delimiter"):
                    builder.render("ru")
            finally:
                builder.ROOT = original_root


if __name__ == "__main__":
    unittest.main()
