#!/usr/bin/env bash
# FCPLCn update entry point. Compatible with macOS Bash 3.2.
set -euo pipefail
umask 077

fcplcn_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$fcplcn_source_dir/deploy/entrypoint.sh"

fcplcn_deployment_command update "обновление" "$@"
