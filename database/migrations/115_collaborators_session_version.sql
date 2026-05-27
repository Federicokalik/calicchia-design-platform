-- 115_collaborators_session_version.sql
-- Audit B-007 + B-008. apps/api/src/routes/portal/auth.ts:152 reads
-- collaborators.session_version and verifies it matches the JWT claim; no
-- migration ever added the column. Today the query throws "column does not
-- exist" on every collaborator request hitting portalAuth → the middleware
-- catches and treats the actor as unauthenticated, but the loop just happens
-- to redirect to /clienti/login instead of throwing. With this PR also bumping
-- the value on rotate (rotateCollaboratorPortalCode) and on
-- /:id/revoke-portal-sessions, the column must exist for real now.

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;
