#!/usr/bin/env bash
# Generated standalone installer; edit src/bootstrap.sh and src/cascade.py,
# then run build_installers.py to rebuild install_arm.sh and install_ru.sh.
set -Eeuo pipefail
umask 077

ROLE='arm'
WORK_DIR=''

cleanup() {
    if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
        rm -rf -- "$WORK_DIR"
    fi
}
trap cleanup EXIT
trap 'printf "Ошибка установщика в строке %s.\n" "$LINENO" >&2' ERR

die() {
    printf 'Ошибка: %s\n' "$*" >&2
    exit 1
}

show_help() {
    if [[ "$ROLE" == arm ]]; then
        printf '%s\n' \
            'Использование: sudo bash install_arm.sh' \
            'Устанавливает армянский выходной узел Xray в Docker Compose.' \
            'При повторном запуске использует сохранённые настройки и ключи.'
    else
        printf '%s\n' \
            'Использование: sudo bash install_ru.sh' \
            'Меню: 1 — установить российский узел; 2 — создать пользователя.' \
            'Повторный запуск сохраняет пользователей и ключи.'
    fi
    printf '%s\n' \
        'Поддерживаются Debian и Ubuntu с systemd; запускать из сохранённого файла.' \
        'Параметр --help показывает справку без изменений системы.'
}

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    show_help
    exit 0
fi
[[ $# -eq 0 ]] || die 'Неизвестные параметры. Используйте --help.'
[[ "$(uname -s)" == Linux ]] || die 'Этот установщик предназначен для Linux VPS (Debian/Ubuntu).'
[[ "$EUID" -eq 0 ]] || die "Запустите: sudo bash $0"
[[ -r /etc/os-release ]] || die 'Не найден /etc/os-release.'
# /etc/os-release is the OS-owned shell-compatible system identification file.
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
    debian|ubuntu) ;;
    *) die 'Автоматическая установка поддерживает только Debian и Ubuntu.' ;;
esac
[[ -d /run/systemd/system ]] || die 'Требуется VPS с systemd.'
[[ -n "${VERSION_CODENAME:-}" ]] || die 'В /etc/os-release отсутствует VERSION_CODENAME.'
command -v apt-get >/dev/null || die 'Не найден apt-get.'

INSTALLER="$(readlink -f -- "${BASH_SOURCE[0]}")"
[[ -f "$INSTALLER" ]] || die 'Сохраните установщик в файл и запустите его через bash.'

apt_install() {
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove "$@"
}

ensure_basics() {
    local missing=()
    command -v python3 >/dev/null || missing+=(python3)
    command -v curl >/dev/null || missing+=(curl)
    command -v flock >/dev/null || missing+=(util-linux)
    [[ -s /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
    if [[ ${#missing[@]} -gt 0 ]]; then
        apt-get update
        apt_install "${missing[@]}"
    fi
    python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
        || die 'Требуется Python 3.9 или новее (например, Debian 12 / Ubuntu 22.04).'
}

package_installed() {
    [[ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" == 'install ok installed' ]]
}

install_docker() {
    local package
    local conflicts=()
    # Docker's official installation instructions require removing conflicting
    # packages. This installer refuses to remove existing packages implicitly.
    # https://docs.docker.com/engine/install/debian/
    # https://docs.docker.com/engine/install/ubuntu/
    for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
        if package_installed "$package"; then
            conflicts+=("$package")
        fi
    done
    [[ ${#conflicts[@]} -eq 0 ]] \
        || die "Обнаружены существующие пакеты: ${conflicts[*]}. Установите совместимый Docker и Compose v2 вручную; скрипт их не удаляет."

    install -m 0755 -d /etc/apt/keyrings
    local repo_key
    repo_key="$(mktemp /etc/apt/keyrings/docker.asc.XXXXXX)"
    if ! curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 90 \
        --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$ID/gpg" -o "$repo_key"; then
        rm -f -- "$repo_key"
        die 'Не удалось скачать ключ официального репозитория Docker.'
    fi
    chmod 0644 "$repo_key"
    mv -f -- "$repo_key" /etc/apt/keyrings/docker.asc
    local arch
    arch="$(dpkg --print-architecture)"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$arch" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/vpn-cascade-docker.list
    apt-get update
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
}

ensure_compose() {
    if docker compose version >/dev/null 2>&1; then
        return
    fi
    # Keep an existing distribution Docker installation intact. Prefer that
    # distribution's Compose v2 plugin, where supplied, instead of migrating
    # the engine to Docker CE during an unrelated user-management operation.
    if package_installed docker.io; then
        apt-get update
        if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
            apt_install docker-compose-v2
        else
            die 'Docker уже установлен, но Compose v2 отсутствует. Установите Compose v2 для вашей версии ОС и повторите запуск.'
        fi
    elif package_installed docker-ce-cli; then
        apt-get update
        apt_install docker-compose-plugin
    else
        die 'Найден Docker без Compose v2 неизвестного способа установки. Установите Compose v2 вручную и повторите запуск.'
    fi
    docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 недоступен.'
}

ensure_basics
# Always address this VPS's Docker daemon, even if an inherited environment or
# a saved Docker context points to another machine.
unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
if ! command -v docker >/dev/null; then
    install_docker
fi
ensure_compose
docker info >/dev/null 2>&1 \
    || die 'Локальный Docker daemon недоступен. Проверьте systemctl status docker; существующий сервис скрипт автоматически не перезапускает.'

WORK_DIR="$(mktemp -d /tmp/vpn-cascade-installer.XXXXXXXX)"
RUNTIME="$WORK_DIR/cascade.py"
cat > "$RUNTIME" <<'__VPN_CASCADE_PYTHON_EOF__'
#!/usr/bin/env python3
"""Interactive, self-contained VLESS/REALITY two-VPS deployment runtime."""

import argparse
import base64
import contextlib
import copy
import datetime
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, quote, urlencode, urlsplit
import uuid


VERSION = 1
XRAY_VERSION = "26.11.9"
DEFAULT_IMAGE = "ghcr.io/xtls/xray-core:" + XRAY_VERSION
DEFAULT_SNI = "www.microsoft.com"
FLOW = "xtls-rprx-vision"
FLOW_UDP = FLOW + "-udp443"
RU_DNS_HOST = "common.dot.dns.yandex.net"
RU_DNS_IP = "77.88.8.8"


class SetupError(Exception):
    pass


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path, content, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise SetupError("Отказ от записи через символическую ссылку: " + str(path))
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def public_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value.strip())
    except ipaddress.AddressValueError:
        raise SetupError("Укажите внешний IPv4, например 1.2.3.4.") from None
    if not address.is_global or address.is_multicast or address.is_reserved:
        raise SetupError("Нужен публичный IPv4, а не локальный или служебный адрес.")
    return str(address)


def port_number(value):
    try:
        port = int(str(value))
    except ValueError:
        raise SetupError("Порт должен быть числом от 1 до 65535.") from None
    if not 1 <= port <= 65535:
        raise SetupError("Порт должен быть числом от 1 до 65535.")
    return port


def domain_name(value):
    value = value.strip().rstrip(".").lower()
    if len(value) > 253 or "." not in value:
        raise SetupError("Укажите DNS-имя сайта без https:// и без пути.")
    try:
        value = value.encode("idna").decode("ascii")
    except UnicodeError:
        raise SetupError("Некорректное DNS-имя.") from None
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
           for part in value.split(".")):
        raise SetupError("Некорректное DNS-имя.")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise SetupError("SNI должен быть DNS-именем сайта.")


def key_value(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise SetupError("REALITY-ключ должен содержать 43 символа base64url.")
    try:
        raw = base64.urlsafe_b64decode(value + "=")
    except ValueError:
        raise SetupError("Некорректный REALITY-ключ.") from None
    if len(raw) != 32 or raw == b"\0" * 32:
        raise SetupError("Некорректный REALITY-ключ.")
    if base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != value:
        raise SetupError("Неканонический REALITY-ключ.")
    return value


def user_name(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", value):
        raise SetupError("Имя: 1–64 символа, латиница, цифры, точка, дефис или _. Первый символ — буква или цифра.")
    return value


def normalized_uuid(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise SetupError("Некорректный UUID VLESS.") from None


def parse_vless_link(link):
    """Accept a single explicit VLESS+REALITY TCP/Vision hop, never shell code."""
    link = link.strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in link):
        raise SetupError("VLESS-ссылка должна занимать одну строку.")
    try:
        parsed = urlsplit(link)
        port = parsed.port
    except ValueError:
        raise SetupError("Некорректная VLESS-ссылка.") from None
    if parsed.scheme != "vless" or parsed.password is not None or not parsed.username:
        raise SetupError("Нужна ссылка vless:// из install_arm.sh.")
    if parsed.path not in ("", "/") or not parsed.hostname or port is None:
        raise SetupError("В ссылке должны быть адрес и порт армянского VPS.")
    allowed = {"type", "security", "encryption", "flow", "sni", "fp", "pbk", "sid", "spx", "headerType"}
    query = parse_qs(parsed.query, keep_blank_values=True)
    if set(query) - allowed or any(len(values) != 1 for values in query.values()):
        raise SetupError("Ссылка содержит неизвестные или повторяющиеся параметры; используйте вывод install_arm.sh.")
    fields = {key: values[0] for key, values in query.items()}
    if (fields.get("type") not in ("tcp", "raw") or fields.get("security") != "reality"
            or fields.get("encryption", "none") != "none" or fields.get("flow") not in (FLOW, FLOW_UDP)
            or fields.get("headerType", "none") != "none" or fields.get("spx", "/") != "/"):
        raise SetupError("Нужна VLESS + REALITY + TCP + Vision ссылка без дополнительных транспортов.")
    short_id = fields.get("sid", "")
    if not re.fullmatch(r"(?:[0-9a-fA-F]{2}){1,8}", short_id):
        raise SetupError("Некорректный shortId REALITY.")
    fingerprint = fields.get("fp", "chrome")
    if fingerprint not in ("chrome", "firefox", "safari"):
        raise SetupError("Поддерживаются fingerprint chrome, firefox или safari.")
    return {
        "host": public_ipv4(parsed.hostname), "port": port_number(port),
        "uuid": normalized_uuid(parsed.username), "sni": domain_name(fields.get("sni", "")),
        "public_key": key_value(fields.get("pbk", "")), "short_id": short_id.lower(),
        "fingerprint": fingerprint,
    }


def endpoint(state):
    return {
        "host": state["host"], "port": state["port"], "sni": state["sni"],
        "public_key": state["public_key"], "short_id": state["short_id"], "fingerprint": "chrome",
    }


def make_vless_link(remote, credential, name):
    parameters = {
        "encryption": "none", "security": "reality", "type": "tcp", "flow": FLOW,
        "sni": remote["sni"], "fp": remote.get("fingerprint", "chrome"),
        "pbk": remote["public_key"], "sid": remote["short_id"],
    }
    return "vless://{}@{}:{}?{}#{}".format(
        credential, remote["host"], remote["port"], urlencode(parameters), quote(name, safe=""))


def make_proxy_outbound(remote, credential=None, tag="proxy", allow_quic=True):
    return {
        "tag": tag, "protocol": "vless", "targetStrategy": "ForceIPv4",
        "settings": {"address": remote["host"], "port": remote["port"],
                     "id": credential or remote["uuid"], "encryption": "none",
                     "flow": FLOW_UDP if allow_quic else FLOW},
        "streamSettings": {"method": "raw", "security": "reality", "realitySettings": {
            "serverName": remote["sni"], "fingerprint": remote.get("fingerprint", "chrome"),
            "password": remote["public_key"], "shortId": remote["short_id"],
        }},
    }


def make_client_config(remote, credential):
    outbound = make_proxy_outbound(remote, credential, allow_quic=False)
    # Leave target names for the RU server; the local SOCKS client can use remote DNS.
    outbound["targetStrategy"] = "AsIs"
    return {"log": {"loglevel": "warning"}, "inbounds": [{
        "tag": "local-socks", "listen": "127.0.0.1", "port": 10808,
        "protocol": "socks", "settings": {"auth": "noauth", "udp": True},
        "sniffing": {"enabled": False},
    }], "outbounds": [outbound]}


def make_config(state):
    arm = state["role"] == "arm"
    inbound_tag = "from-ru" if arm else "clients-in"
    users = ([{"name": "ru-uplink", "uuid": state["service_uuid"]}] if arm else state["users"])
    config = {
        "log": {"loglevel": "warning"},
        "inbounds": [{
            "tag": inbound_tag, "listen": "0.0.0.0", "port": state["port"], "protocol": "vless",
            "settings": {"decryption": "none", "users": [
                {"id": user["uuid"], "email": user["name"] + "@vless.local", "flow": FLOW}
                for user in users]},
            "streamSettings": {"method": "raw", "security": "reality", "realitySettings": {
                "show": False, "target": state["sni"] + ":443", "xver": 0,
                "serverNames": [state["sni"]], "privateKey": state["private_key"],
                "shortIds": [state["short_id"]],
            }}, "sniffing": {"enabled": False},
        }],
    }
    block = {"tag": "block", "protocol": "blackhole", "settings": {}}
    direct = {"tag": "direct", "protocol": "freedom", "settings": {
        "finalRules": [{"action": "block", "ip": ["geoip:private"]}]},
        "streamSettings": {"sockopt": {"domainStrategy": "ForceIPv4"}}}
    if arm:
        config["dns"] = {"servers": ["https+local://1.1.1.1/dns-query"], "queryStrategy": "UseIPv4"}
        config["outbounds"] = [block, direct]
        config["routing"] = {"domainStrategy": "IPOnDemand", "rules": [
            {"type": "field", "ip": ["geoip:private"], "outboundTag": "block"},
            {"type": "field", "inboundTag": [inbound_tag], "sourceIP": [state["ru_ip"] + "/32"],
             "network": "tcp,udp", "outboundTag": "direct"},
            {"type": "field", "network": "tcp,udp", "outboundTag": "block"},
        ]}
    else:
        # The Russian resolver only supplies RU addresses. Other names are resolved
        # over the Armenian link, so the DNS path also respects the egress policy.
        config["dns"] = {
            "hosts": {RU_DNS_HOST: RU_DNS_IP},
            "servers": [
                {"address": "https://" + RU_DNS_HOST + "/dns-query", "expectedIPs": ["geoip:ru"]},
                {"address": "https://1.1.1.1/dns-query"},
            ], "queryStrategy": "UseIPv4", "enableParallelQuery": False,
            "disableCache": False, "tag": "dns-internal",
        }
        # Enforce the selected country at the final direct egress as well, even
        # if a DNS answer changes between routing and establishing the connection.
        direct["settings"]["finalRules"].extend([
            {"action": "allow", "ip": ["geoip:ru"]},
            {"action": "block", "network": "tcp,udp"},
        ])
        config["outbounds"] = [make_proxy_outbound(state["armenia"], tag="armenia"), direct, block]
        config["routing"] = {"domainStrategy": "IPOnDemand", "rules": [
            {"type": "field", "inboundTag": ["dns-internal"], "domain": ["full:" + RU_DNS_HOST],
             "outboundTag": "direct"},
            {"type": "field", "inboundTag": ["dns-internal"], "ip": [RU_DNS_IP + "/32"],
             "outboundTag": "direct"},
            {"type": "field", "inboundTag": ["dns-internal"], "outboundTag": "armenia"},
            {"type": "field", "ip": ["geoip:private"], "outboundTag": "block"},
            {"type": "field", "inboundTag": [inbound_tag], "ip": ["geoip:ru"], "outboundTag": "direct"},
            {"type": "field", "network": "tcp,udp", "outboundTag": "armenia"},
        ]}
    return config


def add_user(state, name):
    name = user_name(name)
    if state["role"] != "ru":
        raise SetupError("Пользователи добавляются только на российском узле.")
    if any(user["name"].casefold() == name.casefold() for user in state["users"]):
        raise SetupError("Пользователь с таким именем уже существует.")
    result = copy.deepcopy(state)
    result["users"].append({"name": name, "uuid": str(uuid.uuid4()), "created_at": now()})
    return result


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def compose_text(state):
    # Fixed names and JSON-quoted values avoid YAML/shell interpolation of inputs.
    return """services:
  xray:
    image: {image}
    pull_policy: never
    user: "0:0"
    network_mode: host
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    security_opt: ["no-new-privileges:true"]
    volumes:
      - ./runtime:/usr/local/etc/xray:ro
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    command: ["run", "-config", "/usr/local/etc/xray/config.json"]
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
""".format(image=json.dumps(state["image"]))


def run_command(arguments, timeout=120):
    try:
        result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise SetupError("Команда не завершилась вовремя: " + " ".join(arguments[:3])) from None
    except OSError as error:
        raise SetupError("Не удалось запустить команду: " + str(error)) from None
    if result.returncode:
        # Never print a command containing a private key; our commands contain none.
        raise SetupError("Ошибка команды {}:\n{}".format(" ".join(arguments[:4]), result.stdout[-6000:]))
    return result.stdout.strip()


class Deployment:
    def __init__(self, root, role, installer=None):
        self.root = Path(root)
        self.role = role
        self.project = "vless-" + role
        self.installer = Path(installer).resolve() if installer else None

    @contextlib.contextmanager
    def locked(self):
        if self.root.is_symlink():
            raise SetupError("Каталог установки не должен быть символической ссылкой.")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.stat().st_uid != os.geteuid():
            raise SetupError("Каталог установки принадлежит другому пользователю.")
        self.root.chmod(0o700)
        lock_path = self.root / ".lock"
        fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SetupError("Другой экземпляр установщика уже работает.") from None
            for name in ("runtime", "clients", "backups", "pending", "state.json", "compose.yaml"):
                if (self.root / name).is_symlink():
                    raise SetupError("Обнаружена символическая ссылка: " + name)
            self.recover()
            yield self
        finally:
            os.close(fd)

    def compose(self, *arguments):
        return run_command(["docker", "compose", "--project-directory", str(self.root),
                            "-p", self.project, "-f", str(self.root / "compose.yaml"), *arguments])

    def load_state(self):
        path = self.root / "state.json"
        if not path.exists():
            return None
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            raise SetupError("Не удалось прочитать state.json. Восстановите его из каталога backups.") from None
        if not isinstance(state, dict) or state.get("version") != VERSION or state.get("role") != self.role:
            raise SetupError("Несовместимый state.json или неверная роль сервера.")
        return state

    def validate(self, state, directory):
        run_command([
            "docker", "run", "--rm", "--pull=never", "--network=none", "--read-only",
            "--user=0:0", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
            "--mount", "type=bind,src={},dst=/usr/local/etc/xray,readonly".format(directory),
            state["image"], "run", "-test", "-config", "/usr/local/etc/xray/config.json",
        ])

    def activate(self):
        self.compose("config", "--quiet")
        self.compose("up", "-d", "--no-deps", "xray")
        # Directory contents changing does not recreate a Compose container.
        self.compose("restart", "xray")
        container = self.compose("ps", "-a", "-q", "xray")
        if not container or "\n" in container:
            raise SetupError("Контейнер Xray не найден после запуска.")
        baseline = None
        for _ in range(3):
            time.sleep(1)
            status = run_command(["docker", "inspect", "--format",
                                  "{{.State.Status}} {{.RestartCount}}", container])
            fields = status.split()
            if len(fields) != 2 or fields[0] != "running" or not fields[1].isdigit():
                raise SetupError("Xray не запустился устойчиво: " + status + ". Проверьте docker compose logs.")
            if baseline is None:
                baseline = fields[1]
            elif fields[1] != baseline:
                raise SetupError("Xray перезапускается после запуска. Проверьте docker compose logs.")

    def keypair(self, image):
        output = run_command(["docker", "run", "--rm", "--pull=never", "--network=none",
                              "--read-only", "--cap-drop=ALL", image, "x25519"])
        private = re.search(r"(?m)^PrivateKey:\s*(\S+)\s*$", output)
        public = re.search(r"(?m)^(?:Password(?:\s*\(PublicKey\))?|PublicKey):\s*(\S+)\s*$", output)
        if not private or not public:
            raise SetupError("Не удалось прочитать вывод xray x25519 для закреплённой версии.")
        return key_value(private.group(1)), key_value(public.group(1))

    def pull_image(self):
        print("Скачиваю официальный Xray " + XRAY_VERSION + "…", flush=True)
        run_command(["docker", "pull", DEFAULT_IMAGE], timeout=600)
        digests = json.loads(run_command(["docker", "image", "inspect", DEFAULT_IMAGE,
                                          "--format", "{{json .RepoDigests}}"] ))
        for digest in digests or []:
            if re.fullmatch(r"ghcr\.io/xtls/xray-core@sha256:[0-9a-f]{64}", digest):
                return digest
        raise SetupError("Docker не вернул digest официального образа; установка остановлена.")

    def test_uplink(self, remote, image):
        """Test the actual UUID/REALITY hop using a disposable localhost SOCKS proxy."""
        with tempfile.TemporaryDirectory(prefix=".uplink-", dir=str(self.root)) as temporary:
            folder = Path(temporary)
            config = make_client_config(remote, remote["uuid"])
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            config["inbounds"][0]["port"] = port
            atomic_write(folder / "config.json", json_bytes(config))
            self.validate({"image": image}, folder)
            name = "vless-uplink-test-" + secrets.token_hex(6)
            started = False
            print("Проверяю VLESS/REALITY и выход через Армению…", flush=True)
            try:
                run_command([
                    "docker", "run", "-d", "--rm", "--pull=never", "--name", name,
                    "--network=host", "--read-only", "--user=0:0", "--cap-drop=ALL",
                    "--security-opt=no-new-privileges:true", "--mount",
                    "type=bind,src={},dst=/usr/local/etc/xray,readonly".format(folder),
                    image, "run", "-config", "/usr/local/etc/xray/config.json",
                ])
                started = True
                for attempt in range(20):
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.2)
                else:
                    raise SetupError("Тестовый SOCKS-прокси не открыл локальный порт.")
                actual = run_command([
                    "curl", "--fail", "--silent", "--show-error", "--connect-timeout", "10",
                    "--max-time", "30", "--noproxy", "", "--socks5-hostname", "127.0.0.1:" + str(port),
                    "https://api.ipify.org",
                ], timeout=40)
                actual = public_ipv4(actual)
                print("Армянский VLESS-канал работает. Внешний IPv4: " + actual)
                if actual != remote["host"]:
                    print("Входящий и исходящий IPv4 армянского VPS различаются; проверьте NAT/адреса у провайдера.")
            except SetupError as error:
                raise SetupError("Проверка армянского канала не прошла. Проверьте ссылку, разрешённый RU IPv4, "
                                 "firewall и доступность api.ipify.org из Армении.\n" + str(error)) from error
            finally:
                if started:
                    run_command(["docker", "rm", "-f", name])

    def apply_state(self, state):
        """Validate first, journal+backup, atomically replace, restart, rollback on failure."""
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name in ("runtime", "clients", "backups"):
            (self.root / name).mkdir(mode=0o700, exist_ok=True)
        if not (self.root / "state.json").exists() and any(
                (self.root / name).exists() for name in ("compose.yaml", "runtime/config.json")):
            raise SetupError("Найдены конфиги без state.json. Отказ от перезаписи существующей установки.")
        with tempfile.TemporaryDirectory(prefix=".candidate-", dir=str(self.root)) as temporary:
            candidate = Path(temporary)
            atomic_write(candidate / "config.json", json_bytes(make_config(state)))
            self.validate(state, candidate)
        pending = self.root / "pending"
        pending.mkdir(mode=0o700)
        paths = ("state.json", "compose.yaml", "runtime/config.json")
        manifest = []
        for name in paths:
            path = self.root / name
            if path.exists():
                backup = pending / name.replace("/", "__")
                atomic_write(backup, path.read_bytes())
                manifest.append(name)
        # The journal is durable before any live file is replaced.
        atomic_write(pending / "manifest.json", json_bytes(manifest))
        sync_directory(self.root)
        try:
            atomic_write(self.root / "runtime/config.json", json_bytes(make_config(state)))
            atomic_write(self.root / "compose.yaml", compose_text(state).encode("utf-8"))
            atomic_write(self.root / "state.json", json_bytes(state))
            self.activate()
        except BaseException as error:
            try:
                self.rollback_pending()
            except Exception as recovery_error:
                raise SetupError("Не удалось применить конфиг и восстановить сервис. Журнал сохранён в {}.\n{}\n{}".format(
                    pending, error, recovery_error)) from error
            raise SetupError("Изменение отменено, предыдущие файлы восстановлены.\n" + str(error)) from error
        backup = self.root / "backups" / (datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                                          + "-" + secrets.token_hex(3))
        # Rename is also the commit marker. A leftover pending always means rollback.
        pending.rename(backup)
        sync_directory(self.root / "backups")
        sync_directory(self.root)
        self.export_profiles(state)
        if self.installer:
            destination = self.root / ("install_" + self.role + ".sh")
            if self.installer != destination:
                atomic_write(destination, self.installer.read_bytes(), 0o700)

    def rollback_pending(self):
        pending = self.root / "pending"
        manifest_path = pending / "manifest.json"
        if not manifest_path.exists():
            # No live files can have changed before this durable manifest exists.
            shutil.rmtree(pending)
            sync_directory(self.root)
            return
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        paths = ("state.json", "compose.yaml", "runtime/config.json")
        if not isinstance(manifest, list) or any(name not in paths for name in manifest):
            raise SetupError("Повреждён журнал pending/manifest.json.")
        if "state.json" not in manifest and (self.root / "compose.yaml").exists():
            self.compose("down")
        for name in paths:
            destination = self.root / name
            if name in manifest:
                atomic_write(destination, (pending / name.replace("/", "__")).read_bytes())
            elif destination.exists():
                destination.unlink()
        if "state.json" in manifest:
            self.activate()
        shutil.rmtree(pending)
        sync_directory(self.root)

    def recover(self):
        if (self.root / "pending").exists():
            print("Восстанавливаю незавершённое изменение по сохранённому журналу…")
            self.rollback_pending()

    def export_profiles(self, state):
        folder = self.root / "clients"
        folder.mkdir(mode=0o700, exist_ok=True)
        records = ([{"name": "ru-uplink", "uuid": state["service_uuid"]}]
                   if self.role == "arm" else state["users"])
        for user in records:
            name = user_name(user["name"])
            atomic_write(folder / (name + ".txt"),
                         (make_vless_link(endpoint(state), user["uuid"], name) + "\n").encode("utf-8"))
            atomic_write(folder / (name + ".json"), json_bytes(make_client_config(endpoint(state), user["uuid"])))

    def print_profile(self, state, name=None):
        self.export_profiles(state)
        records = ([{"name": "ru-uplink", "uuid": state["service_uuid"]}]
                   if self.role == "arm" else state["users"])
        for user in records:
            if name and user["name"] != name:
                continue
            print("\nПрофиль: " + user["name"])
            print(make_vless_link(endpoint(state), user["uuid"], user["name"]))
            print("Xray JSON: " + str(self.root / "clients" / (user["name"] + ".json")))
        if self.role == "arm":
            print("\nВставьте эту VLESS-ссылку в install_ru.sh при установке России.")
        print("Ссылки содержат секреты. Каталог установки доступен только root.")


def ask(prompt, validator=str, default=None):
    while True:
        suffix = " [{}]".format(default) if default is not None else ""
        try:
            value = input(prompt + suffix + ": ").strip()
        except EOFError:
            raise SetupError("Ввод завершён. Запустите сохранённый .sh в интерактивном терминале.") from None
        if not value and default is not None:
            value = str(default)
        try:
            return validator(value)
        except SetupError as error:
            print(str(error), file=sys.stderr)


def check_port(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        try:
            server.bind(("0.0.0.0", port))
        except OSError:
            raise SetupError("TCP-порт {} уже занят. Выберите другой порт или освободите его.".format(port)) from None


def check_target(sni):
    print("Проверяю доступность REALITY target и TLS 1.3: " + sni + "…", flush=True)
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.set_alpn_protocols(["h2", "http/1.1"])
    try:
        with socket.create_connection((sni, 443), timeout=10) as raw:
            with context.wrap_socket(raw, server_hostname=sni) as secured:
                if secured.version() != "TLSv1.3":
                    raise SetupError("REALITY target должен поддерживать TLS 1.3.")
    except (OSError, ssl.SSLError) as error:
        raise SetupError("Не удалось проверить TLS 1.3 у {}: {}. Повторите установку с доступным SNI.".format(sni, error)) from None


def install(deployment):
    previous = deployment.load_state()
    if previous:
        print("Узел уже установлен. Использую сохранённые ключи и пользователей.")
        deployment.apply_state(previous)
        deployment.print_profile(previous)
        return
    role = deployment.role
    print("\nУстановка " + ("армянского выходного" if role == "arm" else "российского входного") + " узла.")
    host = ask("Публичный IPv4 этого VPS", public_ipv4)
    port = ask("Входящий TCP-порт", port_number, 443)
    sni = ask("SNI/target для REALITY (сайт с TLS 1.3)", domain_name, DEFAULT_SNI)
    state = {"version": VERSION, "role": role, "host": host, "port": port, "sni": sni, "created_at": now()}
    if role == "arm":
        state["ru_ip"] = ask("Публичный IPv4 российского VPS (разрешённый источник)", public_ipv4)
        if state["ru_ip"] == host:
            raise SetupError("Россия и Армения должны иметь разные публичные IPv4.")
        state["service_uuid"] = str(uuid.uuid4())
    else:
        state["armenia"] = ask("VLESS-ссылка из install_arm.sh", parse_vless_link)
        if state["armenia"]["host"] == host:
            raise SetupError("Армянский выход не должен указывать на этот же российский VPS.")
        name = ask("Имя первого пользователя (латиница)", user_name, "user1")
        state["users"] = [{"name": name, "uuid": str(uuid.uuid4()), "created_at": now()}]
    check_port(port)
    check_target(sni)
    if role == "ru":
        remote = state["armenia"]
        try:
            with socket.create_connection((remote["host"], remote["port"]), timeout=10):
                pass
        except OSError as error:
            raise SetupError("Армянский TCP-порт недоступен: " + str(error)) from None
        print("TCP-порт Армении доступен; это ещё не проверка UUID/REALITY или выхода в интернет.")
    state["image"] = deployment.pull_image()
    if role == "ru":
        deployment.test_uplink(state["armenia"], state["image"])
    state["private_key"], state["public_key"] = deployment.keypair(state["image"])
    state["short_id"] = secrets.token_hex(8)
    deployment.apply_state(state)
    print("\nXray запущен. Откройте TCP/{} в firewall VPS/провайдера.".format(port))
    if role == "arm":
        print("Для Армении разрешите этот порт только с IPv4 " + state["ru_ip"] + ".")
    print("Управление: sudo bash " + str(deployment.root / ("install_" + role + ".sh")))
    deployment.print_profile(state)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", required=True, choices=("arm", "ru"))
    parser.add_argument("--installer", required=True)
    arguments = parser.parse_args(argv)
    deployment = Deployment("/opt/vless-" + arguments.role, arguments.role, arguments.installer)
    if arguments.role == "arm":
        with deployment.locked():
            install(deployment)
        return 0
    print("\nРоссийский VLESS → Россия / Армения")
    print("1 — Установить / восстановить запуск существующего узла")
    print("2 — Создать пользователя")
    print("3 — Показать ранее созданные конфиги")
    print("0 — Выход")
    choice = ask("Выберите действие", default="0")
    if choice == "0":
        return 0
    if choice not in ("1", "2", "3"):
        raise SetupError("Неизвестный пункт меню.")
    with deployment.locked():
        if choice == "1":
            install(deployment)
        else:
            state = deployment.load_state()
            if state is None:
                raise SetupError("Сначала выполните пункт 1 — установить.")
            if choice == "2":
                name = ask("Имя нового пользователя (латиница)", user_name)
                updated = add_user(state, name)
                print("Проверяю конфиг. Применение кратковременно перезапустит Xray…", flush=True)
                deployment.apply_state(updated)
                deployment.print_profile(updated, name)
            else:
                deployment.print_profile(state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SetupError, OSError, ValueError, KeyError) as error:
        print("\nОшибка: " + str(error), file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        print("\nОперация прервана.", file=sys.stderr)
        raise SystemExit(130)
__VPN_CASCADE_PYTHON_EOF__
python3 -B "$RUNTIME" --role "$ROLE" --installer "$INSTALLER" "$@"
