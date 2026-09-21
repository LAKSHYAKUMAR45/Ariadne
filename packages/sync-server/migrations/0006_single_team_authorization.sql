-- Ariadne sync server schema v6. Introduces singleton-team authorization
-- while preserving all existing user/task IDs and data. The migration is
-- intentionally additive and idempotent under the migration runner.

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key TEXT NOT NULL UNIQUE CHECK (singleton_key = 'default'),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_memberships (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);

DO $$
DECLARE
  singleton_team_id UUID;
  user_row RECORD;
BEGIN
  INSERT INTO teams (singleton_key, name)
  VALUES ('default', 'Default team')
  ON CONFLICT (singleton_key) DO NOTHING;

  SELECT id INTO singleton_team_id
  FROM teams
  WHERE singleton_key = 'default';

  FOR user_row IN
    SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
    FROM users
    ORDER BY created_at ASC, id ASC
  LOOP
    INSERT INTO team_memberships (team_id, user_id, role, active)
    VALUES (
      singleton_team_id,
      user_row.id,
      CASE WHEN user_row.rn = 1 THEN 'admin' ELSE 'member' END,
      true
    )
    -- Existing memberships are never overwritten: a re-run of this migration
    -- must not reactivate a deactivated member or change an assigned role.
    ON CONFLICT (team_id, user_id) DO NOTHING;
  END LOOP;

  UPDATE tasks
  SET team_id = singleton_team_id
  WHERE team_id IS NULL;
END
$$;

ALTER TABLE tasks ALTER COLUMN team_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_team_memberships_user_active
  ON team_memberships (user_id, active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_single_admin
  ON team_memberships (team_id)
  WHERE role = 'admin';

CREATE INDEX IF NOT EXISTS idx_tasks_team_updated
  ON tasks (team_id, updated_at);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '6')
  ON CONFLICT (key) DO UPDATE SET value = '6';
