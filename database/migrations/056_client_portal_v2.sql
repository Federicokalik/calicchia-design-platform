-- Migration: 056_client_portal_v2.sql
-- Descrizione: Client Portal v2 - timeline, reports, uploads, notifiche
-- Data: 2026-03-31

-- =====================================================
-- NUOVE COLONNE SU TABELLE ESISTENTI
-- =====================================================

-- Logo cliente per il portale
ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_logo TEXT;

-- Pipeline steps custom per progetto (es. ["Design","Sviluppo","Revisione","Go Live"])
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS pipeline_steps JSONB DEFAULT '[]';
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS current_step INT DEFAULT 0;

-- Messaggi portale: nome mittente + tracking lettura
ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS sender_name TEXT;
ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false;

-- Indice per messaggi non letti
CREATE INDEX IF NOT EXISTS idx_project_comments_unread
  ON project_comments(project_id, is_read) WHERE is_read = false;

-- =====================================================
-- TABELLA: timeline_events
-- Feed centrale del portale clienti
-- =====================================================

CREATE TABLE IF NOT EXISTS timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'status_change',
    'deliverable_added',
    'deliverable_approved',
    'deliverable_rejected',
    'file_uploaded',
    'file_requested',
    'message',
    'invoice_sent',
    'invoice_paid',
    'note'
  )),
  title TEXT NOT NULL,
  description TEXT,
  action_required BOOLEAN NOT NULL DEFAULT false,
  action_type TEXT CHECK (action_type IN ('approve', 'upload', 'pay') OR action_type IS NULL),
  action_target_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT false,
  actor_type TEXT NOT NULL DEFAULT 'admin' CHECK (actor_type IN ('admin', 'client', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_timeline_events_project ON timeline_events(project_id);
CREATE INDEX idx_timeline_events_customer ON timeline_events(customer_id);
CREATE INDEX idx_timeline_events_unread ON timeline_events(customer_id, is_read) WHERE is_read = false;
CREATE INDEX idx_timeline_events_created ON timeline_events(created_at DESC);
CREATE INDEX idx_timeline_events_action ON timeline_events(customer_id, action_required) WHERE action_required = true;

-- =====================================================
-- TABELLA: portal_reports
-- Report mensili per i clienti
-- =====================================================

CREATE TABLE IF NOT EXISTS portal_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year >= 2020),
  title TEXT NOT NULL,
  summary TEXT,
  data JSONB DEFAULT '{}',
  pdf_url TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(customer_id, year, month)
);

CREATE INDEX idx_portal_reports_customer ON portal_reports(customer_id);
CREATE INDEX idx_portal_reports_published ON portal_reports(published_at) WHERE published_at IS NOT NULL;

-- =====================================================
-- TABELLA: client_uploads
-- Tracking upload clienti su MEGA S4
-- =====================================================

CREATE TABLE IF NOT EXISTS client_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,
  storage_provider TEXT NOT NULL DEFAULT 's4',
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'completed', 'failed', 'deleted')),
  upload_id TEXT,
  published_url TEXT,
  metadata JSONB DEFAULT '{}',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_client_uploads_customer ON client_uploads(customer_id);
CREATE INDEX idx_client_uploads_project ON client_uploads(project_id);
CREATE INDEX idx_client_uploads_status ON client_uploads(status);

-- =====================================================
-- TABELLA: portal_notifications
-- Log notifiche inviate (Telegram + Email)
-- =====================================================

CREATE TABLE IF NOT EXISTS portal_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'email')),
  type TEXT CHECK (type IN ('upload', 'deliverable', 'invoice', 'message', 'report', 'status_change') OR type IS NULL),
  payload JSONB DEFAULT '{}',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_portal_notifications_customer ON portal_notifications(customer_id);
CREATE INDEX idx_portal_notifications_sent ON portal_notifications(sent_at DESC);
