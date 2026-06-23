import { Hono } from 'hono';
import { geoAuditScanSchema, geoAuditUnlockSchema, firstZodIssue } from '@calicchia/shared';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { getClientIp } from '../lib/client-ip';
import { captcha } from '../lib/captcha';
import { runDeterministicAudit, type GeoCheck } from '../lib/geo-audit';
import { generateText } from '../lib/agent/llm-router';
import { GEO_WHITEPAPER_PLAYBOOK } from '../lib/geo-whitepaper-context';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'geo-audit-route' });

export const geoAudit = new Hono();

// Marks geo-audit leads in the pipeline (see admin GeoAuditPanel).
const GEO_LEAD_SOURCE = 'geo-audit';

interface AdminAction {
  title: string;
  priority: 'alta' | 'media' | 'bassa';
  why: string;
  how: string;
}
interface AiActions {
  userSummary: string;
  adminActions: AdminAction[];
}

// ─── Public: run the deterministic scan, return a teaser ──────────────────────

geoAudit.post('/scan', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = geoAuditScanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: firstZodIssue(parsed.error) }, 400);
  }
  const { url, locale } = parsed.data;

  let result;
  try {
    result = await runDeterministicAudit(url);
  } catch (err) {
    log.warn({ err, url }, 'geo audit scan failed');
    const msg = err instanceof Error ? err.message : 'Analisi non riuscita';
    return c.json({ error: `Impossibile analizzare il sito: ${msg}` }, 422);
  }

  const [row] = await sql`
    INSERT INTO geo_audits (url, score, breakdown, locale, ip)
    VALUES (
      ${result.finalUrl},
      ${result.score},
      ${sql.json(result.checks as unknown as Parameters<typeof sql.json>[0])},
      ${locale},
      ${getClientIp(c)}
    )
    RETURNING id
  `;

  // Teaser: score + the two most impactful failed checks (or top passing ones).
  const failed = result.checks.filter((ck) => ck.passed === false).sort((a, b) => b.weight - a.weight);
  const teaser = (failed.length ? failed : result.checks.filter((ck) => ck.passed))
    .slice(0, 2)
    .map((ck) => ({ id: ck.id, label: ck.label, passed: ck.passed }));

  return c.json({
    auditId: row.id,
    url: result.finalUrl,
    score: result.score,
    totalChecks: result.checks.filter((ck) => ck.passed !== null).length,
    passedChecks: result.checks.filter((ck) => ck.passed === true).length,
    topFindings: teaser,
  });
});

// ─── Public: unlock the full report with an email (generates the lead) ─────────

geoAudit.post('/unlock', async (c) => {
  const body = await c.req.json().catch(() => ({}));

  // Anti-bot on lead creation: reuse the public contact-form site key (already
  // configured in prod; skipped in dev when CAP_URL is unset).
  const { turnstile_token } = body as { turnstile_token?: string };
  const captchaResult = await captcha.verify(turnstile_token || '', {
    remoteIp: getClientIp(c) ?? undefined,
    siteKeyId: 'contact_form',
  });
  if (!captchaResult.ok) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  const parsed = geoAuditUnlockSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: firstZodIssue(parsed.error) }, 400);
  }
  const { audit_id, email, name, wants_intervention } = parsed.data;

  const [audit] = await sql`
    SELECT id, url, score, breakdown, ai_actions, lead_id
    FROM geo_audits WHERE id = ${audit_id}
  `;
  if (!audit) return c.json({ error: 'Audit non trovato' }, 404);

  const checks = audit.breakdown as GeoCheck[];

  // Idempotent: if already unlocked, return the stored report (no second lead).
  if (audit.lead_id && audit.ai_actions) {
    return c.json({ url: audit.url, score: audit.score, checks, aiActions: audit.ai_actions });
  }

  const aiActions = await generateActions(audit.url, audit.score, checks);

  // Create contact + lead (mirrors the website-form path in routes/contacts.ts).
  const contactName = name || email.split('@')[0];
  const message = `Richiesta da GEO Audit per ${audit.url} — score ${audit.score}/100.`;
  let leadId: string | null = null;
  try {
    const [contact] = await sql`
      INSERT INTO contacts (name, email, message, gdpr_consent, lead_source, consent_ip, consent_user_agent)
      VALUES (${contactName}, ${email}, ${message}, true, ${GEO_LEAD_SOURCE}, ${getClientIp(c)}, ${c.req.header('user-agent') || null})
      RETURNING id
    `;
    const intent = wants_intervention === false ? ' [autonomo]' : wants_intervention === true ? ' [vuole intervento]' : '';
    const [lead] = await sql`
      INSERT INTO leads (name, email, source, source_id, status, notes)
      VALUES (${contactName}, ${email}, 'website_form', ${contact.id}, 'new', ${`GEO Audit ${audit.url} — ${audit.score}/100${intent}`})
      RETURNING id
    `;
    leadId = lead.id;

    await sql`
      UPDATE geo_audits
      SET email = ${email}, contact_id = ${contact.id}, lead_id = ${lead.id},
          ai_actions = ${sql.json(aiActions as unknown as Parameters<typeof sql.json>[0])},
          wants_intervention = ${wants_intervention ?? null}
      WHERE id = ${audit_id}
    `;

    import('../lib/telegram').then(({ notifyTelegram }) => {
      notifyTelegram('🔎 Nuovo lead GEO Audit', `${email}\n${audit.url} — ${audit.score}/100${intent}`);
    }).catch((err) => log.error({ err }, 'Telegram notify failed'));
  } catch (err) {
    log.error({ err }, 'geo audit unlock: lead creation failed');
    // Still return the report — losing the lead row shouldn't block the user.
  }

  return c.json({ url: audit.url, score: audit.score, checks, aiActions, leadId });
});

// ─── Admin: fetch the audit attached to a lead (pipeline detail) ──────────────

geoAudit.get('/by-lead/:leadId', authMiddleware, async (c) => {
  const leadId = c.req.param('leadId');
  const [row] = await sql`
    SELECT id, url, score, breakdown, ai_actions, wants_intervention, created_at
    FROM geo_audits WHERE lead_id = ${leadId}
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!row) return c.json({ audit: null });
  return c.json({
    audit: {
      id: row.id,
      url: row.url,
      score: row.score,
      checks: row.breakdown,
      aiActions: row.ai_actions,
      wantsIntervention: row.wants_intervention,
      createdAt: row.created_at,
    },
  });
});

// ─── AI action plan (with deterministic fallback) ─────────────────────────────

async function generateActions(url: string, score: number, checks: GeoCheck[]): Promise<AiActions> {
  const failed = checks.filter((ck) => ck.passed === false);
  try {
    const system =
      'Sei un consulente GEO (Generative Engine Optimization). L\'obiettivo è rendere il sito più ' +
      'CITABILE dai motori AI (ChatGPT, Perplexity, Google AI, Claude): i bot di retrieval AI vanno ' +
      'AMMESSI in robots.txt (mai bloccati), il contenuto va reso server-side, ben strutturato e ricco ' +
      'di statistiche e fonti. Lo score misura readiness tecnica, non garantisce citazioni né ranking. ' +
      'llms.txt è solo readiness opzionale, non un fattore provato. Ricevi i risultati di un audit ' +
      'tecnico e produci un piano di azioni concreto. Rispondi SOLO con JSON valido, in italiano, senza testo extra. Schema: ' +
      '{"userSummary": string (2-3 frasi per il proprietario del sito), "adminActions": [{"title": ' +
      'string, "priority": "alta"|"media"|"bassa", "why": string, "how": string}]}. Basati solo sui ' +
      'criteri falliti riportati. Massimo 6 azioni, ordinate per priorità. Usa il riferimento GEO ' +
      'qui sotto per rendere le istruzioni concrete e citare le leve giuste.\n\n' +
      GEO_WHITEPAPER_PLAYBOOK;
    const user =
      `URL: ${url}\nScore GEO: ${score}/100\n\nCriteri falliti:\n` +
      (failed.length
        ? failed.map((ck) => `- ${ck.label}: ${ck.detail}`).join('\n')
        : 'Nessuno: il sito supera tutti i criteri principali.');

    // Cap the LLM call so a slow/unreachable provider never hangs the unlock
    // request — fall back to the deterministic template instead.
    const raw = await Promise.race([
      generateText('chat', [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { temperature: 0.3, max_tokens: 1200 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM timeout')), 30_000),
      ),
    ]);

    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as AiActions;
    if (parsed && typeof parsed.userSummary === 'string' && Array.isArray(parsed.adminActions)) {
      return parsed;
    }
    throw new Error('shape non valida');
  } catch (err) {
    log.warn({ err }, 'AI action generation failed, using template fallback');
    return templateActions(score, failed);
  }
}

function templateActions(score: number, failed: GeoCheck[]): AiActions {
  const adminActions: AdminAction[] = failed
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((ck) => ({
      title: `Migliorare: ${ck.label}`,
      priority: ck.weight >= 20 ? 'alta' : ck.weight >= 10 ? 'media' : 'bassa',
      why: ck.detail,
      how: 'Vedi la sezione corrispondente del white paper per l’intervento operativo.',
    }));
  return {
    userSummary: failed.length
      ? `Il sito ottiene ${score}/100 sulla visibilità nei motori AI. I principali interventi riguardano ${failed.slice(0, 3).map((c) => c.label.toLowerCase()).join(', ')}.`
      : `Il sito ottiene ${score}/100: supera tutti i criteri tecnici principali per la visibilità nei motori AI.`,
    adminActions,
  };
}
