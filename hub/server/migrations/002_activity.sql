CREATE TABLE IF NOT EXISTS hub_command_journal (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  entry jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_command_journal_recent ON hub_command_journal (created_at DESC);
CREATE INDEX IF NOT EXISTS hub_command_journal_pending ON hub_command_journal (id)
  WHERE entry->>'status' = 'pending';
CREATE INDEX IF NOT EXISTS hub_command_journal_scene_run ON hub_command_journal ((entry->>'sceneRunId'))
  WHERE entry->>'sceneRunId' IS NOT NULL;

CREATE TABLE IF NOT EXISTS hub_device_outages (
  id uuid PRIMARY KEY,
  offline_at timestamptz NOT NULL,
  online_at timestamptz,
  entry jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_device_outages_recent ON hub_device_outages (offline_at DESC);
CREATE INDEX IF NOT EXISTS hub_device_outages_open ON hub_device_outages (offline_at DESC)
  WHERE online_at IS NULL;
