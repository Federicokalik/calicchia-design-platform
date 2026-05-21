-- Migration: 102_admin_mfa.sql
-- Descrizione: Colonne per la MFA TOTP degli utenti admin (SEC-06).
-- Data: 2026-05-21
--
-- mfa_secret: segreto TOTP base32, cifrato con encryptSecret() (lib/crypto.ts).
-- mfa_enabled: la MFA è attiva e richiesta al login.
-- mfa_backup_codes: array JSONB di hash bcrypt dei codici di recupero monouso.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup_codes JSONB   NOT NULL DEFAULT '[]'::jsonb;
