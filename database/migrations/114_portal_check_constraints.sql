-- 114_portal_check_constraints.sql
-- Audit 2026-05-27 B-001 + B-002.
--
-- 056_client_portal_v2.sql shipped CHECK constraints on timeline_events.actor_type
-- and client_uploads.status that don't include values the running code writes:
--   - portal/messages.ts:103 inserts actor_type='collaborator' when the sender is
--     a collaborator → check_violation → POST /api/portal/projects/:id/messages
--     crashes 500 for collab users.
--   - portal/upload.ts:217 sets status='rejected' when magic-byte sniffing rejects
--     a file → check_violation → 500 instead of the intended 400 + clean record.
--
-- This migration widens both CHECKs in place. timeline_events keeps the existing
-- default ('admin') and just extends the allowed set; client_uploads gains
-- 'rejected' as a discrete terminal state (alongside the pre-existing 'failed'
-- for infrastructure-level upload errors), so admins can distinguish between
-- "S3 hiccup, retry" and "content mismatch, won't accept this file".

ALTER TABLE timeline_events
  DROP CONSTRAINT IF EXISTS timeline_events_actor_type_check;

ALTER TABLE timeline_events
  ADD CONSTRAINT timeline_events_actor_type_check
  CHECK (actor_type IN ('admin', 'client', 'system', 'collaborator'));

ALTER TABLE client_uploads
  DROP CONSTRAINT IF EXISTS client_uploads_status_check;

ALTER TABLE client_uploads
  ADD CONSTRAINT client_uploads_status_check
  CHECK (status IN ('uploading', 'completed', 'failed', 'deleted', 'rejected'));
