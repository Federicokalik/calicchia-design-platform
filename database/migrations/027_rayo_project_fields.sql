-- =============================================
-- MIGRAZIONE: Campi case-study per web-rayo
-- =============================================
-- Estende projects con campi per case study (challenge, solution, feedback)
-- Estende profiles con campi per autore blog (bio, role_title, socials)

-- =============================================
-- TABELLA: projects - campi case-study
-- =============================================
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS client TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS services TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS industries TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS challenge JSONB;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS challenge_images JSONB;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS solution JSONB;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS solution_image TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS feedback JSONB;

-- Commenti struttura JSONB:
-- challenge: { "text": "...", "detail": "..." }
-- challenge_images: [{ "src": "...", "width": 1200, "height": 1200, "colClass": "col-12 col-xl-5", "bgClass": "bg-accent" }]
-- solution: { "text": "...", "detail": "..." }
-- feedback: { "quote": "...", "name": "...", "role": "...", "company": "..." }

-- =============================================
-- TABELLA: profiles - campi autore blog
-- =============================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role_title TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS socials JSONB;

-- Commenti struttura JSONB:
-- socials: [{ "label": "LinkedIn", "url": "https://..." }, { "label": "Behance", "url": "https://..." }]
