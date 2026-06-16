-- Migration 138: Email/WhatsApp marketing — automations (drip sequences)
--
-- A trigger enrolls a contact into a linear sequence of steps; the cron advances
-- each enrollment when its step's delay elapses. Idempotent enrollment via
-- UNIQUE(automation_id, contact_id). Action delivery reuses the same email /
-- WhatsApp send paths as campaigns.

CREATE TABLE IF NOT EXISTS mkt_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | active | paused
  trigger_type TEXT NOT NULL,                  -- contact_created | tag_added | list_joined | form_submitted | manual
  trigger_config JSONB NOT NULL DEFAULT '{}',  -- e.g. { list_id } / { tag } / { form_id }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mkt_automations_status CHECK (status IN ('draft','active','paused')),
  CONSTRAINT chk_mkt_automations_trigger
    CHECK (trigger_type IN ('contact_created','tag_added','list_joined','form_submitted','manual'))
);

CREATE TABLE IF NOT EXISTS mkt_automation_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES mkt_automations(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  delay_minutes INT NOT NULL DEFAULT 0,        -- wait before THIS step runs
  action_type TEXT NOT NULL,                   -- send_email | send_whatsapp | add_tag | wait
  action_config JSONB NOT NULL DEFAULT '{}',   -- {subject, blocks} / {body} / {tag}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mkt_automation_action
    CHECK (action_type IN ('send_email','send_whatsapp','add_tag','wait')),
  CONSTRAINT uq_mkt_automation_step UNIQUE (automation_id, step_order)
);

CREATE TABLE IF NOT EXISTS mkt_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES mkt_automations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  current_step_order INT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active',        -- active | completed | cancelled
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_mkt_run_status CHECK (status IN ('active','completed','cancelled')),
  CONSTRAINT uq_mkt_automation_run UNIQUE (automation_id, contact_id)
);
-- Cron due-step scan.
CREATE INDEX IF NOT EXISTS idx_mkt_runs_due ON mkt_automation_runs (next_run_at) WHERE status = 'active';
