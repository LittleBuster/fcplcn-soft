import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup_nvr', Path(__file__).parents[1] / 'src/setup.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DiskTests(unittest.TestCase):
    def test_external_partition_only_and_system_partition_excluded(self):
        tree = {'blockdevices': [
            {'path': '/dev/nvme0n1', 'tran': 'nvme', 'children': [
                {'path': '/dev/nvme0n1p1', 'type': 'part', 'fstype': 'ext4', 'uuid': 'internal'}]},
            {'path': '/dev/sdb', 'tran': 'usb', 'model': 'USB disk', 'children': [
                {'path': '/dev/sdb1', 'type': 'part', 'fstype': 'ext4', 'uuid': 'root', 'mountpoints': ['/']},
                {'path': '/dev/sdb2', 'type': 'part', 'fstype': 'ext4', 'uuid': 'archive'},
                {'path': '/dev/sdb3', 'type': 'part', 'fstype': 'ntfs', 'uuid': 'readonly', 'ro': True},
                {'path': '/dev/sdb4', 'type': 'part', 'fstype': 'crypto_LUKS', 'uuid': 'encrypted'}]}]}
        self.assertEqual([p['path'] for p in m.partitions(tree)], ['/dev/sdb2'])
        self.assertEqual(m.partitions(tree)[0]['model'], 'USB disk')

    def test_missing_or_wrong_disk_blocks_start(self):
        for rows in [[], [{'uuid': 'wrong', 'target': str(m.DISK)}],
                     [{'uuid': 'abcd', 'target': '/another-mount'}]]:
            with patch.object(m, 'run', return_value=json.dumps({'filesystems': rows})):
                with self.assertRaises(m.SetupError):
                    m.verify_disk('abcd')

    def test_correct_uuid_and_mountpoint(self):
        with patch.object(m, 'run', return_value=json.dumps({'filesystems': [{'uuid': 'ABCD', 'target': str(m.DISK)}]})):
            m.verify_disk('abcd')

    def test_duplicate_uuid_not_selected(self):
        item = dict(path='/dev/sdb1', uuid='ABCD-1234', fstype='ext4', size=1000000, model='USB')
        with patch.object(m, 'scan'), patch.object(m, 'partitions', return_value=[item, dict(item, path='/dev/sdc1')]), \
                patch.object(m, 'ask', return_value='1'):
            with self.assertRaises(m.SetupError):
                m.choose_disk()

    def test_mount_unit_uses_uuid_not_dev_name(self):
        text = m.mount_text({'uuid': '1234-ABCD', 'fstype': 'ntfs'})
        self.assertIn('What=/dev/disk/by-uuid/1234-ABCD', text)
        self.assertIn('Type=ntfs-3g', text)
        self.assertEqual(m.MOUNT_UNIT, r'srv-shinobi\x2ddisk.mount')


class FilesTests(unittest.TestCase):
    def test_atomic_does_not_follow_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / 'original').write_text('keep')
            (p / 'link').symlink_to(p / 'original')
            with self.assertRaises(m.SetupError):
                m.atomic(p / 'link', 'replace')
            self.assertEqual((p / 'original').read_text(), 'keep')

    def test_unowned_unit_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'unit'
            p.write_text('some other service')
            with self.assertRaises(m.SetupError):
                m.managed(p, 'new service')
            self.assertEqual(p.read_text(), 'some other service')

    def test_own_unit_can_be_written_and_is_not_world_writable(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'unit'
            m.managed(p, 'first')
            m.managed(p, 'second')
            self.assertEqual(p.read_text(), m.MARKER + 'second')
            self.assertEqual(p.stat().st_mode & 0o777, 0o644)


class DeploymentTests(unittest.TestCase):
    def state(self):
        return dict(port=8080, db_image='mariadb@sha256:' + 'a' * 64,
                    shinobi_image='registry.gitlab.com/shinobi-systems/shinobidocker@sha256:' + 'b' * 64,
                    db_password='db-secret', db_root_password='root-secret', quota_mib=100000,
                    ready=False, bootstrap_token='ephemeral')

    def test_containers_cannot_auto_start_without_disk_guard(self):
        services = m.compose(self.state())['services']
        self.assertTrue(all(x['restart'] == 'no' for x in services.values()))
        self.assertNotIn('ports', services['db'])
        binds = services['shinobi']['volumes']
        archive = next(x for x in binds if x['target'] == '/config/videos')
        self.assertEqual(archive['source'], '/srv/shinobi-disk/recordings')
        self.assertFalse(archive['bind']['create_host_path'])

    def test_service_has_mount_lifetime_and_guard(self):
        with patch.object(m.shutil, 'which', return_value='/usr/bin/docker'):
            text = m.service_text()
        self.assertIn('BindsTo=' + m.MOUNT_UNIT, text)
        self.assertIn('RequiresMountsFor=/srv/shinobi-disk', text)
        self.assertIn('ExecStartPre=/usr/bin/python3 /opt/fcplcn-shinobi/check-disk.py', text)
        self.assertIn('down --timeout 30', text)

    def test_existing_user_not_recreated_or_password_reset(self):
        state = self.state()
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'ROOT', Path(d)), \
                patch.object(m, 'api', return_value={'ok': True, 'users': [{'mail': 'me@example.org'}]}) as api:
            m.provision(state, {'mail': 'me@example.org', 'password': 'secret'})
            self.assertEqual(api.call_count, 1)
            self.assertTrue(json.loads((Path(d) / 'state.json').read_text())['ready'])

    def test_new_user_gets_retention_and_quota_via_api(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'ROOT', Path(d)), \
                patch.object(m, 'api', side_effect=[{'ok': True, 'users': []}, {'ok': True}]) as api:
            m.provision(self.state(), {'mail': 'me@example.org', 'password': 'secret'})
            body = api.call_args.args[2]
            self.assertEqual(body['details'], {'size': '100000', 'days': '30', 'event_days': '30', 'log_days': '30'})
            self.assertEqual(api.call_args.args[1], 'registerAdmin')

    def test_failed_creation_is_not_marked_ready(self):
        state = self.state()
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'ROOT', Path(d)), \
                patch.object(m, 'api', side_effect=[{'ok': True, 'users': []}, {'ok': False}]):
            with self.assertRaises(m.SetupError):
                m.provision(state, {'mail': 'me@example.org', 'password': 'secret'})
            self.assertFalse(state['ready'])
            self.assertFalse((Path(d) / 'state.json').exists())

    def test_api_not_ready_has_bounded_wait(self):
        with patch.object(m, 'api', return_value={'ok': False}) as api, patch.object(m.time, 'sleep'):
            with self.assertRaises(m.SetupError):
                m.provision(self.state(), {'mail': 'me@example.org', 'password': 'secret'})
            self.assertEqual(api.call_count, 90)

    def test_bootstrap_removed_without_removing_other_superusers_tokens(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'ROOT', Path(d)):
            path = Path(d) / 'data'
            path.mkdir()
            original = [{'mail': 'x', 'pass': 'keep', 'tokens': ['ephemeral', 'other']},
                        {'mail': 'y', 'pass': 'also-keep', 'tokens': {'ephemeral': True, 'persist': True}}]
            (path / 'super.json').write_text(json.dumps(original))
            m.remove_bootstrap(self.state())
            result = json.loads((path / 'super.json').read_text())
            self.assertEqual(result[0]['tokens'], ['other'])
            self.assertEqual(result[1]['tokens'], {'persist': True})
            self.assertEqual([x['pass'] for x in result], ['keep', 'also-keep'])


if __name__ == '__main__':
    unittest.main()
