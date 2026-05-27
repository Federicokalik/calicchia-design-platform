-- 112_otp_hash_attempts.sql
-- Hash OTP codes at rest and track failed attempts for /api/quote-sign and /api/sign
-- (Audit 2026-05-27 J-01). Stored OTPs were plaintext, which (i) leaked a 6-digit
-- code to anyone with DB read access and (ii) had no failure counter to limit
-- brute force within the 10-minute validity window even after rate-limit (which
-- itself was missing on quote-sign — added in app.ts in the same PR).
--
-- The new columns coexist with the legacy otp_code TEXT for one release so any
-- in-flight OTP request continues to work after deploy. otp_code is nulled by
-- the new write path; a follow-up migration will DROP it.

ALTER TABLE quotes_v2
  ADD COLUMN IF NOT EXISTS otp_hash TEXT,
  ADD COLUMN IF NOT EXISTS otp_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE signable_documents
  ADD COLUMN IF NOT EXISTS otp_hash TEXT,
  ADD COLUMN IF NOT EXISTS otp_attempts INTEGER NOT NULL DEFAULT 0;
