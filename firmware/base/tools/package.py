"""Copy a verified ESP-IDF build into a self-contained flashing bundle."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

build, destination = map(Path, sys.argv[1:])
arguments = json.loads((build / 'flasher_args.json').read_text())
files = sorted(set(arguments['flash_files'].values()) | {'FCPLCn-full.bin', 'flasher_args.json'})
checksums = {}
for name in files:
    source = build / name
    target = destination / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    checksums[name] = hashlib.sha256(target.read_bytes()).hexdigest()
(destination / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name, digest in checksums.items()))
print(f'FCPLCn firmware bundle: {destination}')
