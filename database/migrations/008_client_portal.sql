-- Migration: 008_client_portal.sql
-- Descrizione: Sistema Client Portal per area clienti
-- Data: 2026-01-20

-- =====================================================
-- TABELLA CUSTOMER_USERS
-- Collegamento utenti autenticati ai clienti CRM
-- =====================================================

CREATE TABLE IF NOT EXISTS customer_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'owner' CHECK (role IN ('owner', 'member', 'viewer')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  is_primary BOOLEAN DEFAULT false,
  permissions JSONB DEFAULT '{"view_invoices": true, "view_domains": true, "view_projects": true, "view_subscriptions": true}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, customer_id)
);

-- Indici
CREATE INDEX idx_customer_users_user ON customer_users(user_id);
CREATE INDEX idx_customer_users_customer ON customer_users(customer_id);

-- =====================================================
-- MODIFICA PROFILES PER RUOLO CLIENT
-- =====================================================

-- Rimuovi constraint esistente e ricrea con ruolo client
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'profiles_role_check'
    AND table_name = 'profiles'
  ) THEN
    ALTER TABLE profiles DROP CONSTRAINT profiles_role_check;
  END IF;
END $$;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'user', 'client'));

-- =====================================================
-- TABELLA PORTAL_INVITES
-- Inviti per accesso al portal
-- =====================================================

CREATE TABLE IF NOT EXISTS portal_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'viewer' CHECK (role IN ('owner', 'member', 'viewer')),
  token TEXT UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  invited_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_portal_invites_token ON portal_invites(token);
CREATE INDEX idx_portal_invites_email ON portal_invites(email);

-- =====================================================
-- FUNZIONI HELPER
-- =====================================================

-- Funzione per ottenere i customer_id associati all'utente corrente
CREATE OR REPLACE FUNCTION get_user_customer_ids()
RETURNS UUID[] AS $$
BEGIN
  RETURN ARRAY(
    SELECT customer_id
    FROM customer_users
    WHERE user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Funzione per verificare se l'utente ha accesso a un customer
CREATE OR REPLACE FUNCTION user_has_customer_access(p_customer_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM customer_users
    WHERE user_id = auth.uid()
    AND customer_id = p_customer_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Funzione per verificare se l'utente è admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Funzione per accettare un invito
CREATE OR REPLACE FUNCTION accept_portal_invite(p_token TEXT)
RETURNS JSONB AS $$
DECLARE
  v_invite portal_invites%ROWTYPE;
  v_customer_user_id UUID;
BEGIN
  -- Trova l'invito
  SELECT * INTO v_invite
  FROM portal_invites
  WHERE token = p_token
    AND accepted_at IS NULL
    AND expires_at > NOW();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invito non valido o scaduto');
  END IF;

  -- Verifica che l'email corrisponda
  IF v_invite.email != (SELECT email FROM auth.users WHERE id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Email non corrisponde all''invito');
  END IF;

  -- Crea il collegamento customer_user
  INSERT INTO customer_users (user_id, customer_id, role, invited_by, accepted_at)
  VALUES (auth.uid(), v_invite.customer_id, v_invite.role, v_invite.invited_by, NOW())
  ON CONFLICT (user_id, customer_id) DO UPDATE SET
    role = EXCLUDED.role,
    accepted_at = NOW()
  RETURNING id INTO v_customer_user_id;

  -- Aggiorna il profilo a 'client' se non è admin
  UPDATE profiles
  SET role = 'client'
  WHERE id = auth.uid()
    AND role != 'admin';

  -- Marca l'invito come accettato
  UPDATE portal_invites SET accepted_at = NOW() WHERE id = v_invite.id;

  RETURN jsonb_build_object('success', true, 'customer_user_id', v_customer_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- RLS POLICIES PER CLIENTI
-- =====================================================

-- Abilita RLS se non già abilitato
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invites ENABLE ROW LEVEL SECURITY;

-- CUSTOMERS: Admin full access, Client solo i propri
DROP POLICY IF EXISTS "Admin full access customers" ON customers;
CREATE POLICY "Admin full access customers" ON customers
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own customer" ON customers;
CREATE POLICY "Clients view own customer" ON customers
  FOR SELECT TO authenticated
  USING (id = ANY(get_user_customer_ids()));

-- SUBSCRIPTIONS: Admin full access, Client solo le proprie
DROP POLICY IF EXISTS "Admin full access subscriptions" ON subscriptions;
CREATE POLICY "Admin full access subscriptions" ON subscriptions
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own subscriptions" ON subscriptions;
CREATE POLICY "Clients view own subscriptions" ON subscriptions
  FOR SELECT TO authenticated
  USING (customer_id = ANY(get_user_customer_ids()));

-- INVOICES: Admin full access, Client solo le proprie
DROP POLICY IF EXISTS "Admin full access invoices" ON invoices;
CREATE POLICY "Admin full access invoices" ON invoices
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own invoices" ON invoices;
CREATE POLICY "Clients view own invoices" ON invoices
  FOR SELECT TO authenticated
  USING (customer_id = ANY(get_user_customer_ids()));

-- DOMAINS: Admin full access, Client solo i propri
DROP POLICY IF EXISTS "Admin full access domains" ON domains;
CREATE POLICY "Admin full access domains" ON domains
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own domains" ON domains;
CREATE POLICY "Clients view own domains" ON domains
  FOR SELECT TO authenticated
  USING (customer_id = ANY(get_user_customer_ids()));

-- CUSTOMER_USERS: Admin full access, User vede solo le proprie associazioni
DROP POLICY IF EXISTS "Admin full access customer_users" ON customer_users;
CREATE POLICY "Admin full access customer_users" ON customer_users
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Users view own associations" ON customer_users;
CREATE POLICY "Users view own associations" ON customer_users
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- PORTAL_INVITES: Admin full access
DROP POLICY IF EXISTS "Admin full access portal_invites" ON portal_invites;
CREATE POLICY "Admin full access portal_invites" ON portal_invites
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- =====================================================
-- VISTE PORTAL
-- =====================================================

-- Vista dashboard cliente
CREATE OR REPLACE VIEW portal_dashboard AS
SELECT
  c.id AS customer_id,
  c.contact_name AS customer_name,
  c.company_name,
  (SELECT COUNT(*) FROM subscriptions WHERE customer_id = c.id AND status = 'active') AS active_subscriptions,
  (SELECT COUNT(*) FROM invoices WHERE customer_id = c.id AND status = 'open') AS pending_invoices,
  (SELECT COALESCE(SUM(amount_due), 0) FROM invoices WHERE customer_id = c.id AND status = 'open') AS total_pending,
  (SELECT COUNT(*) FROM domains WHERE customer_id = c.id AND status = 'active') AS active_domains,
  (SELECT MIN(expiration_date) FROM domains WHERE customer_id = c.id AND status = 'active') AS next_domain_expiry
FROM customers c
WHERE c.id = ANY(get_user_customer_ids());

-- Vista fatture cliente con dettagli
CREATE OR REPLACE VIEW portal_invoices AS
SELECT
  i.*,
  c.contact_name AS customer_name,
  c.company_name AS customer_company
FROM invoices i
JOIN customers c ON c.id = i.customer_id
WHERE i.customer_id = ANY(get_user_customer_ids())
ORDER BY i.created_at DESC;

-- Vista abbonamenti cliente
CREATE OR REPLACE VIEW portal_subscriptions AS
SELECT
  s.*,
  c.contact_name AS customer_name
FROM subscriptions s
JOIN customers c ON c.id = s.customer_id
WHERE s.customer_id = ANY(get_user_customer_ids())
ORDER BY s.created_at DESC;

-- Vista domini cliente
CREATE OR REPLACE VIEW portal_domains AS
SELECT
  d.*,
  c.contact_name AS customer_name,
  CASE
    WHEN d.expiration_date <= CURRENT_DATE THEN 'expired'
    WHEN d.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
    ELSE 'ok'
  END AS expiry_status
FROM domains d
JOIN customers c ON c.id = d.customer_id
WHERE d.customer_id = ANY(get_user_customer_ids())
ORDER BY d.expiration_date ASC;

-- =====================================================
-- TRIGGER UPDATED_AT
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_customer_users_updated_at ON customer_users;
CREATE TRIGGER update_customer_users_updated_at
  BEFORE UPDATE ON customer_users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON portal_dashboard TO authenticated;
GRANT SELECT ON portal_invoices TO authenticated;
GRANT SELECT ON portal_subscriptions TO authenticated;
GRANT SELECT ON portal_domains TO authenticated;
