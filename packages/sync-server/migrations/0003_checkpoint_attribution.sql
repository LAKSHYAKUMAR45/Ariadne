-- Ariadne sync server schema v3. Adds owner/workspace attribution to
-- checkpoints, mirroring the tasks.workspace_label + owner_user_id fields
-- added for tasks in migration 0002, so a checkpoint pushed from a
-- different machine/repo than its parent task's origin (e.g. a teammate
-- adding checkpoints against a task they pulled) can be told apart. See
-- docs/07-CLOUD-SYNC-API-CONTRACT.md §2.1.
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id);
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS workspace_label TEXT;

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3')
  ON CONFLICT (key) DO UPDATE SET value = '3';
