-- Migration: 029_freelancer_os_phase0_phase1.sql
-- Descrizione: Estensioni additive per Freelancer Operating System (Fase 0/1)
-- Data: 2026-03-08

-- =====================================================
-- QUOTE ENGINE (FASE 1 - estensione base)
-- =====================================================

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS service_type TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS scope_items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS payment_plan JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_payment_methods JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS bank_details_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS generated_project_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_quotes_generated_project'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT fk_quotes_generated_project
      FOREIGN KEY (generated_project_id) REFERENCES client_projects(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_quotes_service_type_fos'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT chk_quotes_service_type_fos
      CHECK (
        service_type IS NULL OR service_type IN (
          'graphic_design',
          'website',
          'marketing_campaign',
          'retainer',
          'retainer_maintenance',
          'consulting'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_quotes_scope_items_json_array'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT chk_quotes_scope_items_json_array
      CHECK (jsonb_typeof(scope_items) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_quotes_revision_policy_json_object'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT chk_quotes_revision_policy_json_object
      CHECK (jsonb_typeof(revision_policy) = 'object');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_quotes_payment_plan_json_object'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT chk_quotes_payment_plan_json_object
      CHECK (jsonb_typeof(payment_plan) = 'object');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_quotes_accepted_payment_methods_json_array'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT chk_quotes_accepted_payment_methods_json_array
      CHECK (jsonb_typeof(accepted_payment_methods) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_quotes_bank_details_snapshot_json_object'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT chk_quotes_bank_details_snapshot_json_object
      CHECK (jsonb_typeof(bank_details_snapshot) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_quotes_service_type ON quotes(service_type);
CREATE INDEX IF NOT EXISTS idx_quotes_generated_project_id
  ON quotes(generated_project_id) WHERE generated_project_id IS NOT NULL;
