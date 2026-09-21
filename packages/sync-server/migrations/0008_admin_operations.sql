-- Ariadne sync server schema v8. Adds audited admin/operator operation state
-- tracking and backup metadata without persisting backup payload bytes.

CREATE TABLE IF NOT EXISTS admin_operations (
  id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  requested_by UUID NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (
    type IN (
      'service_restart',
      'deployment_apply',
      'backup_create',
      'backup_verify',
      'backup_restore'
    )
  ),
  state        TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  summary      TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 500),
  output       TEXT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_operations_state_timestamp_check CHECK (
    (state = 'queued' AND started_at IS NULL AND completed_at IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT admin_operations_completed_after_started_check CHECK (
    completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
  )
);

CREATE INDEX IF NOT EXISTS idx_admin_operations_created_desc
  ON admin_operations (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_operations_requested_by_created_desc
  ON admin_operations (requested_by, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin_operation_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id  TEXT NOT NULL REFERENCES admin_operations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  message       TEXT NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 2000),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_operation_events_operation_created_desc
  ON admin_operation_events (operation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_operation_events_created_desc
  ON admin_operation_events (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  action        TEXT NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 200),
  source        TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 200),
  outcome       TEXT NOT NULL CHECK (length(btrim(outcome)) BETWEEN 1 AND 200),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created_desc
  ON admin_audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_action_created_desc
  ON admin_audit_events (action, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION ariadne_admin_audit_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_audit_events_append_only
  ON admin_audit_events;

CREATE TRIGGER trg_admin_audit_events_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION ariadne_admin_audit_events_append_only();

CREATE TABLE IF NOT EXISTS backup_records (
  filename                     TEXT PRIMARY KEY
                               CHECK (length(filename) BETWEEN 1 AND 255)
                               CHECK (position('/' in filename) = 0)
                               CHECK (position(E'\\' in filename) = 0),
  sha256                       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes                   BIGINT NOT NULL CHECK (size_bytes >= 0),
  status                       TEXT NOT NULL CHECK (
                                 status IN (
                                   'created',
                                   'verified',
                                   'verify_failed',
                                   'restored',
                                   'restore_failed'
                                 )
                               ),
  created_at                   TIMESTAMPTZ NOT NULL,
  verified_at                  TIMESTAMPTZ,
  restore_verification_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_records_created_desc
  ON backup_records (created_at DESC, filename DESC);

CREATE INDEX IF NOT EXISTS idx_backup_records_verified_desc
  ON backup_records (verified_at DESC, filename DESC);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')
  ON CONFLICT (key) DO UPDATE SET value = '8';
