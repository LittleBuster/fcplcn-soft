"""Verify profile-labelled bundles cannot be confused during packaging."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[2] / 'tools/package.py'
CURRENT = 'fcplcn-161608-1v0'
EEPROM = 'fcplc-080806-3v1'


class PackageProfileTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fcplcn-package-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def fixture(self, board):
        build = self.root / ('build-' + board)
        build.mkdir()
        (build / 'FCPLCn.bin').write_bytes(b'test application ' + board.encode())
        (build / 'FCPLCn-full.bin').write_bytes(b'test full image ' + board.encode())
        (build / 'flasher_args.json').write_text(json.dumps({'flash_files': {'0x10000': 'FCPLCn.bin'}}))
        (build / 'CMakeCache.txt').write_text(f'FCPLCN_BOOT_BOARD_ID:STRING={board}\n')
        (build / 'firmware-profile.json').write_text(json.dumps({
            'schemaVersion': 1, 'product': 'FCPLCn', 'target': 'esp32s3', 'bootBoardId': board,
        }))
        return build

    def package(self, build, destination, board):
        return subprocess.run([sys.executable, str(PACKAGE), str(build), str(destination),
                               '--board-id', board], capture_output=True, text=True)

    def test_each_board_has_its_own_hashed_profile(self):
        for board in (CURRENT, EEPROM):
            with self.subTest(board=board):
                build = self.fixture(board)
                destination = self.root / ('dist-' + board)
                result = self.package(build, destination, board)
                self.assertEqual(result.returncode, 0, result.stderr)
                profile = json.loads((destination / 'firmware-profile.json').read_text())
                self.assertEqual(profile['bootBoardId'], board)
                for line in (destination / 'SHA256SUMS').read_text().splitlines():
                    digest, filename = line.split('  ', 1)
                    self.assertEqual(digest, hashlib.sha256((destination / filename).read_bytes()).hexdigest())
                self.assertIn('firmware-profile.json', (destination / 'SHA256SUMS').read_text())

    def test_wrong_requested_board_does_not_copy(self):
        destination = self.root / 'dist'
        result = self.package(self.fixture(CURRENT), destination, EEPROM)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(destination.exists())

    def test_cache_mismatch_does_not_copy(self):
        build = self.fixture(EEPROM)
        (build / 'CMakeCache.txt').write_text(f'FCPLCN_BOOT_BOARD_ID:STRING={CURRENT}\n')
        destination = self.root / 'dist'
        result = self.package(build, destination, EEPROM)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(destination.exists())

    def test_foreign_destination_is_preserved(self):
        destination = self.root / 'dist'
        self.assertEqual(self.package(self.fixture(CURRENT), destination, CURRENT).returncode, 0)
        before = (destination / 'FCPLCn.bin').read_bytes()
        result = self.package(self.fixture(EEPROM), destination, EEPROM)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((destination / 'FCPLCn.bin').read_bytes(), before)
        self.assertEqual(json.loads((destination / 'firmware-profile.json').read_text())['bootBoardId'], CURRENT)


if __name__ == '__main__':
    unittest.main()
