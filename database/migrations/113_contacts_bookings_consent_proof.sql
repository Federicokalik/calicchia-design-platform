-- 113_contacts_bookings_consent_proof.sql
-- GDPR art. 7 — prova del consenso anche per contacts e calendar_bookings.
-- newsletter_subscribers ha già questi campi dalla 103. Audit 2026-05-27 J-05 +
-- A-009 + Codex C6-005 ha rilevato che contacts e calendar_bookings catturano
-- gdpr_consent come boolean ma non l'IP e lo user-agent del momento del consenso,
-- privando l'audit trail della prova tracciabile richiesta dalla Decisione
-- Garante 330/2025.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS consent_ip         TEXT,
  ADD COLUMN IF NOT EXISTS consent_user_agent TEXT;

ALTER TABLE calendar_bookings
  ADD COLUMN IF NOT EXISTS consent_ip         TEXT,
  ADD COLUMN IF NOT EXISTS consent_user_agent TEXT;
