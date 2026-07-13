/**
 * Ariadne SQLite schema (v0.1). See docs/03-DATA-MODEL.md for rationale.
 * Kept as a plain string (not a loose .sql asset) so it ships correctly
 * inside compiled dist/ output without extra copy steps.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  goal           TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active|paused|done|archived
  parent_task_id TEXT REFERENCES tasks(id),
  branch         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  parent_checkpoint_id TEXT REFERENCES checkpoints(id),
  level                TEXT NOT NULL, -- micro|session|milestone
  summary              TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task_created ON checkpoints(task_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  path         TEXT NOT NULL,
  role         TEXT NOT NULL, -- edited|read|created|deleted
  last_touched TEXT NOT NULL,
  PRIMARY KEY (task_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_task_touched ON files(task_id, last_touched);

CREATE TABLE IF NOT EXISTS commits (
  sha           TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  checkpoint_id TEXT REFERENCES checkpoints(id),
  message       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commits_task_created ON commits(task_id, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  checkpoint_id TEXT REFERENCES checkpoints(id),
  text          TEXT NOT NULL,
  rationale     TEXT,
  supersedes_id TEXT REFERENCES decisions(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_task_created ON decisions(task_id, created_at);

CREATE TABLE IF NOT EXISTS todos (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  text                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending', -- pending|done|blocked
  source_checkpoint_id TEXT REFERENCES checkpoints(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_task_created ON todos(task_id, created_at);

CREATE TABLE IF NOT EXISTS commands (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  cmd_redacted TEXT NOT NULL,
  exit_code    INTEGER,
  summary      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commands_task_created ON commands(task_id, created_at);

CREATE TABLE IF NOT EXISTS errors (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  message    TEXT NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_errors_task_created ON errors(task_id, created_at);

CREATE TABLE IF NOT EXISTS open_questions (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  text       TEXT NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_questions_task_created ON open_questions(task_id, created_at);

-- Tracks schema version for future migrations.
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
`;

export const SCHEMA_VERSION = 3;
