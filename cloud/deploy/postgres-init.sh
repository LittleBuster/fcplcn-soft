#!/bin/sh
# Runs once, only when PostgreSQL creates an empty database volume.
set -eu
app_password=$(cat /run/fcplcn/postgres/app-password)
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$app_password" <<'SQL'
CREATE ROLE fcplcn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER DATABASE fcplcn OWNER TO fcplcn_app;
REVOKE ALL ON DATABASE fcplcn FROM PUBLIC;
GRANT CONNECT ON DATABASE fcplcn TO fcplcn_app;
ALTER SCHEMA public OWNER TO fcplcn_app;
SQL
unset app_password
