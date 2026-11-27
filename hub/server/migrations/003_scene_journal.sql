CREATE TABLE IF NOT EXISTS hub_scene_runs (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_scene_runs_recent ON hub_scene_runs (started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS hub_scene_runs_running ON hub_scene_runs (id)
  WHERE data->>'status' = 'running';
CREATE TABLE IF NOT EXISTS hub_scene_journal_migrations (
  name text PRIMARY KEY
);
