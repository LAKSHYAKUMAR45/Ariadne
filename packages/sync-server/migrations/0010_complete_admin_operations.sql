-- Ariadne sync server schema v10. Extends tracked admin operations with
-- browser-visible rollback and local file-capture deletion.

ALTER TABLE admin_operations
  DROP CONSTRAINT IF EXISTS admin_operations_type_check;

ALTER TABLE admin_operations
  ADD CONSTRAINT admin_operations_type_check CHECK (
    type IN (
      'service_restart',
      'deployment_apply',
      'deployment_rollback',
      'file_capture_delete',
      'backup_create',
      'backup_verify',
      'backup_restore'
    )
  );

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '10')
  ON CONFLICT (key) DO UPDATE SET value = '10';
