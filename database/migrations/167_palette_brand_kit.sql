-- Migration 167 — tool "Palette di settore", fase 2: brand kit in PDF.
--
-- Chi usa il tool si iscrive alla newsletter (scopo dichiarato, consenso
-- esplicito, double opt-in) e in regalo riceve il PDF della sua palette.
--
-- 1. palette_kit_requests: una riga per richiesta. Il contatto è in
--    mkt_contacts (stessa anagrafica del resto dell'email marketing); la
--    palette resta qui e non nelle submission dei moduli, così cade in
--    cascata quando il contatto viene cancellato (richiesta GDPR).
--    confirm_token è per richiesta: la conferma via link attiva il consenso
--    del contatto e mette in coda l'invio del PDF.
--    consent_version indica il testo del consenso mostrato al visitatore
--    (i testi stanno nel codice: lib/palette-kit/consent.ts).
-- 2. Obiettivo di analytics per l'evento del modulo.

CREATE TABLE IF NOT EXISTS palette_kit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  -- Forma: brandPaletteSchema di @calicchia/shared/palette (palette + lingua).
  palette JSONB NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('it', 'en')),
  -- Etichetta del settore nella lingua del visitatore (solo testo, mostrata nel PDF).
  sector_label TEXT,
  consent_version TEXT NOT NULL,
  confirm_token UUID NOT NULL DEFAULT gen_random_uuid(),
  request_ip TEXT,
  request_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  confirm_ip TEXT,
  sent_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_palette_kit_requests_token ON palette_kit_requests (confirm_token);
CREATE INDEX IF NOT EXISTS idx_palette_kit_requests_contact ON palette_kit_requests (contact_id);
CREATE INDEX IF NOT EXISTS idx_palette_kit_requests_pending ON palette_kit_requests (next_attempt_at)
  WHERE confirmed_at IS NOT NULL AND sent_at IS NULL;

INSERT INTO analytics_goals (name, type, conditions, active)
SELECT 'Palette: brand kit richiesto', 'event', jsonb_build_object('type', 'event', 'event_name', 'palette_kit'), TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM analytics_goals a
  WHERE a.type = 'event' AND a.conditions->>'event_name' = 'palette_kit'
);
