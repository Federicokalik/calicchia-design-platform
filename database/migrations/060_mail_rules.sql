-- 060_mail_rules.sql — User-defined mail filter rules
-- First matching rule (by priority asc) wins; falls back to heuristic classifier.

CREATE TABLE IF NOT EXISTS email_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,

  -- Conditions (all non-null ones are AND-ed; ILIKE patterns, use % as wildcard)
  match_from text,
  match_subject text,
  match_has_unsubscribe boolean,

  -- Action
  set_category text NOT NULL CHECK (set_category IN ('importanti','normali','aggiornamenti','marketing','spam')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_rules_user_active
  ON email_rules (user_id, active, priority);
