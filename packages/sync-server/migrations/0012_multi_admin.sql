-- Ariadne sync server schema v12. Drops the single-admin-per-team partial
-- unique index introduced in migration 0006. That constraint predates the
-- Ariadne SSO integration's role-mapping decision (every jcnr-triage admin
-- becomes an Ariadne admin), which requires multiple concurrent admins to
-- be possible. Membership uniqueness per (team_id, user_id) is already
-- guaranteed by team_memberships' existing PRIMARY KEY — this migration
-- removes no other guarantee.
--
-- Additionally, allows password_hash to be NULL for SSO-provisioned users
-- who authenticate only through the SSO callback.

DROP INDEX IF EXISTS idx_team_memberships_single_admin;

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '12')
  ON CONFLICT (key) DO UPDATE SET value = '12';
