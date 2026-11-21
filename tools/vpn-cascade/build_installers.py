#!/usr/bin/env python3
"""Build both self-contained installers from the shared shell/Python sources."""

import argparse
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
DELIMITER = "__VPN_CASCADE_PYTHON_EOF__"


def render(role: str) -> str:
    template = (ROOT / "src" / "bootstrap.sh").read_text(encoding="utf-8")
    payload = (ROOT / "src" / "cascade.py").read_text(encoding="utf-8")
    for marker in ("@ROLE@", "@PYTHON_PAYLOAD@"):
        if template.count(marker) != 1:
            raise ValueError("Expected exactly one template marker: " + marker)
    if DELIMITER in payload.splitlines():
        raise ValueError("Python payload collides with shell heredoc delimiter")
    if "\0" in payload or "\0" in template:
        raise ValueError("Installer source contains a NUL byte")
    compile(payload, str(ROOT / "src" / "cascade.py"), "exec")
    return template.replace("@ROLE@", role).replace("@PYTHON_PAYLOAD@", payload.rstrip("\n"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check generated files without writing")
    args = parser.parse_args()
    stale = []
    for role in ("arm", "ru"):
        path = ROOT / ("install_" + role + ".sh")
        content = render(role)
        if args.check:
            if not path.is_file() or path.read_text(encoding="utf-8") != content:
                stale.append(path.name)
        else:
            path.write_text(content, encoding="utf-8")
            path.chmod(0o755)
            print("Built " + str(path))
    if stale:
        print("Stale generated installers: " + ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
