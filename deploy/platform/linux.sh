#!/usr/bin/env bash
# Debian and Debian/Ubuntu based Armbian dependency installation.

fcplcn_root_cmd() {
    if [ "$(id -u)" = 0 ]; then command "$@"; else command sudo "$@"; fi
}

fcplcn_linux_start_docker() {
    if [ -d /run/systemd/system ]; then
        fcplcn_root_cmd systemctl enable --now docker
    elif command -v service >/dev/null 2>&1; then
        fcplcn_root_cmd service docker start
    else
        fcplcn_fail 'Не найден менеджер служб. Запустите Docker вручную и повторите установку.'
    fi
}

fcplcn_linux_dependencies() {
    local missing dependency architecture conflicts
    missing=0
    for dependency in curl git openssl tar; do
        command -v "$dependency" >/dev/null 2>&1 || missing=1
    done
    fcplcn_find_python || missing=1
    if [ "$missing" = 1 ] || ! command -v docker >/dev/null 2>&1; then
        if [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then
            fcplcn_fail 'Запустите install.sh от root или установите sudo.'; return 1
        fi
        fcplcn_note 'Устанавливаю системные зависимости через apt.'
        fcplcn_root_cmd apt-get update || return 1
        fcplcn_root_cmd apt-get install -y ca-certificates curl gnupg git openssl python3 tar || return 1
    fi
    if command -v docker >/dev/null 2>&1; then
        # Reuse a working Engine, including rootless and distribution packages.
        # Replacing somebody else's runtime could interrupt unrelated services.
        if ! docker info >/dev/null 2>&1; then
            if ! fcplcn_root_cmd docker info >/dev/null 2>&1; then
                fcplcn_linux_start_docker || return 1
            fi
        fi
        # Add/upgrade the Compose plugin only for official Docker CE. Replacing
        # a distribution or third-party runtime is an explicit admin decision.
        if ! fcplcn_check_compose >/dev/null 2>&1 &&
            [ "$(dpkg-query -W -f='${db:Status-Status}' docker-ce-cli 2>/dev/null || :)" = installed ]; then
            fcplcn_note 'Устанавливаю Docker Compose plugin для существующего Docker CE.'
            fcplcn_root_cmd apt-get update || return 1
            fcplcn_root_cmd apt-get install -y docker-compose-plugin docker-buildx-plugin || return 1
        fi
        return 0
    fi
    conflicts=$(dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' \
        docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc \
        2>/dev/null | awk '$2 == "installed" {print $1}' || :)
    if [ -n "$conflicts" ]; then
        fcplcn_fail "Найдены пакеты другого контейнерного движка: $conflicts. Установщик не удаляет их автоматически. Завершите переход на Docker Engine и повторите запуск."
        return 1
    fi
    architecture=$(dpkg --print-architecture)
    fcplcn_note "Устанавливаю Docker Engine и Compose: $fcplcn_os_base / $fcplcn_os_codename / $architecture."
    fcplcn_root_cmd install -m 0755 -d /etc/apt/keyrings || return 1
    fcplcn_root_cmd curl -fsSL "https://download.docker.com/linux/$fcplcn_os_base/gpg" \
        -o /etc/apt/keyrings/docker.asc || return 1
    fcplcn_root_cmd chmod a+r /etc/apt/keyrings/docker.asc || return 1
    # tee runs with privilege; all repository fields were selected from allowlists.
    fcplcn_root_cmd tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/$fcplcn_os_base
Suites: $fcplcn_os_codename
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    fcplcn_root_cmd apt-get update || return 1
    fcplcn_root_cmd apt-get install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin || return 1
    fcplcn_linux_start_docker
}
