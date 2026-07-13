-- Adds workspace attribution to tasks: which machine/repo a task was last
-- pushed from, so teammates (and `ariadne sync pull`'s "skipped" report)
-- can tell tasks apart across repos, not just across user accounts. See
-- docs/07-CLOUD-SYNC-API-CONTRACT.md §4.2 for the field's shape/semantics.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_label TEXT;

UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
