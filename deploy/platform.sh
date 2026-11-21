#!/usr/bin/env bash
# Shared platform checks. Sourcing this file never installs or starts anything.

fcplcn_platform_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$fcplcn_platform_dir/platform/linux.sh"
. "$fcplcn_platform_dir/platform/macos.sh"

fcplcn_note() { printf '%s\n' "$*"; }
fcplcn_fail() { printf 'FCPLCn: %s\n' "$*" >&2; return 1; }

fcplcn_os_value() {
    # Parse os-release as data; do not execute a derivative's shell contents.
    awk -v key="$1" 'index($0,key "=")==1 {
        value=substr($0,length(key)+2); gsub(/^"|"$/, "", value);
        gsub(/^\047|\047$/, "", value); print value; exit
    }' "${FCPLCN_OS_RELEASE_FILE:-/etc/os-release}"
}

fcplcn_detect_linux_base() {
    [ -r "${FCPLCN_OS_RELEASE_FILE:-/etc/os-release}" ] ||
        { fcplcn_fail 'Не найден /etc/os-release.'; return 1; }
    local identity related
    identity=$(fcplcn_os_value ID)
    related=" $(fcplcn_os_value ID_LIKE) "
    case "$identity:$related" in
        ubuntu:*|*:*' ubuntu '*) fcplcn_os_base=ubuntu ;;
        debian:*|*:*' debian '*) fcplcn_os_base=debian ;;
        *) fcplcn_fail 'Автоустановка поддерживает Debian и Armbian на базе Debian/Ubuntu.'; return 1 ;;
    esac
    fcplcn_os_codename=$(fcplcn_os_value VERSION_CODENAME)
    if [ "$fcplcn_os_base" = ubuntu ]; then
        local ubuntu_codename
        ubuntu_codename=$(fcplcn_os_value UBUNTU_CODENAME)
        [ -z "$ubuntu_codename" ] || fcplcn_os_codename=$ubuntu_codename
    fi
    case "$fcplcn_os_base:$fcplcn_os_codename" in
        debian:bookworm|debian:trixie|ubuntu:jammy|ubuntu:noble|ubuntu:resolute|ubuntu:stonking) ;;
        *) fcplcn_fail "Неподдерживаемая база ОС: $fcplcn_os_base / $fcplcn_os_codename. Используйте поддерживаемый стабильный образ Armbian."; return 1 ;;
    esac
}

fcplcn_detect_platform() {
    fcplcn_system=$(uname -s)
    fcplcn_arch=$(uname -m)
    fcplcn_os_base=
    fcplcn_os_codename=
    case "$fcplcn_system" in
        Linux)
            fcplcn_detect_linux_base || return 1
            if command -v dpkg >/dev/null 2>&1; then
                fcplcn_arch=$(dpkg --print-architecture)
            fi ;;
        Darwin)
            # A terminal launched through Rosetta still needs native arm64 images.
            if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ]; then
                fcplcn_arch=arm64
            fi ;;
        *) fcplcn_fail "Неподдерживаемая ОС: $fcplcn_system"; return 1 ;;
    esac
    case "$fcplcn_arch" in
        x86_64|amd64) FCPLCN_PLATFORM=linux/amd64 ;;
        arm64|aarch64) FCPLCN_PLATFORM=linux/arm64 ;;
        *) fcplcn_fail "Неподдерживаемая архитектура: $fcplcn_arch. Нужны 64-битные ОС и процессор (amd64/arm64)."; return 1 ;;
    esac
    export FCPLCN_PLATFORM
}

fcplcn_docker_cmd() {
    if [ "${FCPLCN_DOCKER_SUDO:-0}" = 1 ]; then
        command sudo --preserve-env=DOCKER_HOST,DOCKER_CONTEXT,DOCKER_CONFIG docker "$@"
    else
        command docker "$@"
    fi
}

fcplcn_require_local_docker() {
    local endpoint
    # Docker gives DOCKER_CONTEXT precedence over DOCKER_HOST.
    if [ -n "${DOCKER_CONTEXT:-}" ]; then
        endpoint=$(fcplcn_docker_cmd context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}') || return 1
    else
        endpoint=${DOCKER_HOST:-}
    fi
    if [ -z "${endpoint:-}" ]; then
        endpoint=$(fcplcn_docker_cmd context inspect --format '{{.Endpoints.docker.Host}}') || return 1
    fi
    case "$endpoint" in
        unix://*) ;;
        *) fcplcn_fail 'Выбран удалённый Docker context. Запускайте установщик на самом сервере с локальным Docker (unix://).'; return 1 ;;
    esac
}

fcplcn_check_compose() {
    local version major minor patch
    version=$(fcplcn_docker_cmd compose version --short) ||
        { fcplcn_fail 'Требуется Docker Compose plugin (docker compose).'; return 1; }
    version=${version#v}
    major=${version%%.*}
    version=${version#*.}
    minor=${version%%.*}
    patch=${version#*.}
    patch=${patch%%[-+]*}
    case "$major:$minor:$patch" in *[!0-9:]*|::*|*:|*::*)
        fcplcn_fail 'Не удалось определить версию Docker Compose.'; return 1 ;;
    esac
    if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] &&
        { [ "$minor" -lt 24 ] || { [ "$minor" -eq 24 ] && [ "$patch" -lt 4 ]; }; }; }; then
        fcplcn_fail 'Требуется Docker Compose >= 2.24.4. Обновите Docker Compose plugin / Docker Desktop.'
        return 1
    fi
}

fcplcn_find_python() {
    FCPLCN_PYTHON=
    local candidate
    for candidate in python3 /opt/homebrew/opt/python@3.12/bin/python3.12 \
        /usr/local/opt/python@3.12/bin/python3.12 /usr/local/bin/python3; do
        if command -v "$candidate" >/dev/null 2>&1 &&
            "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
            FCPLCN_PYTHON=$(command -v "$candidate")
            export FCPLCN_PYTHON
            return 0
        fi
    done
    return 1
}

fcplcn_select_docker_access() {
    FCPLCN_DOCKER_SUDO=0
    if docker info >/dev/null 2>&1; then
        export FCPLCN_DOCKER_SUDO
        return 0
    fi
    if [ "$fcplcn_system" = Linux ] && command -v sudo >/dev/null 2>&1 &&
        sudo --preserve-env=DOCKER_HOST,DOCKER_CONTEXT,DOCKER_CONFIG docker info >/dev/null 2>&1; then
        FCPLCN_DOCKER_SUDO=1
        export FCPLCN_DOCKER_SUDO
        return 0
    fi
    fcplcn_fail 'Docker недоступен. На Linux проверьте службу, cgroups и ядро Armbian; на Mac завершите первый запуск Docker Desktop.'
}

fcplcn_bootstrap() {
    local role action dry_run
    role=$1; action=$2; dry_run=$3
    PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"
    export PATH
    fcplcn_detect_platform || return 1
    FCPLCN_LOW_MEMORY=0
    if [ "$fcplcn_system" = Linux ] && [ -r /proc/meminfo ]; then
        local memory_mb
        memory_mb=$(awk '/^MemTotal:/ { print int($2 / 1024); exit }' /proc/meminfo)
        if [ -n "$memory_mb" ] && [ "$memory_mb" -lt 1536 ]; then
            FCPLCN_LOW_MEMORY=1
            fcplcn_note "Оперативная память: $memory_mb МБ. Используйте готовый образ из GitHub; локальная сборка требует явного --source-build."
        fi
    fi
    export FCPLCN_LOW_MEMORY
    fcplcn_note "FCPLCn: $role · $fcplcn_system $fcplcn_os_base $fcplcn_os_codename · $FCPLCN_PLATFORM"
    # Reject a remote engine before installing any local prerequisite. Bind
    # mounts and the private state directory must belong to this same machine.
    FCPLCN_DOCKER_SUDO=0
    export FCPLCN_DOCKER_SUDO
    if [ -n "${DOCKER_HOST:-}" ] || command -v docker >/dev/null 2>&1; then
        fcplcn_require_local_docker || return 1
    fi
    if [ "$dry_run" = 1 ]; then
        case "$fcplcn_system" in
            Linux) fcplcn_note 'План: проверить Python 3.10+, Git, Docker Engine и Compose; отсутствующие зависимости установить из apt и официального репозитория Docker.' ;;
            Darwin) fcplcn_note 'План: проверить Python, Git и Docker; при необходимости установить Homebrew и Docker Desktop. Первый запуск Desktop подтверждается в его окне.' ;;
        esac
        fcplcn_find_python || :
        return 0
    fi
    case "$action" in
        install|update)
            case "$fcplcn_system" in
                Linux) fcplcn_linux_dependencies || return 1 ;;
                Darwin) fcplcn_macos_dependencies || return 1 ;;
            esac ;;
    esac
    fcplcn_find_python || { fcplcn_fail 'Требуется Python 3.10+. Выполните install для установки зависимостей.'; return 1; }
    command -v docker >/dev/null 2>&1 || { fcplcn_fail 'Docker не установлен. Выполните install.'; return 1; }
    # doctor never triggers a sudo password prompt or starts a service.
    if [ "$action" = doctor ]; then
        docker info >/dev/null 2>&1 || { fcplcn_fail 'Docker недоступен текущему пользователю; проверьте службу или запустите doctor через sudo на Linux.'; return 1; }
        FCPLCN_DOCKER_SUDO=0; export FCPLCN_DOCKER_SUDO
    else
        fcplcn_select_docker_access || return 1
    fi
    fcplcn_require_local_docker || return 1
    fcplcn_check_compose || return 1
}
