-- =============================================
-- 000_INIT.SQL
-- Bootstrap: users table + auth schema stubs
-- =============================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_bytes() used by 008_client_portal

-- Supabase-style role stubs (legacy migrations reference these as policy grantees).
-- Created as NOLOGIN noop roles; security is enforced by the Hono auth middleware,
-- not by RLS (which is disabled at the end of the migration runner).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT;
  END IF;
END $$;

-- Auth schema stub (for FK compatibility with legacy migrations)
CREATE SCHEMA IF NOT EXISTS auth;

-- Stub auth.users table so FK REFERENCES auth.users(id) still compile
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  raw_user_meta_data JSONB DEFAULT '{}'
);

-- Stub auth.uid() used in RLS policy bodies
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT current_setting('app.user_id', true)::uuid;
$$ LANGUAGE SQL STABLE;

-- =============================================
-- OUR REAL USERS TABLE (with passwords)
-- =============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'admin' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Trigger: keep updated_at current
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_users_updated_at();

-- =============================================
-- SHARED HELPER FUNCTIONS (used by later migrations)
-- =============================================

-- Used in 005 and others as update_updated_at()
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Used in 001 and others as update_updated_at_column()
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Stub is_admin() used in RLS policy bodies (returns true since superuser bypasses RLS anyway)
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
  SELECT true;
$$ LANGUAGE SQL STABLE;
