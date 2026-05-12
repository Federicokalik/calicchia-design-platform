-- Migration: 015_soft_deletes.sql
-- Descrizione: Soft Deletes per tabelle critiche
-- Data: 2026-01-20

-- =====================================================
-- AGGIUNGI COLONNA deleted_at
-- =====================================================

-- Customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_customers_deleted ON customers(deleted_at) WHERE deleted_at IS NULL;

-- Blog Posts
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_blog_posts_deleted ON blog_posts(deleted_at) WHERE deleted_at IS NULL;

-- Projects (portfolio)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_projects_deleted ON projects(deleted_at) WHERE deleted_at IS NULL;

-- Invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_invoices_deleted ON invoices(deleted_at) WHERE deleted_at IS NULL;

-- Quotes
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_quotes_deleted ON quotes(deleted_at) WHERE deleted_at IS NULL;

-- Client Projects
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_client_projects_deleted ON client_projects(deleted_at) WHERE deleted_at IS NULL;

-- Domains
ALTER TABLE domains ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_domains_deleted ON domains(deleted_at) WHERE deleted_at IS NULL;

-- Contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contacts_deleted ON contacts(deleted_at) WHERE deleted_at IS NULL;

-- =====================================================
-- AGGIORNA RLS POLICIES PER ESCLUDERE SOFT DELETED
-- =====================================================

-- Nota: Le policy esistenti devono essere aggiornate manualmente
-- per includere "AND deleted_at IS NULL"

-- =====================================================
-- FUNZIONI HELPER
-- =====================================================

-- Soft delete generico
CREATE OR REPLACE FUNCTION soft_delete(
  p_table TEXT,
  p_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  EXECUTE format('UPDATE %I SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL', p_table)
  USING p_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Restore soft deleted record
CREATE OR REPLACE FUNCTION restore_deleted(
  p_table TEXT,
  p_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  EXECUTE format('UPDATE %I SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL', p_table)
  USING p_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hard delete (permanent)
CREATE OR REPLACE FUNCTION hard_delete(
  p_table TEXT,
  p_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  -- Solo record già soft deleted possono essere hard deleted
  EXECUTE format('DELETE FROM %I WHERE id = $1 AND deleted_at IS NOT NULL', p_table)
  USING p_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Pulisce record soft deleted più vecchi di N giorni
CREATE OR REPLACE FUNCTION cleanup_soft_deleted(
  p_table TEXT,
  p_days INTEGER DEFAULT 90
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  EXECUTE format(
    'DELETE FROM %I WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1 || '' days'')::INTERVAL',
    p_table
  )
  USING p_days;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- VISTE SENZA SOFT DELETED (per comodità)
-- =====================================================

-- Vista customers attivi
CREATE OR REPLACE VIEW active_customers AS
SELECT * FROM customers WHERE deleted_at IS NULL;

-- Vista blog posts attivi
CREATE OR REPLACE VIEW active_blog_posts AS
SELECT * FROM blog_posts WHERE deleted_at IS NULL;

-- Vista progetti portfolio attivi
CREATE OR REPLACE VIEW active_projects AS
SELECT * FROM projects WHERE deleted_at IS NULL;

-- Vista fatture attive
CREATE OR REPLACE VIEW active_invoices AS
SELECT * FROM invoices WHERE deleted_at IS NULL;

-- Vista preventivi attivi
CREATE OR REPLACE VIEW active_quotes AS
SELECT * FROM quotes WHERE deleted_at IS NULL;

-- Vista client projects attivi
CREATE OR REPLACE VIEW active_client_projects AS
SELECT * FROM client_projects WHERE deleted_at IS NULL;

-- Vista domini attivi
CREATE OR REPLACE VIEW active_domains AS
SELECT * FROM domains WHERE deleted_at IS NULL;

-- =====================================================
-- VISTA CESTINO (per admin)
-- =====================================================

CREATE OR REPLACE VIEW trash_bin AS
SELECT
  'customers' AS table_name,
  id,
  COALESCE(company_name, contact_name) AS title,
  deleted_at
FROM customers WHERE deleted_at IS NOT NULL

UNION ALL

SELECT
  'blog_posts' AS table_name,
  id,
  title,
  deleted_at
FROM blog_posts WHERE deleted_at IS NOT NULL

UNION ALL

SELECT
  'projects' AS table_name,
  id,
  title,
  deleted_at
FROM projects WHERE deleted_at IS NOT NULL

UNION ALL

SELECT
  'invoices' AS table_name,
  id,
  COALESCE(invoice_number, stripe_invoice_id, id::TEXT) AS title,
  deleted_at
FROM invoices WHERE deleted_at IS NOT NULL

UNION ALL

SELECT
  'quotes' AS table_name,
  id,
  COALESCE(quote_number, title, id::TEXT) AS title,
  deleted_at
FROM quotes WHERE deleted_at IS NOT NULL

UNION ALL

SELECT
  'client_projects' AS table_name,
  id,
  name AS title,
  deleted_at
FROM client_projects WHERE deleted_at IS NOT NULL

UNION ALL

SELECT
  'domains' AS table_name,
  id,
  domain_name AS title,
  deleted_at
FROM domains WHERE deleted_at IS NOT NULL

ORDER BY deleted_at DESC;

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON active_customers TO authenticated;
GRANT SELECT ON active_blog_posts TO authenticated;
GRANT SELECT ON active_projects TO authenticated;
GRANT SELECT ON active_invoices TO authenticated;
GRANT SELECT ON active_quotes TO authenticated;
GRANT SELECT ON active_client_projects TO authenticated;
GRANT SELECT ON active_domains TO authenticated;
GRANT SELECT ON trash_bin TO authenticated;

-- =====================================================
-- TRIGGER PER AUDIT SOFT DELETE
-- =====================================================

CREATE OR REPLACE FUNCTION audit_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    -- Record was soft deleted
    INSERT INTO audit_logs (
      user_id, user_email, user_role,
      action, table_name, record_id,
      old_data, new_data, changed_fields
    )
    VALUES (
      auth.uid(),
      (SELECT email FROM auth.users WHERE id = auth.uid()),
      (SELECT role FROM profiles WHERE id = auth.uid()),
      'SOFT_DELETE',
      TG_TABLE_NAME,
      NEW.id::TEXT,
      to_jsonb(OLD),
      to_jsonb(NEW),
      ARRAY['deleted_at']
    );
  ELSIF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    -- Record was restored
    INSERT INTO audit_logs (
      user_id, user_email, user_role,
      action, table_name, record_id,
      old_data, new_data, changed_fields
    )
    VALUES (
      auth.uid(),
      (SELECT email FROM auth.users WHERE id = auth.uid()),
      (SELECT role FROM profiles WHERE id = auth.uid()),
      'RESTORE',
      TG_TABLE_NAME,
      NEW.id::TEXT,
      to_jsonb(OLD),
      to_jsonb(NEW),
      ARRAY['deleted_at']
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Applica trigger alle tabelle
DROP TRIGGER IF EXISTS soft_delete_audit_customers ON customers;
CREATE TRIGGER soft_delete_audit_customers
  AFTER UPDATE OF deleted_at ON customers
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();

DROP TRIGGER IF EXISTS soft_delete_audit_blog_posts ON blog_posts;
CREATE TRIGGER soft_delete_audit_blog_posts
  AFTER UPDATE OF deleted_at ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();

DROP TRIGGER IF EXISTS soft_delete_audit_projects ON projects;
CREATE TRIGGER soft_delete_audit_projects
  AFTER UPDATE OF deleted_at ON projects
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();

DROP TRIGGER IF EXISTS soft_delete_audit_invoices ON invoices;
CREATE TRIGGER soft_delete_audit_invoices
  AFTER UPDATE OF deleted_at ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();

DROP TRIGGER IF EXISTS soft_delete_audit_quotes ON quotes;
CREATE TRIGGER soft_delete_audit_quotes
  AFTER UPDATE OF deleted_at ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();

DROP TRIGGER IF EXISTS soft_delete_audit_client_projects ON client_projects;
CREATE TRIGGER soft_delete_audit_client_projects
  AFTER UPDATE OF deleted_at ON client_projects
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();

DROP TRIGGER IF EXISTS soft_delete_audit_domains ON domains;
CREATE TRIGGER soft_delete_audit_domains
  AFTER UPDATE OF deleted_at ON domains
  FOR EACH ROW
  EXECUTE FUNCTION audit_soft_delete();
