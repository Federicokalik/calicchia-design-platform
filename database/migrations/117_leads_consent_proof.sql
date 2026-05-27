-- 117_leads_consent_proof.sql
-- Audit C-007. The embed lead form (apps/sito-v3/.../EmbedLeadForm.tsx) posts
-- to /api/public-leads which writes a leads row without any record of GDPR
-- consent. Garante 330/2025 + GDPR art. 7 require explicit proof. Adding the
-- three columns mirrors the existing pattern on contacts (mig 113) and
-- newsletter_subscribers (mig 103). Existing leads created via other paths
-- (contact form, booking flow) get NULL — those flows write their own consent
-- onto the contacts/calendar_bookings sibling rows.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS gdpr_consent       BOOLEAN,
  ADD COLUMN IF NOT EXISTS consent_ip         TEXT,
  ADD COLUMN IF NOT EXISTS consent_user_agent TEXT;
