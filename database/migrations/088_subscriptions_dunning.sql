-- ============================================================
-- 088: Subscriptions dunning - regole recupero crediti
-- ============================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS dunning_grace_days INTEGER NOT NULL DEFAULT 7 CHECK (dunning_grace_days >= 0),
  ADD COLUMN IF NOT EXISTS dunning_reminder_days INTEGER[] NOT NULL DEFAULT '{3,7,14}'::integer[],
  ADD COLUMN IF NOT EXISTS dunning_suspend_days INTEGER NOT NULL DEFAULT 30 CHECK (dunning_suspend_days >= 0),
  ADD COLUMN IF NOT EXISTS last_dunning_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS dunning_state TEXT NOT NULL DEFAULT 'none' CHECK (dunning_state IN ('none','grace','reminded','suspended'));

CREATE INDEX IF NOT EXISTS subscriptions_dunning_state_idx
  ON subscriptions(dunning_state)
  WHERE dunning_state != 'none';
