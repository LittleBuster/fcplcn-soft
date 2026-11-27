#!/bin/sh
# Give the application an ordinary login that only owns its own database.
set -eu

psql --no-psqlrc --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password FCPLCN_HUB_DATABASE_PASSWORD
BEGIN;
CREATE ROLE fcplcn_hub LOGIN PASSWORD :'app_password';
REVOKE CONNECT ON DATABASE fcplcn_hub FROM PUBLIC;
ALTER DATABASE fcplcn_hub OWNER TO fcplcn_hub;
COMMIT;
SQL
