#!/usr/bin/env bash
# Generated standalone installer; edit src/bootstrap.sh and src/cascade.py,
# then run build_installers.py to rebuild install_arm.sh and install_ru.sh.
set -Eeuo pipefail
umask 077

ROLE='@ROLE@'
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
@PYTHON_PAYLOAD@
__VPN_CASCADE_PYTHON_EOF__
python3 -B "$RUNTIME" --role "$ROLE" --installer "$INSTALLER" "$@"
