#!/usr/bin/env python3
"""Build the single portable Bash installer using standard Python only."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
content = (root / 'src/bootstrap.sh').read_text() + (root / 'src/setup.py').read_text()
content += '\n__FCPLCN_SHINOBI_PYTHON__\npython3 "$WORK_DIR/setup.py" "$INSTALLER"\n'
target = root / 'install.sh'
if '--check' in sys.argv:
    if not target.exists() or target.read_text() != content:
        sys.exit('install.sh needs rebuilding')
else:
    target.write_text(content)
    target.chmod(0o755)
