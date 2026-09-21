-- Ariadne sync server schema v7. Adds encrypted task file history storage:
-- content-addressed AES-256-GCM blobs shared within a team, immutable capture
-- events, per-path entries, and an append-only deletion audit log.
--
-- Plaintext never reaches this schema: only gzip-compressed ciphertext plus
-- the metadata that the blob's AAD authenticates (schema/AAD version, team,
-- plaintext SHA-256, blob type, key id, compression) is stored.

-- Composite key so capture rows can prove, via a foreign key, that the task
-- they reference belongs to the same team.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_id_team_id_key'
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_id_team_id_key UNIQUE (id, team_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS encrypted_blobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          UUID NOT NULL REFERENCES teams(id),
  plaintext_sha256 TEXT NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  blob_type        TEXT NOT NULL CHECK (blob_type IN ('snapshot', 'diff')),
  key_id           TEXT NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9-]*$'),
  aad_version      INTEGER NOT NULL DEFAULT 1 CHECK (aad_version >= 1),
  compression      TEXT NOT NULL CHECK (compression IN ('gzip')),
  nonce            BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext       BYTEA NOT NULL,
  auth_tag         BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  plaintext_bytes  INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT encrypted_blobs_team_content_key UNIQUE (team_id, plaintext_sha256, blob_type),
  -- Reference key for capture entries: pinning the plaintext hash here means a
  -- stored reference names one exact ciphertext, so no same-team blob can be
  -- swapped in behind an entry and no referenced hash can be rewritten.
  CONSTRAINT encrypted_blobs_reference_key UNIQUE (id, team_id, blob_type, plaintext_sha256)
);

CREATE TABLE IF NOT EXISTS task_file_captures (
  id             TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  team_id        UUID NOT NULL REFERENCES teams(id),
  task_id        UUID NOT NULL REFERENCES tasks(id),
  "trigger"      TEXT NOT NULL CHECK ("trigger" IN ('git_commit', 'checkpoint', 'explicit')),
  git_commit_sha TEXT CHECK (git_commit_sha ~ '^[0-9a-f]{7,64}$'),
  checkpoint_id  TEXT CHECK (length(checkpoint_id) BETWEEN 1 AND 200),
  created_at     TIMESTAMPTZ NOT NULL,
  stored_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Capture identity is team-scoped: two teams may legitimately mint the same
  -- local capture id, and neither can probe for or squat the other's ids.
  PRIMARY KEY (team_id, id),
  CONSTRAINT task_file_captures_id_team_task_key UNIQUE (id, team_id, task_id),
  CONSTRAINT task_file_captures_task_team_fk
    FOREIGN KEY (task_id, team_id) REFERENCES tasks (id, team_id),
  CONSTRAINT task_file_captures_commit_trigger_check
    CHECK ("trigger" <> 'git_commit' OR git_commit_sha IS NOT NULL),
  CONSTRAINT task_file_captures_checkpoint_trigger_check
    CHECK ("trigger" <> 'checkpoint' OR checkpoint_id IS NOT NULL)
);

-- Mirrors the local capture idempotency rules (plan 02 ruling): commit and
-- checkpoint captures are unique per task, explicit captures are new events.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_file_captures_commit_idempotency
  ON task_file_captures (team_id, task_id, git_commit_sha)
  WHERE "trigger" = 'git_commit';

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_file_captures_checkpoint_idempotency
  ON task_file_captures (team_id, task_id, checkpoint_id)
  WHERE "trigger" = 'checkpoint';

CREATE INDEX IF NOT EXISTS idx_task_file_captures_team_task_created
  ON task_file_captures (team_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_file_capture_entries (
  capture_id         TEXT NOT NULL,
  team_id            UUID NOT NULL,
  task_id            UUID NOT NULL,
  path               TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  snapshot_sha256    TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  diff_sha256        TEXT NOT NULL CHECK (diff_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_blob_id   UUID NOT NULL,
  diff_blob_id       UUID NOT NULL,
  -- Constant generated columns let the foreign keys below pin each reference
  -- to the correct authenticated blob type and to the capture's own team.
  snapshot_blob_type TEXT NOT NULL GENERATED ALWAYS AS ('snapshot') STORED,
  diff_blob_type     TEXT NOT NULL GENERATED ALWAYS AS ('diff') STORED,
  PRIMARY KEY (team_id, capture_id, path),
  CONSTRAINT task_file_capture_entries_capture_fk
    FOREIGN KEY (capture_id, team_id, task_id)
    REFERENCES task_file_captures (id, team_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT task_file_capture_entries_snapshot_fk
    FOREIGN KEY (snapshot_blob_id, team_id, snapshot_blob_type, snapshot_sha256)
    REFERENCES encrypted_blobs (id, team_id, blob_type, plaintext_sha256)
    ON DELETE RESTRICT,
  CONSTRAINT task_file_capture_entries_diff_fk
    FOREIGN KEY (diff_blob_id, team_id, diff_blob_type, diff_sha256)
    REFERENCES encrypted_blobs (id, team_id, blob_type, plaintext_sha256)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_task_file_capture_entries_snapshot_blob
  ON task_file_capture_entries (snapshot_blob_id);

CREATE INDEX IF NOT EXISTS idx_task_file_capture_entries_diff_blob
  ON task_file_capture_entries (diff_blob_id);

CREATE TABLE IF NOT EXISTS task_file_history_deletions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id             UUID NOT NULL REFERENCES teams(id),
  task_id             UUID NOT NULL REFERENCES tasks(id),
  -- Intentionally not a foreign key: the capture row is gone by the time the
  -- audit row is written, and the audit must survive it.
  capture_id          TEXT NOT NULL CHECK (length(capture_id) BETWEEN 1 AND 200),
  actor_user_id       UUID NOT NULL REFERENCES users(id),
  deleted_paths       TEXT[] NOT NULL,
  deleted_entry_count INTEGER NOT NULL CHECK (deleted_entry_count >= 0),
  deleted_blob_count  INTEGER NOT NULL CHECK (deleted_blob_count >= 0),
  reason              TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_file_history_deletions_team_created
  ON task_file_history_deletions (team_id, created_at DESC);

-- Append-only enforcement: the audit log can be inserted into and read, never
-- rewritten or erased by application-level access. A table owner can still
-- TRUNCATE it; revoking that privilege requires a dedicated, less privileged
-- application database role, which is deliberately deferred to plan 03
-- (operator deployment and backups).
CREATE OR REPLACE FUNCTION ariadne_task_file_history_deletions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'task_file_history_deletions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_file_history_deletions_append_only
  ON task_file_history_deletions;

CREATE TRIGGER trg_task_file_history_deletions_append_only
  BEFORE UPDATE OR DELETE ON task_file_history_deletions
  FOR EACH ROW EXECUTE FUNCTION ariadne_task_file_history_deletions_append_only();

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '7')
  ON CONFLICT (key) DO UPDATE SET value = '7';
