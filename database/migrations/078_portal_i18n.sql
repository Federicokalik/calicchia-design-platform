-- 078: i18n EAV translation tables per portal entities
-- Pattern identico a 076 (projects/blog_posts): tabelle _translations
-- (entity_id, locale, field_name, field_value). Assenza di una row = fallback
-- IT da colonna legacy. Aggiunta locali futuri (es. ES) senza DDL.
--
-- Entities portal coperte:
--   - client_projects (name, description, client_notes) — current_step è INTEGER, non traducibile
--   - timeline_events (title, description)
--   - project_milestones (name, description)
--   - project_deliverables (title, description)
--   - portal_reports (title, summary)
--   - subscriptions (name, description)
--
-- portal_reports.data (JSONB) volutamente NON coperto qui — è generato
-- programmaticamente (metric labels strutturati). Tradurre richiede schema
-- separato per i sotto-campi; gestito in iterazione futura se serve.

-- ─────────────────────────────────────────────────────────
-- client_projects_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_projects_translations (
  project_id UUID NOT NULL REFERENCES public.client_projects(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_client_projects_translations_locale
  ON public.client_projects_translations(locale);
CREATE INDEX IF NOT EXISTS idx_client_projects_translations_project
  ON public.client_projects_translations(project_id);

-- ─────────────────────────────────────────────────────────
-- timeline_events_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.timeline_events_translations (
  event_id UUID NOT NULL REFERENCES public.timeline_events(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_timeline_events_translations_locale
  ON public.timeline_events_translations(locale);
CREATE INDEX IF NOT EXISTS idx_timeline_events_translations_event
  ON public.timeline_events_translations(event_id);

-- ─────────────────────────────────────────────────────────
-- project_milestones_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_milestones_translations (
  milestone_id UUID NOT NULL REFERENCES public.project_milestones(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (milestone_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_project_milestones_translations_locale
  ON public.project_milestones_translations(locale);
CREATE INDEX IF NOT EXISTS idx_project_milestones_translations_milestone
  ON public.project_milestones_translations(milestone_id);

-- ─────────────────────────────────────────────────────────
-- project_deliverables_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_deliverables_translations (
  deliverable_id UUID NOT NULL REFERENCES public.project_deliverables(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deliverable_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_project_deliverables_translations_locale
  ON public.project_deliverables_translations(locale);
CREATE INDEX IF NOT EXISTS idx_project_deliverables_translations_deliverable
  ON public.project_deliverables_translations(deliverable_id);

-- ─────────────────────────────────────────────────────────
-- portal_reports_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_reports_translations (
  report_id UUID NOT NULL REFERENCES public.portal_reports(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (report_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_portal_reports_translations_locale
  ON public.portal_reports_translations(locale);
CREATE INDEX IF NOT EXISTS idx_portal_reports_translations_report
  ON public.portal_reports_translations(report_id);

-- ─────────────────────────────────────────────────────────
-- subscriptions_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions_translations (
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_translations_locale
  ON public.subscriptions_translations(locale);
CREATE INDEX IF NOT EXISTS idx_subscriptions_translations_subscription
  ON public.subscriptions_translations(subscription_id);

-- ─────────────────────────────────────────────────────────
-- Backfill IT da colonne legacy. Idempotente via ON CONFLICT DO NOTHING.
-- ─────────────────────────────────────────────────────────

-- client_projects: name, description, client_notes, current_step
INSERT INTO public.client_projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'name', name FROM public.client_projects
WHERE name IS NOT NULL AND name != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.client_projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'description', description FROM public.client_projects
WHERE description IS NOT NULL AND description != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.client_projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'client_notes', client_notes FROM public.client_projects
WHERE client_notes IS NOT NULL AND client_notes != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

-- timeline_events: title, description
INSERT INTO public.timeline_events_translations (event_id, locale, field_name, field_value)
SELECT id, 'it', 'title', title FROM public.timeline_events
WHERE title IS NOT NULL AND title != ''
ON CONFLICT (event_id, locale, field_name) DO NOTHING;

INSERT INTO public.timeline_events_translations (event_id, locale, field_name, field_value)
SELECT id, 'it', 'description', description FROM public.timeline_events
WHERE description IS NOT NULL AND description != ''
ON CONFLICT (event_id, locale, field_name) DO NOTHING;

-- project_milestones: name, description
INSERT INTO public.project_milestones_translations (milestone_id, locale, field_name, field_value)
SELECT id, 'it', 'name', name FROM public.project_milestones
WHERE name IS NOT NULL AND name != ''
ON CONFLICT (milestone_id, locale, field_name) DO NOTHING;

INSERT INTO public.project_milestones_translations (milestone_id, locale, field_name, field_value)
SELECT id, 'it', 'description', description FROM public.project_milestones
WHERE description IS NOT NULL AND description != ''
ON CONFLICT (milestone_id, locale, field_name) DO NOTHING;

-- project_deliverables: title, description
INSERT INTO public.project_deliverables_translations (deliverable_id, locale, field_name, field_value)
SELECT id, 'it', 'title', title FROM public.project_deliverables
WHERE title IS NOT NULL AND title != ''
ON CONFLICT (deliverable_id, locale, field_name) DO NOTHING;

INSERT INTO public.project_deliverables_translations (deliverable_id, locale, field_name, field_value)
SELECT id, 'it', 'description', description FROM public.project_deliverables
WHERE description IS NOT NULL AND description != ''
ON CONFLICT (deliverable_id, locale, field_name) DO NOTHING;

-- portal_reports: title, summary
INSERT INTO public.portal_reports_translations (report_id, locale, field_name, field_value)
SELECT id, 'it', 'title', title FROM public.portal_reports
WHERE title IS NOT NULL AND title != ''
ON CONFLICT (report_id, locale, field_name) DO NOTHING;

INSERT INTO public.portal_reports_translations (report_id, locale, field_name, field_value)
SELECT id, 'it', 'summary', summary FROM public.portal_reports
WHERE summary IS NOT NULL AND summary != ''
ON CONFLICT (report_id, locale, field_name) DO NOTHING;

-- subscriptions: name, description
INSERT INTO public.subscriptions_translations (subscription_id, locale, field_name, field_value)
SELECT id, 'it', 'name', name FROM public.subscriptions
WHERE name IS NOT NULL AND name != ''
ON CONFLICT (subscription_id, locale, field_name) DO NOTHING;

INSERT INTO public.subscriptions_translations (subscription_id, locale, field_name, field_value)
SELECT id, 'it', 'description', description FROM public.subscriptions
WHERE description IS NOT NULL AND description != ''
ON CONFLICT (subscription_id, locale, field_name) DO NOTHING;
