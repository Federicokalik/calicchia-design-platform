-- Admin UI locale preference.
-- Italian remains the canonical/default language for content and records.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ui_locale TEXT NOT NULL DEFAULT 'it';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_ui_locale_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ui_locale_check CHECK (ui_locale IN ('it', 'en'));

UPDATE public.profiles
SET ui_locale = 'it'
WHERE ui_locale IS NULL OR ui_locale NOT IN ('it', 'en');
