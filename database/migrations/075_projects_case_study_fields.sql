-- 075: Case study fields per /lavori/[slug] template medium-grade
-- Estensione tabella projects con campi specifici per case study editorial
-- Pentagram-style. Tutti additive con IF NOT EXISTS per idempotency.

-- Anno completamento progetto (per badge "lavoro >1 anno fa potrebbe essere
-- cambiato o non più online" sul frontend)
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS year INT;

-- Tag filtrabili per categorizzare progetti (es: ['e-commerce', 'wordpress',
-- 'b2b']). Diversi da `technologies` (stack tecnico) e da `services`
-- (servizi prestati free-text).
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Metrics strutturate per sezione Outcome.
-- Struttura: [{ "label": "Tempo prenotazione", "before": "3 min", "after": "40s", "unit": "" }, ...]
-- O più semplice: [{ "label": "Lead/mese", "value": "+120%" }, ...]
-- Frontend gestisce entrambe le forme.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '[]'::jsonb;

-- Sintesi outcome 80-150 parole. Cosa è cambiato dopo il go-live.
-- Voice: factual, niente "siamo riusciti", niente claim vuoti.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS outcome TEXT;

-- SEO override (opzionali). Se NULL il sito-v3 cade su title/description del
-- progetto + suffisso "· Case study".
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS seo_title TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS seo_description TEXT;
