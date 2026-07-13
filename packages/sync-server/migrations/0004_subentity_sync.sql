-- Ariadne sync server schema v4. Extends cloud sync coverage beyond
-- tasks/checkpoints to todos, decisions, errors, open questions and
-- commands (see docs/07-CLOUD-SYNC-API-CONTRACT.md §4.6). Mirrors the
-- checkpoints table shape (id, local_id, task_id FK, owner_user_id,
-- workspace_label, content columns, created_at) for decisions/errors/
-- open_questions/commands, which are create-once for sync purposes just
-- like checkpoints. Todos additionally get status + updated_at, since
-- they're the one sub-entity type that supports full bidirectional sync
-- (an update-by-remote-id, not just insert).
--
-- `files`/`commits` are deliberately out of scope here — they're
-- git/workspace-local derived artifacts (already partly covered by
-- git_sync), not first-class curated text content.

CREATE TABLE IF NOT EXISTS todos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_task_updated ON todos(task_id, updated_at);

CREATE TABLE IF NOT EXISTS decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  text            TEXT NOT NULL,
  rationale       TEXT,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_task_created ON decisions(task_id, created_at);

CREATE TABLE IF NOT EXISTS errors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  message         TEXT NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolution      TEXT,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_errors_task_created ON errors(task_id, created_at);

CREATE TABLE IF NOT EXISTS open_questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  text            TEXT NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_questions_task_created ON open_questions(task_id, created_at);

CREATE TABLE IF NOT EXISTS commands (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  cmd_redacted    TEXT NOT NULL,
  exit_code       INTEGER,
  summary         TEXT,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commands_task_created ON commands(task_id, created_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')
  ON CONFLICT (key) DO UPDATE SET value = '4';
