#!/bin/sh
# Generate one user's hash without passing a password in process arguments.
# Run inside the broker-setup container; never replace the whole user database.
set -eu
umask 077

auth_dir="${FCPLCN_BROKER_AUTH_DIR:-/mosquitto/auth}"
hub_user="${FCPLCN_HUB_MQTT_USERNAME:-fcplcn-hub}"
operation="${1:-hub}"

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

valid_user() {
    case "$1" in
        ''|*[!A-Za-z0-9_-]*) return 1 ;;
    esac
    [ "${#1}" -le 64 ]
}

valid_user "$hub_user" || fail 'Use 1–64 ASCII letters, digits, underscores or hyphens for the hub MQTT username.'
case "$operation" in
    hub)
        username="$hub_user"
        password="${FCPLCN_HUB_MQTT_PASSWORD:-}"
        ;;
    plc)
        username="${FCPLCN_PLC_ID:-}"
        password="${FCPLCN_PLC_PASSWORD:-}"
        valid_user "$username" || fail 'Set FCPLCN_PLC_ID to the PLC deviceId.'
        [ "$username" != "$hub_user" ] || fail 'The PLC and hub must have different usernames.'
        [ -f "$auth_dir/acl" ] || fail 'Initialize the hub account before adding PLC accounts.'
        ;;
    *) fail 'Usage: setup-broker.sh hub|plc' ;;
esac

[ "${#password}" -ge 8 ] || fail 'Set an MQTT password with at least 8 characters.'
carriage_return="$(printf '\r')"
case "$password" in
    *'
'*|*"$carriage_return"*) fail 'MQTT passwords cannot contain line breaks.' ;;
esac

mkdir -p "$auth_dir"
chmod 750 "$auth_dir"
chown 1883:1883 "$auth_dir"
mkdir "$auth_dir/.setup-lock" || fail 'Another broker account setup is running; retry after it finishes.'
hash_file=""
next_file=""
acl_file=""
cleanup() {
    rm -f "$hash_file" "$next_file" ${acl_file:+"$acl_file"}
    rmdir "$auth_dir/.setup-lock" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
hash_file="$(mktemp "$auth_dir/.hash.XXXXXX")"
next_file="$(mktemp "$auth_dir/.passwords.XXXXXX")"

# -U only sees this new plaintext entry, never previously hashed database rows.
printf '%s:%s\n' "$username" "$password" > "$hash_file"
unset password
mosquitto_passwd -H sha512-pbkdf2 -U "$hash_file"
if [ -f "$auth_dir/passwords" ]; then
    awk -F: -v name="$username" '$1 != name { print }' "$auth_dir/passwords" > "$next_file"
fi
cat "$hash_file" >> "$next_file"
chmod 640 "$next_file"
chown 1883:1883 "$next_file"
mv "$next_file" "$auth_dir/passwords"

if [ "$operation" = hub ]; then
    acl_file="$(mktemp "$auth_dir/.acl.XXXXXX")"
    cat > "$acl_file" <<EOF
# Each PLC publishes its own state and receives only its own commands.
pattern write fcplcn/%u/availability
pattern write fcplcn/%u/system/status
pattern write fcplcn/%u/controllers/+/status
pattern write fcplcn/%u/controllers/+/ack
pattern write fcplcn/%u/controllers/security/event
pattern write fcplcn/%u/management/reply
pattern write fcplcn/%u/irrigation-water/source
pattern write fcplcn/%u/irrigation-water/request
pattern read fcplcn/%u/controllers/+/set
pattern read fcplcn/%u/controllers/security/hub
pattern read fcplcn/%u/management/request
pattern read fcplcn/%u/irrigation-water/reply

# The single local hub coordinates all PLCs.
user $hub_user
topic read fcplcn/+/availability
topic read fcplcn/+/system/status
topic read fcplcn/+/controllers/+/status
topic read fcplcn/+/controllers/+/ack
topic read fcplcn/+/controllers/security/event
topic read fcplcn/+/management/reply
topic read fcplcn/+/irrigation-water/source
topic read fcplcn/+/irrigation-water/request
topic write fcplcn/+/controllers/+/set
topic write fcplcn/+/controllers/security/hub
topic write fcplcn/+/management/request
topic write fcplcn/+/irrigation-water/reply
EOF
    chmod 640 "$acl_file"
    chown 1883:1883 "$acl_file"
    mv "$acl_file" "$auth_dir/acl"
fi
printf 'MQTT account ready: %s. Restart the broker if it is already running.\n' "$username"
