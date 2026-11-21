"""Shinobi deployment runtime; embedded in the standalone install.sh."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path('/opt/fcplcn-shinobi')
DISK = Path('/srv/shinobi-disk')
UNIT_DIR = Path('/etc/systemd/system')
MOUNT_UNIT = r'srv-shinobi\x2ddisk.mount'  # systemd-escape --path /srv/shinobi-disk
SERVICE = 'fcplcn-shinobi.service'
MARKER = '# Managed by FCPLCn Shinobi installer\n'
SUPPORTED_FS = {'ext4', 'xfs', 'btrfs', 'exfat', 'ntfs'}


class SetupError(Exception):
    pass


def run(args, capture=False, timeout=300):
    return subprocess.run(args, check=True, text=True, timeout=timeout,
                          stdout=subprocess.PIPE if capture else None).stdout


def atomic(path, data, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise SetupError('Отказ от записи через символическую ссылку: ' + str(path))
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path, data):
    atomic(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def ask(prompt, default=''):
    with open('/dev/tty', 'r+') as tty:
        tty.write(prompt + (f' [{default}]' if default else '') + ': ')
        tty.flush()
        answer = tty.readline()
    if not answer:
        raise SetupError('Ввод прерван.')
    return answer.strip() or default


def partitions(tree):
    """Only writable existing filesystems on external USB/removable devices."""
    result = []

    def visit(item, external=False, model=''):
        external = external or item.get('tran') == 'usb' or bool(item.get('rm'))
        model = item.get('model') or model
        mounts = item.get('mountpoints') or []
        system_mount = any(x in {'/', '/boot', '/boot/efi', '/usr', '/var', '/home'} for x in mounts)
        if (external and not item.get('ro') and not system_mount and item.get('uuid')
                and item.get('fstype') in SUPPORTED_FS and item.get('type') in {'disk', 'part'}):
            result.append(dict(item, model=model))
        for child in item.get('children', []):
            visit(child, external, model)

    for item in tree['blockdevices']:
        visit(item)
    return result


def scan():
    return json.loads(run(['lsblk', '--json', '--bytes', '--paths', '--output',
                           'PATH,TYPE,FSTYPE,UUID,MOUNTPOINTS,SIZE,MODEL,TRAN,RO,RM'], capture=True))


def choose_disk():
    items = partitions(scan())
    if not items:
        raise SetupError('Нет подходящего внешнего USB-раздела. Подключите диск с ext4/xfs/btrfs/exFAT/NTFS. Форматирование установщик не выполняет.')
    print('\nВнешние разделы (данные сохраняются):')
    for n, item in enumerate(items, 1):
        size = int(item['size']) / (1024 ** 3)
        print(f"  {n}. {item['path']} | {size:.1f} ГиБ | {item['fstype']} | {item['model'].strip()} | UUID={item['uuid']}")
    choice = ask('Номер раздела для архива')
    if not choice.isdigit() or not 1 <= int(choice) <= len(items):
        raise SetupError('Неверный номер раздела.')
    item = items[int(choice) - 1]
    if not re.fullmatch(r'[A-Za-z0-9-]{4,80}', item['uuid']):
        raise SetupError('Неподдерживаемый UUID.')
    if sum(x['uuid'].lower() == item['uuid'].lower() for x in items) != 1:
        raise SetupError('UUID дублируется; отключите копию диска.')
    return item


def verify_disk(uuid, disk=DISK):
    try:
        info = json.loads(run(['findmnt', '--json', '--mountpoint', str(disk),
                               '--output', 'UUID,TARGET'], capture=True, timeout=15))
        rows = info.get('filesystems', [])
    except (subprocess.SubprocessError, ValueError):
        rows = []
    if len(rows) != 1 or (rows[0].get('uuid') or '').lower() != uuid.lower() or rows[0].get('target') != str(disk):
        raise SetupError('Архивный диск не смонтирован или UUID не совпадает. Запись не запущена.')


def managed(path, content):
    if path.exists() and not path.read_text().startswith(MARKER):
        raise SetupError('Обнаружен чужой файл: ' + str(path))
    atomic(path, MARKER + content, 0o644)


def mount_text(state):
    fs = 'ntfs-3g' if state['fstype'] == 'ntfs' else state['fstype']
    return f'''[Unit]
Description=FCPLCn Shinobi recording disk

[Mount]
What=/dev/disk/by-uuid/{state['uuid']}
Where={DISK}
Type={fs}
Options=rw,nosuid,nodev
TimeoutSec=30
'''


def compose(state):
    # JSON is a YAML subset accepted by Compose; values are never shell-expanded.
    common = {'restart': 'no', 'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}
    bind = lambda src, dst: {'type': 'bind', 'source': str(src), 'target': dst,
                             'bind': {'create_host_path': False}}
    return {'services': {
        'db': dict(common, image=state['db_image'], environment={
            'MARIADB_ROOT_PASSWORD': state['db_root_password'], 'MARIADB_DATABASE': 'ccio',
            'MARIADB_USER': 'shinobi', 'MARIADB_PASSWORD': state['db_password']},
            volumes=[bind(ROOT / 'database', '/var/lib/mysql')],
            healthcheck={'test': ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'],
                         'interval': '5s', 'timeout': '5s', 'retries': 60, 'start_period': '30s'}),
        'shinobi': dict(common, image=state['shinobi_image'],
            depends_on={'db': {'condition': 'service_healthy'}},
            ports=[{'target': 8080, 'published': str(state['port']), 'host_ip': '0.0.0.0', 'protocol': 'tcp'}],
            environment={'DB_TYPE': 'mysql', 'DB_HOST': 'db', 'DB_PORT': '3306',
                         'DB_USER': 'shinobi', 'DB_PASSWORD': state['db_password'],
                         'DB_DATABASE': 'ccio', 'SSL_ENABLED': 'false'},
            volumes=[bind(ROOT / 'data', '/config'), bind(DISK / 'recordings', '/config/videos'),
                     dict(bind('/etc/localtime', '/etc/localtime'), read_only=True)],
            shm_size='256m', security_opt=['no-new-privileges:true'])}}


def service_text():
    cmd = f'{shutil.which("docker")} compose --project-directory {ROOT} -p fcplcn-shinobi -f {ROOT}/compose.yaml'
    return f'''[Unit]
Description=FCPLCn Shinobi recorder
Requires=docker.service {MOUNT_UNIT}
BindsTo={MOUNT_UNIT}
After=docker.service network-online.target {MOUNT_UNIT}
Wants=network-online.target
RequiresMountsFor={DISK}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
Environment=DOCKER_HOST=unix:///var/run/docker.sock
UnsetEnvironment=DOCKER_CONTEXT
WorkingDirectory={ROOT}
ExecStartPre=/usr/bin/python3 {ROOT}/check-disk.py
ExecStart={cmd} up --abort-on-container-exit --exit-code-from shinobi
ExecStop={cmd} down --timeout 30
Restart=always
RestartSec=15
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
'''


def dc(*args, capture=False):
    return run(['docker', 'compose', '--project-directory', str(ROOT), '-p', 'fcplcn-shinobi',
                '-f', str(ROOT / 'compose.yaml'), *args], capture=capture, timeout=1200)


def pin(image):
    run(['docker', 'pull', image], timeout=1800)
    names = json.loads(run(['docker', 'image', 'inspect', image, '--format', '{{json .RepoDigests}}'], capture=True))
    repo = image.rsplit(':', 1)[0]
    for name in names or []:
        if re.fullmatch(re.escape(repo) + r'@sha256:[a-f0-9]{64}', name):
            return name
    raise SetupError('Не удалось закрепить digest образа: ' + image)


def api(state, suffix, body=None):
    url = f"http://127.0.0.1:{state['port']}/super/{state['bootstrap_token']}/accounts/{suffix}"
    data = urlencode({'data': json.dumps(body)}).encode() if body is not None else None
    req = Request(url, data=data)
    with build_opener(ProxyHandler({})).open(req, timeout=5) as response:
        return json.load(response)


def provision(state, access):
    last_error = None
    for _ in range(90):
        try:
            reply = api(state, 'list')
            if reply.get('ok') and isinstance(reply.get('users'), list):
                break
        except (OSError, ValueError) as error:
            last_error = type(error).__name__
        time.sleep(2)
    else:
        raise SetupError('Shinobi/база не готовы. Проверьте journalctl -u fcplcn-shinobi. ' + str(last_error or ''))
    users = [x for x in reply['users'] if x.get('mail') == access['mail']]
    if not users:
        reply = api(state, 'registerAdmin', {
            'mail': access['mail'], 'pass': access['password'], 'pass_again': access['password'],
            'details': {'size': str(state['quota_mib']), 'days': '30',
                        'event_days': '30', 'log_days': '30'}})
        if not reply.get('ok'):
            raise SetupError('Не удалось создать учётную запись через API Shinobi.')
    state['ready'] = True
    write_json(ROOT / 'state.json', state)


def remove_bootstrap(state):
    path = ROOT / 'data/super.json'
    data = json.loads(path.read_text())
    for user in data:
        tokens = user.get('tokens', [])
        if isinstance(tokens, list):
            user['tokens'] = [x for x in tokens if x != state['bootstrap_token']]
        elif isinstance(tokens, dict):
            tokens.pop(state['bootstrap_token'], None)
    write_json(path, data)


def wait_web(state):
    opener = build_opener(ProxyHandler({}))
    for _ in range(90):
        try:
            with opener.open(f"http://127.0.0.1:{state['port']}/", timeout=5) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(2)
    raise SetupError('Веб-интерфейс не ответил. Проверьте journalctl -u fcplcn-shinobi.')


def main(installer):
    if ROOT.is_symlink() or (ROOT.exists() and ROOT.stat().st_uid != 0):
        raise SetupError('Каталог установки должен принадлежать root и не быть символической ссылкой.')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    with (ROOT / '.install.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Другой установщик уже работает.')
        statefile = ROOT / 'state.json'
        if statefile.exists():
            state = json.loads(statefile.read_text())
            if state.get('version') != 1:
                raise SetupError('Неизвестная версия сохранённых настроек.')
            if state['ready'] and not all((ROOT / p).is_file() for p in ('data/conf.json', 'data/super.json', 'compose.yaml', 'access.json')):
                raise SetupError('Не хватает файлов существующей установки. Восстановите их из резервной копии; новые настройки не записаны.')
            print('Используются сохранённые UUID, образы и настройки.')
        else:
            if any(x.name != '.install.lock' for x in ROOT.iterdir()):
                raise SetupError('Каталог установки уже содержит чужие данные.')
            existing = run(['docker', 'ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=fcplcn-shinobi'], capture=True)
            if existing.strip():
                raise SetupError('Найдена существующая установка fcplcn-shinobi без state.json.')
            disk = choose_disk()
            port = ask('Порт веб-интерфейса', '8080')
            if not port.isdigit() or not 1024 <= int(port) <= 65535:
                raise SetupError('Порт должен быть от 1024 до 65535.')
            with socket.socket() as probe:
                try:
                    probe.bind(('0.0.0.0', int(port)))
                except OSError:
                    raise SetupError('Выбранный порт уже занят.')
            mail = ask('Логин в виде адреса email', 'admin@fcplcn.local')
            if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', mail):
                raise SetupError('Укажите email для логина.')
            arch = run(['dpkg', '--print-architecture'], capture=True).strip()
            tag = 'v2' if arch == 'amd64' else 'v2-arm64v8'
            print('Скачиваются официальные образы Shinobi и MariaDB…')
            state = {'version': 1, 'uuid': disk['uuid'], 'fstype': disk['fstype'], 'port': int(port),
                     'db_password': secrets.token_hex(24), 'db_root_password': secrets.token_hex(24),
                     'bootstrap_token': secrets.token_hex(32), 'ready': False,
                     'shinobi_image': pin('registry.gitlab.com/shinobi-systems/shinobidocker:' + tag),
                     'db_image': pin('mariadb:11.4')}
            access = {'mail': mail, 'password': secrets.token_urlsafe(18),
                      'super_mail': 'super@fcplcn.local', 'super_password': secrets.token_urlsafe(24)}
            state['initial_access'] = access
            write_json(statefile, state)

        if not (ROOT / 'access.json').exists():
            write_json(ROOT / 'access.json', state['initial_access'])

        if state['fstype'] == 'ntfs':
            run(['apt-get', 'update'])
            run(['apt-get', 'install', '-y', '--no-install-recommends', '--no-remove', 'ntfs-3g'])
        # Reject a different volume or existing files hidden below a new mount.
        if DISK.is_symlink():
            raise SetupError('Точка монтирования не должна быть символической ссылкой.')
        if os.path.ismount(DISK):
            verify_disk(state['uuid'])
        else:
            if DISK.exists() and any(DISK.iterdir()):
                raise SetupError('Точка монтирования не пуста: ' + str(DISK))
            DISK.mkdir(mode=0o755, parents=True, exist_ok=True)
        managed(UNIT_DIR / MOUNT_UNIT, mount_text(state))
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'start', MOUNT_UNIT], timeout=90)
        verify_disk(state['uuid'])
        recording = DISK / 'recordings'
        if recording.is_symlink():
            raise SetupError('Каталог recordings не должен быть символической ссылкой.')
        recording.mkdir(mode=0o700, exist_ok=True)
        if 'quota_mib' not in state:
            space = os.statvfs(recording)
            state['quota_mib'] = int(space.f_bavail * space.f_frsize * 0.8 / 1048576)
            if state['quota_mib'] < 1024:
                raise SetupError('На внешнем диске недостаточно свободного места.')
            write_json(statefile, state)
        for name in ('data', 'database'):
            (ROOT / name).mkdir(mode=0o700, exist_ok=True)
        if not (ROOT / 'data/conf.json').exists():
            write_json(ROOT / 'data/conf.json', {'port': 8080, 'passwordType': 'sha256',
                       'videosDir': '__DIR__/videos', 'debugLog': False, 'cron': {}, 'pluginKeys': {}})
        access = json.loads((ROOT / 'access.json').read_text())
        if not (ROOT / 'data/super.json').exists():
            if state['ready']:
                raise SetupError('super.json отсутствует; восстановите файл из резервной копии.')
            write_json(ROOT / 'data/super.json', [{'mail': access['super_mail'],
                       'pass': hashlib.sha256(access['super_password'].encode()).hexdigest(),
                       'tokens': [state['bootstrap_token']]}])
        write_json(ROOT / 'compose.yaml', compose(state))
        dc('config', '--quiet')
        # The check runs on every service start; it never creates a recording path.
        checker = '''import json, subprocess, sys
from pathlib import Path
s = json.loads(Path('/opt/fcplcn-shinobi/state.json').read_text())
try:
    r = subprocess.run(['findmnt','-J','-M','/srv/shinobi-disk','-o','UUID,TARGET'], check=True, capture_output=True, text=True)
    fs = json.loads(r.stdout)['filesystems']
    ok = len(fs) == 1 and (fs[0].get('uuid') or '').lower() == s['uuid'].lower() and fs[0].get('target') == '/srv/shinobi-disk'
except Exception:
    ok = False
if not ok:
    sys.exit('UUID архивного диска не совпадает; запись не запущена.')
'''
        atomic(ROOT / 'check-disk.py', checker)
        if Path(installer).resolve() != ROOT / 'install.sh':
            atomic(ROOT / 'install.sh', Path(installer).read_text(), 0o700)
        managed(UNIT_DIR / SERVICE, service_text())
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', SERVICE])
        run(['systemctl', 'reset-failed', SERVICE])
        run(['systemctl', 'start', SERVICE])
        if not state['ready']:
            try:
                provision(state, access)
            except Exception:
                run(['systemctl', 'stop', SERVICE])
                raise
        remove_bootstrap(state)
        wait_web(state)
        print('\nShinobi установлен. В браузере: http://IP_ЭТОГО_КОМПЬЮТЕРА:' + str(state['port']))
        print('Логин:', access['mail'])
        print('Первоначальные пароли сохранены в /opt/fcplcn-shinobi/access.json (только root).')
        print('Показать их: sudo cat /opt/fcplcn-shinobi/access.json')
        print('Архив:', recording, '| UUID:', state['uuid'])
        print(f"Лимит архива: {state['quota_mib'] / 1024:.1f} ГиБ, хранение до 30 дней (можно изменить в интерфейсе).")
        print('Камеры добавьте через ONVIF Scanner, указав их логин и пароль.')


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except KeyboardInterrupt:
        sys.exit('Установка прервана.')
    except (SetupError, subprocess.SubprocessError) as error:
        # Never include request URLs: bootstrap credentials are embedded in them.
        sys.exit('Ошибка: ' + str(error))
    except (OSError, ValueError, KeyError) as error:
        sys.exit('Ошибка установки (' + type(error).__name__ + '). Сохранённые данные не удалялись.')
