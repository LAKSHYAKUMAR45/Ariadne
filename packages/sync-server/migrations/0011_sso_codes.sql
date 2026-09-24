-- Ariadne sync server schema v11. Adds the one-time exchange codes used by
-- the jcnr-triage SSO handoff: jcnr-triage mints a code server-to-server,
-- the browser is redirected to /sso/callback with only that opaque code,
-- and this table lets the callback consume it exactly once. Only the
-- SHA-256 hash of the code is ever stored, mirroring password_hash.

CREATE TABLE sso_exchange_codes (
  code_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sso_exchange_codes_expires_at_idx ON sso_exchange_codes (expires_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '11')
  ON CONFLICT (key) DO UPDATE SET value = '11';
