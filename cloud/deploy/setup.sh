#!/bin/sh
# Bootstrap private Docker volumes without requiring Node.js or OpenSSL on the host.
set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project=${FCPLCN_PROJECT:-fcplcn-cloud}
runtime=${FCPLCN_RUNTIME_DIR:-"$script_dir/runtime"}
case "$project" in
  ''|*[!a-z0-9_-]*) printf '%s\n' 'FCPLCN_PROJECT must contain lowercase letters, digits, _ or -.' >&2; exit 1 ;;
esac
case "$project" in
  [a-z0-9]*) ;;
  *) printf '%s\n' 'FCPLCN_PROJECT must start with a letter or digit.' >&2; exit 1 ;;
esac
if [ "${#project}" -gt 40 ]; then
  printf '%s\n' 'FCPLCN_PROJECT is too long.' >&2
  exit 1
fi
mode=setup
renew=0
domain=${FCPLCN_DOMAIN:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --renew-cert) renew=1 ;;
    --show-setup-key) mode=show-key ;;
    --help|-h)
      printf '%s\n' 'Usage: cloud/deploy/setup.sh cloud.example.com [--renew-cert]' \
        '       cloud/deploy/setup.sh --show-setup-key' \
        'Optional: FCPLCN_PROJECT and FCPLCN_RUNTIME_DIR.'
      exit 0 ;;
    --*) printf '%s\n' 'Unknown setup option.' >&2; exit 1 ;;
    *)
      if [ -n "$domain" ] && [ "$domain" != "$1" ]; then
        printf '%s\n' 'Specify one public DNS name.' >&2; exit 1
      fi
      domain=$1 ;;
  esac
  shift
done
if [ "$mode" = setup ] && [ -z "$domain" ]; then
  printf '%s\n' 'Specify the public DNS name: cloud/deploy/setup.sh cloud.example.com' >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker with Compose is required.' >&2; exit 1; }
# The installer may use sudo for a root-owned Linux daemon. Preserve Desktop and
# rootless contexts by using the caller's Docker access mode by default.
docker_cmd() {
  if [ "${FCPLCN_DOCKER_SUDO:-0}" = 1 ]; then
    command sudo --preserve-env=DOCKER_HOST,DOCKER_CONTEXT,DOCKER_CONFIG docker "$@"
  else
    command docker "$@"
  fi
}
docker_cmd compose version >/dev/null
mkdir -p "$runtime"
chmod 700 "$runtime"
runtime=$(CDPATH= cd -- "$runtime" && pwd)
image="$project-setup:local"
docker_cmd build --quiet -t "$image" -f "$script_dir/Setup.Dockerfile" "$script_dir" >/dev/null
if [ "$mode" = show-key ]; then
  docker_cmd volume inspect "${project}_private" >/dev/null
  docker_cmd run --rm --user 0:0 --network none \
    -v "${project}_private:/state/private:ro" \
    "$image" --show-setup-key
  exit 0
fi
for volume in private broker cloud; do
  docker_cmd volume create "${project}_$volume" >/dev/null
done
docker_cmd run --rm --user 0:0 --network none \
  -e "FCPLCN_SETUP_DOMAIN=$domain" -e "FCPLCN_SETUP_PROJECT=$project" \
  -e "FCPLCN_SETUP_UID=$(id -u)" -e "FCPLCN_SETUP_GID=$(id -g)" \
  -e "FCPLCN_SETUP_RENEW=$renew" \
  -v "${project}_private:/state/private" \
  -v "${project}_broker:/state/broker" \
  -v "${project}_cloud:/state/cloud" \
  -v "$runtime:/state/host" \
  "$image"
printf '%s\n' 'FCPLCn deployment prepared. No passwords were printed.' \
  "Compose environment: $runtime/.env" \
  'Next: docker compose --env-file cloud/deploy/runtime/.env -f cloud/deploy/compose.yaml up -d --build' \
  'Initial login: admin; password: empty. Edit the account in the web profile.'
