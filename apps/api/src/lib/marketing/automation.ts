/**
 * Marketing automations — enrollment, triggers, and step execution.
 *
 * A trigger enrolls a contact into an active automation (idempotent: UNIQUE
 * (automation_id, contact_id)). The cron advances each enrollment, running the
 * step at current_step_order then scheduling the next after its delay. Delivery
 * reuses the campaign send paths (marketing email transport / WhatsApp policy).
 */
import { sql } from '../../db';
import {
  renderStandaloneEmailHtml, sendMarketingEmail, personalize, type Block, type PersonalizationVars,
} from '../email-marketing';
import { sendWhatsAppText } from '../whatsapp';
import { canSendWhatsApp } from '../whatsapp-policy';
import { logger } from '../logger';

const log = logger.child({ scope: 'mkt-automation' });
const API_URL = process.env.API_URL || 'http://localhost:3001';

/** Enroll one contact into one automation, scheduling its first step. */
export async function enrollContact(automationId: string, contactId: string): Promise<void> {
  const [first] = await sql`
    SELECT step_order, delay_minutes FROM mkt_automation_steps
    WHERE automation_id = ${automationId} ORDER BY step_order LIMIT 1`;
  if (!first) return; // automation has no steps
  await sql`
    INSERT INTO mkt_automation_runs (automation_id, contact_id, current_step_order, next_run_at)
    VALUES (${automationId}, ${contactId}, ${first.step_order}, now() + make_interval(mins => ${first.delay_minutes}))
    ON CONFLICT (automation_id, contact_id) DO NOTHING`;
}

/**
 * Fire a trigger: enroll the contact into every active automation whose
 * trigger_type matches (and, where relevant, whose trigger_config matches the
 * context — e.g. list_id / form_id). Fire-and-forget from the calling route.
 */
export async function fireTrigger(
  triggerType: 'contact_created' | 'tag_added' | 'list_joined' | 'form_submitted' | 'manual',
  contactId: string,
  ctx: { listId?: string; formId?: string; tag?: string } = {},
): Promise<void> {
  try {
    const automations = await sql`
      SELECT id, trigger_config FROM mkt_automations
      WHERE status = 'active' AND trigger_type = ${triggerType}`;
    for (const a of automations) {
      const cfg = a.trigger_config ?? {};
      if (triggerType === 'list_joined' && cfg.list_id && cfg.list_id !== ctx.listId) continue;
      if (triggerType === 'form_submitted' && cfg.form_id && cfg.form_id !== ctx.formId) continue;
      if (triggerType === 'tag_added' && cfg.tag && cfg.tag !== ctx.tag) continue;
      await enrollContact(a.id, contactId);
    }
  } catch (err) {
    log.warn({ err, triggerType, contactId }, 'fireTrigger failed');
  }
}

interface ContactRow {
  id: string; email: string | null; email_consent: string; email_norm: string | null;
  phone: string | null; customer_id: string | null; lead_id: string | null;
  unsubscribe_token: string; first_name: string | null; last_name: string | null;
  company: string | null; role: string | null;
}

function contactVars(c: ContactRow): PersonalizationVars {
  return { first_name: c.first_name, last_name: c.last_name, company: c.company, role: c.role, email: c.email };
}

/** Execute a single automation step against a contact. Throws on hard failure. */
export async function executeStep(
  step: { action_type: string; action_config: Record<string, unknown> },
  contact: ContactRow,
): Promise<void> {
  const cfg = step.action_config ?? {};
  switch (step.action_type) {
    case 'wait':
      return;

    case 'add_tag': {
      const tag = String(cfg.tag ?? '').trim();
      if (tag) await sql`UPDATE mkt_contacts SET tags = (SELECT array(SELECT DISTINCT unnest(tags || ${[tag]}::text[]))), updated_at = now() WHERE id = ${contact.id}`;
      return;
    }

    case 'send_email': {
      if (!contact.email) return;
      // Eligibility: never send to opted-out / suppressed contacts.
      if (['unsubscribed', 'bounced', 'complained'].includes(contact.email_consent)) return;
      if (contact.email_norm) {
        const [supp] = await sql`SELECT 1 FROM mkt_suppression WHERE email_norm = ${contact.email_norm}`;
        if (supp) return;
      }
      const blocks = (cfg.blocks as Block[]) ?? [];
      const rawSubject = String(cfg.subject ?? '');
      if (!rawSubject || !blocks.length) return;
      const vars = contactVars(contact);
      const subject = personalize(rawSubject, vars);
      const html = renderStandaloneEmailHtml(blocks, contact.unsubscribe_token, cfg.preheader as string | undefined, vars);
      await sendMarketingEmail({
        to: contact.email, subject, html,
        unsubscribeUrl: `${API_URL}/api/mkt-track/u/${contact.unsubscribe_token}`,
      });
      return;
    }

    case 'send_whatsapp': {
      if (!contact.phone) return;
      const rawBody = String(cfg.body ?? '');
      if (!rawBody) return;
      const body = personalize(rawBody, contactVars(contact));
      const policy = await canSendWhatsApp(contact.phone, 'marketing', { customerId: contact.customer_id, leadId: contact.lead_id });
      if (!policy.allowed) return;
      await sendWhatsAppText(contact.phone, body);
      return;
    }

    default:
      log.warn({ action: step.action_type }, 'unknown automation action');
  }
}
