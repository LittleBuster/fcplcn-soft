CREATE TABLE IF NOT EXISTS cloud_users (
  id uuid PRIMARY KEY, email text UNIQUE, username text NOT NULL, name text NOT NULL,
  password_hash text NOT NULL, totp_secret text, totp_pending text,
  recovery_hashes jsonb NOT NULL DEFAULT '[]', auth_version integer NOT NULL DEFAULT 1,
  default_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cloud_users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE cloud_users ADD COLUMN IF NOT EXISTS username text;
UPDATE cloud_users SET username=coalesce(email,'user-' || id::text) WHERE username IS NULL;
ALTER TABLE cloud_users ALTER COLUMN username SET NOT NULL;
ALTER TABLE cloud_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE cloud_users ADD COLUMN IF NOT EXISTS default_admin boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_username_unique ON cloud_users(lower(username));
CREATE TABLE IF NOT EXISTS cloud_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_sessions_expiry ON cloud_sessions(expires_at);
CREATE TABLE IF NOT EXISTS cloud_homes (
  id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_members (
  home_id uuid NOT NULL REFERENCES cloud_homes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','operator','viewer')),
  security_control boolean NOT NULL DEFAULT false,
  PRIMARY KEY(home_id,user_id)
);
CREATE TABLE IF NOT EXISTS cloud_invites (
  token_hash text PRIMARY KEY, home_id uuid NOT NULL REFERENCES cloud_homes(id) ON DELETE CASCADE,
  email text, role text NOT NULL CHECK (role IN ('owner','operator','viewer')),
  security_control boolean NOT NULL DEFAULT false, created_by uuid NOT NULL REFERENCES cloud_users(id),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_pair_codes (
  code_hash text PRIMARY KEY, home_id uuid NOT NULL REFERENCES cloud_homes(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES cloud_users(id), expires_at timestamptz NOT NULL,
  used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_hubs (
  id uuid PRIMARY KEY, home_id uuid NOT NULL REFERENCES cloud_homes(id) ON DELETE CASCADE,
  name text NOT NULL, installation_id text NOT NULL, public_key text, broker_secret_hash text,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz, snapshot jsonb, snapshot_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_active_hub ON cloud_hubs(home_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_installation_active ON cloud_hubs(installation_id) WHERE revoked_at IS NULL;
ALTER TABLE cloud_hubs ADD COLUMN IF NOT EXISTS broker_secret_hash text;
CREATE TABLE IF NOT EXISTS cloud_audit (
  id uuid PRIMARY KEY, home_id uuid NOT NULL REFERENCES cloud_homes(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES cloud_users(id) ON DELETE SET NULL, operation text NOT NULL,
  target text NOT NULL, status text NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_audit_home_time ON cloud_audit(home_id,created_at DESC);
