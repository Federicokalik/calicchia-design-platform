-- 119_drop_orphan_tables.sql
-- Audit J-K-12 / E-010. Drops tables + views that were created by historical
-- migrations and have ZERO consumers in apps/api, apps/admin, apps/sito-v3
-- (verified via grep on the codebase 2026-05-27). Conservative scope:
--
--  - Only includes targets with grep count = 0 across all three apps.
--  - SKIPS translation sidecars (subscriptions_translations, client_projects_translations,
--    timeline_events_translations) — they're loaded via sql(table) dynamic
--    identifier in lib/portal-i18n.ts:64-74 (Judge addendum flagged the codex
--    claim as a false positive).
--  - SKIPS tld_pricing — referenced in workflow nodes allowlist (lib/workflow/
--    nodes.ts:68).
--  - SKIPS customer_users — superseded by mig 056 but the data may still
--    matter for legacy queries; leave the empty shell.
--  - SKIPS WooCommerce tables — mig 081 already dropped what it could; the
--    rest may require careful per-table verification.
--
-- All DROPs are IF EXISTS + CASCADE so re-applying on a partially-cleaned DB
-- is safe. Views are dropped before tables in case any view references one
-- of the doomed tables.

-- ── Views (drop first to release table dependencies) ───────────────────
DROP VIEW IF EXISTS active_customers       CASCADE;
DROP VIEW IF EXISTS active_blog_posts      CASCADE;
DROP VIEW IF EXISTS active_client_projects CASCADE;
DROP VIEW IF EXISTS active_domains         CASCADE;
DROP VIEW IF EXISTS active_invoices        CASCADE;
DROP VIEW IF EXISTS active_projects        CASCADE;
DROP VIEW IF EXISTS active_quotes          CASCADE;
DROP VIEW IF EXISTS audit_by_table         CASCADE;
DROP VIEW IF EXISTS expiring_ssl           CASCADE;
DROP VIEW IF EXISTS customer_revenue       CASCADE;
DROP VIEW IF EXISTS customer_domains_summary CASCADE;
DROP VIEW IF EXISTS blog_post_revision_history CASCADE;
DROP VIEW IF EXISTS blog_schedule_status     CASCADE;

-- ── Tables (no remaining code references — verified 2026-05-27) ─────────
DROP TABLE IF EXISTS ai_actions_log              CASCADE;
DROP TABLE IF EXISTS ai_conversations            CASCADE;
DROP TABLE IF EXISTS dashboard_layouts           CASCADE;
