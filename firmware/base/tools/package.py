"""Copy a verified ESP-IDF build into a profile-labelled flashing bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


SUPPORTED_BOARD_IDS = {'fcplcn-161608-1v0', 'fcplc-080806-3v1'}
PROFILE_FILE = 'firmware-profile.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('build', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--board-id', choices=sorted(SUPPORTED_BOARD_IDS))
    args = parser.parse_args()
    build, destination = args.build, args.destination
    profile = json.loads((build / PROFILE_FILE).read_text())
    boot_board_id = profile.get('bootBoardId')
    if (profile.get('schemaVersion') != 1
            or profile.get('target') != 'esp32s3'
            or boot_board_id not in SUPPORTED_BOARD_IDS):
        parser.error('Missing or unsupported build profile metadata; configure the firmware again')
    if args.board_id is not None and boot_board_id != args.board_id:
        parser.error('The requested board does not match the compiled build profile')
    cached_board_id = None
    for line in (build / 'CMakeCache.txt').read_text().splitlines():
        if line.startswith('FCPLCN_BOOT_BOARD_ID:STRING='):
            cached_board_id = line.split('=', 1)[1]
            break
    if cached_board_id != boot_board_id:
        parser.error('Build profile metadata does not match CMakeCache.txt')
    previous_profile = destination / PROFILE_FILE
    if previous_profile.exists():
        previous = json.loads(previous_profile.read_text())
        if previous.get('bootBoardId') != boot_board_id:
            parser.error('Destination belongs to another board; choose a separate FCPLCN_BASE_DIST_DIR')
    arguments = json.loads((build / 'flasher_args.json').read_text())
    files = sorted(set(arguments['flash_files'].values())
                   | {'FCPLCn-full.bin', 'flasher_args.json', PROFILE_FILE})
    checksums = {}
    for name in files:
        source = build / name
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        checksums[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    (destination / 'SHA256SUMS').write_text(
        ''.join(f'{digest}  {name}\n' for name, digest in checksums.items()))
    print(f'{profile["product"]} firmware bundle ({boot_board_id}): {destination}')


if __name__ == '__main__':
    main()
