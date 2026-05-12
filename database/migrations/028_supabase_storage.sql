-- Migration: 028_supabase_storage.sql
-- Descrizione: Crea bucket Supabase Storage pubblico per media/immagini
-- Sostituisce MEGA S4 (S3-compatible) con Supabase Storage nativo
-- Data: 2026-02-23

-- ============================================
-- 1. BUCKET PUBBLICO 'media'
-- ============================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media',
  'media',
  true,
  52428800, -- 50MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/svg+xml', 'image/avif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 52428800;

-- ============================================
-- 2. RLS POLICIES
-- ============================================

-- Lettura pubblica (bucket già pubblico, ma esplicito per chiarezza)
DROP POLICY IF EXISTS "Public read media" ON storage.objects;
CREATE POLICY "Public read media" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'media');

-- Upload solo admin autenticati
DROP POLICY IF EXISTS "Admin upload media" ON storage.objects;
CREATE POLICY "Admin upload media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'media'
    AND EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- Cancellazione solo admin
DROP POLICY IF EXISTS "Admin delete media" ON storage.objects;
CREATE POLICY "Admin delete media" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'media'
    AND EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- Update solo admin
DROP POLICY IF EXISTS "Admin update media" ON storage.objects;
CREATE POLICY "Admin update media" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'media'
    AND EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );
