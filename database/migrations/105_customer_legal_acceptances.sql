-- Migration: 105_customer_legal_acceptances.sql
-- Descrizione: Audit trail dell'accettazione di T&C e DPA da parte dei clienti
--              tramite il portale. Soddisfa l'obbligo di prova del consenso
--              ex art. 7 GDPR per i documenti contrattuali e parte integrante
--              (T&C + DPA) accessibili dal portale clienti.
-- Data: 2026-05-24
--
-- Una riga per ogni coppia (customer, document, version). Major version
-- bump (LEGAL_MAJOR_VERSIONS in apps/api/src/lib/legal-versions.ts) forza
-- ri-accettazione perche` la lookup non trova piu` la riga per la nuova
-- versione corrente. Idempotenza garantita dalla UNIQUE constraint:
-- doppi POST sullo stesso (customer, doc, version) sono no-op.
--
-- Eccezione "quote bypass": valida solo per BOOTSTRAP_VERSION='1', e`
-- implementata lato API in routes/portal/legal.ts (non in questo schema)
-- perche` dipende da una constant del codice, non da uno stato DB.

CREATE TABLE IF NOT EXISTS customer_legal_acceptances (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  document_slug       TEXT         NOT NULL CHECK (document_slug IN ('termini-e-condizioni', 'dpa-clienti')),
  document_version    TEXT         NOT NULL,
  accepted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  accepted_ip         TEXT,
  accepted_user_agent TEXT,
  UNIQUE (customer_id, document_slug, document_version)
);

-- Lookup dominante: "questo customer ha accettato i documenti per le versioni
-- correnti?". Composite su (customer_id, document_slug) gia` coperto dalla
-- UNIQUE; aggiungiamo un index secondario solo su customer_id per i casi
-- batch (es. report admin di chi non ha ancora accettato).
CREATE INDEX IF NOT EXISTS customer_legal_acceptances_customer_idx
  ON customer_legal_acceptances (customer_id);

COMMENT ON TABLE customer_legal_acceptances IS
  'GDPR art. 7 — prova di consenso esplicita ai documenti contrattuali (T&C, DPA) effettuata dai clienti tramite il gate /clienti/accettazione-legale.';
COMMENT ON COLUMN customer_legal_acceptances.document_version IS
  'Major version manuale tracciata in LEGAL_MAJOR_VERSIONS (lib/legal-versions.ts). Bump della versione forza ri-accettazione al prossimo login.';
COMMENT ON COLUMN customer_legal_acceptances.accepted_ip IS
  'IP del client al momento del click "Accetto" — estratto via getClientIp() con fallback CF-Connecting-IP > X-Forwarded-For > X-Real-IP > socket.';
