-- 118_audit_triggers_extension.sql
-- Audit J-K-06 / Codex D-011. Migration 012 wired audit_trigger_function only
-- to customers/invoices/quotes/client_projects/domains/subscriptions/profiles/
-- customer_users/invoice_settings. Destructive operations on workflows, the
-- WhatsApp tables and the calendar tables (DELETE/cancel/archive/restore/
-- import via the admin routes) never produced an audit_logs row — the UI
-- surfaces /api/audit-logs but those events are invisible there.
--
-- Extending the trigger to the missing tables. The trigger function (defined
-- in 012) is SECURITY DEFINER and self-skips on `audit_logs`, so re-applying
-- is safe and the columns the trigger reads (created_at, updated_at, …) are
-- present on every target.

DO $$
BEGIN
  -- Some target tables may not exist yet on legacy databases (whatsapp tables
  -- ship in mig 096/110). Wrap each CREATE TRIGGER in an IF EXISTS check.
  IF to_regclass('public.workflows') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_workflows ON workflows;
    CREATE TRIGGER audit_workflows
      AFTER INSERT OR UPDATE OR DELETE ON workflows
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
  END IF;

  IF to_regclass('public.whatsapp_conversations') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_whatsapp_conversations ON whatsapp_conversations;
    CREATE TRIGGER audit_whatsapp_conversations
      AFTER INSERT OR UPDATE OR DELETE ON whatsapp_conversations
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
  END IF;

  IF to_regclass('public.whatsapp_scheduled_messages') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_whatsapp_scheduled_messages ON whatsapp_scheduled_messages;
    CREATE TRIGGER audit_whatsapp_scheduled_messages
      AFTER INSERT OR UPDATE OR DELETE ON whatsapp_scheduled_messages
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
  END IF;

  IF to_regclass('public.calendars') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_calendars ON calendars;
    CREATE TRIGGER audit_calendars
      AFTER INSERT OR UPDATE OR DELETE ON calendars
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
  END IF;

  IF to_regclass('public.calendar_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_calendar_events ON calendar_events;
    CREATE TRIGGER audit_calendar_events
      AFTER INSERT OR UPDATE OR DELETE ON calendar_events
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
  END IF;

  IF to_regclass('public.calendar_subscriptions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_calendar_subscriptions ON calendar_subscriptions;
    CREATE TRIGGER audit_calendar_subscriptions
      AFTER INSERT OR UPDATE OR DELETE ON calendar_subscriptions
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
  END IF;
END
$$;
