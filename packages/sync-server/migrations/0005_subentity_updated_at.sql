-- Ariadne sync server schema v5. Extends the remaining syncable
-- sub-entities (decisions, errors, open_questions, commands) from
-- create-once to full bidirectional sync by adding updated_at columns,
-- backfilling them from created_at, and adding the one decision field
-- (`supersedes_id`) that already exists locally but was not included in
-- the original v4 Postgres schema.

ALTER TABLE decisions ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN supersedes_id UUID;
UPDATE decisions SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE decisions ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_task_updated ON decisions(task_id, updated_at);

ALTER TABLE errors ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE errors SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE errors ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_errors_task_updated ON errors(task_id, updated_at);

ALTER TABLE open_questions ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE open_questions SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE open_questions ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_open_questions_task_updated ON open_questions(task_id, updated_at);

ALTER TABLE commands ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE commands SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE commands ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commands_task_updated ON commands(task_id, updated_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')
  ON CONFLICT (key) DO UPDATE SET value = '5';
