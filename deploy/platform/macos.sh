#!/usr/bin/env bash
# Docker Desktop runs Linux containers natively on Apple Silicon, including M5.

fcplcn_macos_brew() {
    if command -v brew >/dev/null 2>&1; then return 0; fi
    if [ "$(id -u)" = 0 ]; then
        fcplcn_fail 'На macOS запускайте install.sh от обычного пользователя, без sudo.'
        return 1
    fi
    local brew_installer
    brew_installer=$(mktemp -t fcplcn-homebrew) || return 1
    if ! curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
        -o "$brew_installer"; then
        rm -f "$brew_installer"; return 1
    fi
    /bin/bash "$brew_installer"
    local result=$?
    rm -f "$brew_installer"
    return "$result"
}

fcplcn_macos_dependencies() {
    local need_brew attempts
    if [ "$(id -u)" = 0 ]; then
        fcplcn_fail 'На macOS запускайте install.sh от обычного пользователя, без sudo.'
        return 1
    fi
    need_brew=0
    fcplcn_find_python || need_brew=1
    command -v git >/dev/null 2>&1 || need_brew=1
    if ! command -v docker >/dev/null 2>&1 && [ ! -d /Applications/Docker.app ]; then
        need_brew=1
    fi
    if [ "$need_brew" = 1 ]; then
        if ! xcode-select -p >/dev/null 2>&1; then
            xcode-select --install || :
            fcplcn_fail 'Открыта установка Apple Command Line Tools. Завершите её в окне macOS и повторите install.sh.'
            return 1
        fi
        fcplcn_macos_brew || return 1
        fcplcn_find_python || brew install python@3.12 || return 1
        # The system git executable may be a Command Line Tools launcher.
        git --version >/dev/null 2>&1 || brew install git || return 1
        if ! command -v docker >/dev/null 2>&1 && [ ! -d /Applications/Docker.app ]; then
            brew install --cask docker-desktop || return 1
        fi
    fi
    if ! docker info >/dev/null 2>&1; then
        if [ ! -d /Applications/Docker.app ]; then
            fcplcn_fail 'Установленный Docker engine не запущен. Запустите его и повторите install.sh.'
            return 1
        fi
        open -a Docker || return 1
        fcplcn_note 'Запускается Docker Desktop. Если это первый запуск, завершите настройку в его окне. Условия Desktop принимаются пользователем.'
        attempts=0
        until docker info >/dev/null 2>&1; do
            attempts=$((attempts + 1))
            if [ "$attempts" -ge 60 ]; then
                fcplcn_fail 'Docker Desktop ещё не готов. Завершите первый запуск и повторите install.sh.'
                return 1
            fi
            [ $((attempts % 10)) -ne 0 ] || fcplcn_note 'Ожидаю готовности Docker Desktop…'
            sleep 3
        done
    fi
}
