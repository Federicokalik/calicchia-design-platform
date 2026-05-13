-- 085: Allow EXPORT/IMPORT actions in audit_logs
-- The default check constraint (012_audit_logging.sql) only allows INSERT/UPDATE/DELETE.
-- Backup operations need their own audit trail with distinct action verbs.

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'EXPORT', 'IMPORT'));
