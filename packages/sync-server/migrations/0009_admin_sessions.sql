-- Ariadne sync server schema v9. Adds database-backed admin dashboard
-- sessions: the browser surface no longer accepts the sync bearer JWT.
--
-- Only hashes are stored. The session token lives solely in the browser's
-- HttpOnly cookie and the CSRF token solely in the dashboard's memory, so a
-- database read (backup, dump, replica) can never reconstruct either secret.

CREATE TABLE IF NOT EXISTS admin_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash            TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash             TEXT NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  expires_at            TIMESTAMPTZ NOT NULL,
  reauthenticated_until TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No "expires_at > created_at" constraint on purpose: expiry is enforced in
-- the lookup query, and an operator must be able to end a session immediately
-- by pulling its expiry back to the present.

-- Expiry sweeps and the per-request lookup's freshness filter both read this.
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_created_desc
  ON admin_sessions (user_id, created_at DESC);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '9')
  ON CONFLICT (key) DO UPDATE SET value = '9';
