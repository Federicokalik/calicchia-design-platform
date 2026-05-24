-- Migration: 103_newsletter_consent_proof.sql
-- Descrizione: Prova del consenso newsletter ai sensi art. 7 GDPR +
--              Decisione Garante 330/2025 (double opt-in con prove tracciabili).
-- Data: 2026-05-24
--
-- consent_ip / consent_user_agent: catturati al momento del POST /subscribe.
--   L'IP da solo non e' una prova forte (puo' essere spoofato/condiviso),
--   ma combinato con timestamp + user-agent + il successivo confirmed_at del
--   doppio opt-in fornisce un audit trail sufficiente.
-- confirmed_ip: catturato al click sul link di conferma (GET /confirm). Prova
--   che chi ha confermato controlla davvero la casella email indicata.
-- unsubscribe_token: gia' usato dal codice di `apps/api/src/routes/newsletter.ts`
--   (WHERE unsubscribe_token = :token) ma mancante dallo schema — corretto qui
--   con DEFAULT gen_random_uuid() per popolare anche le righe esistenti.

ALTER TABLE newsletter_subscribers
  ADD COLUMN IF NOT EXISTS consent_ip         TEXT,
  ADD COLUMN IF NOT EXISTS consent_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_ip       TEXT,
  ADD COLUMN IF NOT EXISTS unsubscribe_token  UUID DEFAULT gen_random_uuid();

-- Popola gli unsubscribe_token mancanti per i record pre-esistenti (la DEFAULT
-- vale solo sulle nuove righe; gli iscritti precedenti restano con NULL).
UPDATE newsletter_subscribers
SET    unsubscribe_token = gen_random_uuid()
WHERE  unsubscribe_token IS NULL;

-- Indice per la lookup O(1) dal link unsubscribe nelle email.
CREATE INDEX IF NOT EXISTS newsletter_unsubscribe_token_idx
  ON newsletter_subscribers(unsubscribe_token);
