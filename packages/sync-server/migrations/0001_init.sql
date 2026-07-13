-- Ariadne sync server schema v1. See docs/07-CLOUD-SYNC-API-CONTRACT.md §2
-- for the full rationale. Applied by src/migrate.ts, tracked via schema_meta.
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id       TEXT NOT NULL,
  owner_user_id  UUID NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  goal           TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  branch         TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id   TEXT NOT NULL,
  task_id    UUID NOT NULL REFERENCES tasks(id),
  level      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task_created ON checkpoints(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')
  ON CONFLICT (key) DO NOTHING;
