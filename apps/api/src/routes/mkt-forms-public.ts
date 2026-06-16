/**
 * Embeddable marketing forms — PUBLIC (not in protectedPaths).
 *   GET  /:slug/embed.js  → self-contained JS snippet (renders the form anywhere)
 *   POST /:slug/submit    → create/upsert contact + (double opt-in) confirm email
 *   GET  /confirm?token=  → confirm double opt-in
 *
 * Per-form origin allowlist + optional Turnstile captcha guard abuse. Submissions
 * never weaken a stronger consent (confirmed/unsubscribed are sticky).
 */
import { Hono } from 'hono';
import { sql } from '../db';
import { captcha } from '../lib/captcha';
import { getClientIp } from '../lib/client-ip';
import { sendMarketingFormConfirmEmail } from '../lib/email-marketing';
import { fireTrigger } from '../lib/marketing/automation';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'mkt-forms' });
export const mktFormsPublic = new Hono();

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

interface FormRow {
  id: string; slug: string; name: string; fields: { name: string; label: string; type: string; required?: boolean }[];
  success_message: string; submit_label: string; target_list_id: string | null;
  default_legal_basis: string; audience_type: string; double_optin: boolean;
  allowed_origins: string[]; captcha_site_key_id: string | null; tags: string[];
  style: { accent?: string; radius?: string }; status: string;
}

async function loadForm(slug: string): Promise<FormRow | null> {
  const [form] = await sql<FormRow[]>`SELECT * FROM mkt_forms WHERE slug = ${slug} AND status = 'active'`;
  return form ?? null;
}

function originAllowed(form: FormRow, origin: string | undefined): boolean {
  if (!form.allowed_origins.length) return true; // empty = any
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return form.allowed_origins.some((o) => o === origin || o === host || (() => { try { return new URL(o).host === host; } catch { return false; } })());
  } catch { return false; }
}

// ── embed.js ──────────────────────────────────────────
mktFormsPublic.get('/:slug/embed.js', async (c) => {
  const form = await loadForm(c.req.param('slug'));
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  if (!form) return c.body('console.error("[calicchia-form] form non trovato");');

  const apiBase = process.env.API_URL || '';
  const config = JSON.stringify({
    slug: form.slug,
    fields: form.fields,
    submitLabel: form.submit_label,
    successMessage: form.success_message,
    captcha: form.captcha_site_key_id ? true : false,
    accent: form.style?.accent || '#111827',
    radius: form.style?.radius || '8px',
    api: apiBase,
  });
  return c.body(buildEmbedJs(config));
});

// ── submit ────────────────────────────────────────────
mktFormsPublic.post('/:slug/submit', async (c) => {
  const form = await loadForm(c.req.param('slug'));
  if (!form) return c.json({ error: 'Not Found' }, 404);

  const origin = c.req.header('origin') || c.req.header('referer');
  if (!originAllowed(form, origin)) return c.json({ error: 'Origine non autorizzata' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const data: Record<string, string> = body.data ?? {};
  const email = (data.email || '').trim().toLowerCase();
  if (!isEmail(email)) return c.json({ error: 'Email non valida' }, 400);

  if (form.captcha_site_key_id) {
    const result = await captcha.verify(body.turnstile_token || '', {
      remoteIp: getClientIp(c) ?? undefined,
      siteKeyId: form.captcha_site_key_id,
    });
    if (!result.ok) return c.json({ error: 'Verifica anti-bot fallita' }, 403);
  }

  const clientIp = getClientIp(c);
  const ua = (c.req.header('user-agent') ?? '').slice(0, 512) || null;
  const consent = form.double_optin ? 'unconfirmed' : 'confirmed';

  // Upsert contact (consent-monotonic: never downgrade confirmed/unsubscribed).
  const [contact] = await sql`
    INSERT INTO mkt_contacts
      (email, first_name, last_name, phone, email_consent, email_legal_basis, audience_type,
       consent_source, consent_ip, consent_user_agent, consent_collected_at, tags)
    VALUES
      (${email}, ${data.first_name || data.name || null}, ${data.last_name || null}, ${data.phone || null},
       ${consent}, ${form.default_legal_basis}, ${form.audience_type},
       ${'form:' + form.slug}, ${clientIp}, ${ua}, now(), ${form.tags})
    ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
      first_name = COALESCE(mkt_contacts.first_name, EXCLUDED.first_name),
      phone = COALESCE(mkt_contacts.phone, EXCLUDED.phone),
      email_consent = CASE
        WHEN mkt_contacts.email_consent IN ('unsubscribed','bounced','complained','confirmed')
          THEN mkt_contacts.email_consent
        ELSE EXCLUDED.email_consent END,
      consent_ip = COALESCE(mkt_contacts.consent_ip, EXCLUDED.consent_ip),
      updated_at = now()
    RETURNING id, double_optin_token, email_consent`;

  if (form.target_list_id) {
    await sql`INSERT INTO mkt_list_members (list_id, contact_id, source)
              VALUES (${form.target_list_id}, ${contact.id}, 'form') ON CONFLICT DO NOTHING`;
  }
  await sql`INSERT INTO mkt_form_submissions (form_id, contact_id, data, consent_ip, consent_user_agent, origin)
            VALUES (${form.id}, ${contact.id}, ${sql.json(data as never)}, ${clientIp}, ${ua}, ${origin ?? null})`;

  // Double opt-in → send confirm (only if still unconfirmed). Fire-and-forget.
  if (form.double_optin && contact.email_consent === 'unconfirmed') {
    sendMarketingFormConfirmEmail({ to: email, name: data.first_name || data.name, token: contact.double_optin_token })
      .catch((err) => log.warn({ err, email }, 'form confirm email failed'));
  }

  // Fire automation triggers (fire-and-forget). form_submitted always; for a
  // single-opt-in form the contact is already confirmed → contact_created too.
  fireTrigger('form_submitted', contact.id, { formId: form.id }).catch(() => {});
  if (!form.double_optin) fireTrigger('contact_created', contact.id).catch(() => {});

  return c.json({ success: true, message: form.success_message });
});

// ── confirm ───────────────────────────────────────────
mktFormsPublic.get('/confirm', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.html(confirmPage(false), 400);
  const [updated] = await sql`
    UPDATE mkt_contacts SET email_consent = 'confirmed', consent_collected_at = now(), updated_at = now()
    WHERE double_optin_token = ${token}::uuid AND email_consent = 'unconfirmed'
    RETURNING id`;
  // Confirmed → now a real subscriber; fire the contact_created trigger.
  if (updated) fireTrigger('contact_created', updated.id).catch(() => {});
  return c.html(confirmPage(!!updated), updated ? 200 : 404);
});

function confirmPage(ok: boolean): string {
  const title = ok ? 'Iscrizione confermata' : 'Link non valido';
  const msg = ok ? 'Grazie! La tua iscrizione è confermata.' : 'Il link non è valido o è già stato usato.';
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="background:#fff;border-radius:12px;padding:40px;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)">
<h1 style="font-size:20px;color:#111827;margin:0 0 12px">${title}</h1>
<p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0">${msg}</p>
</div></body></html>`;
}

// Self-contained embeddable widget. Renders next to its own <script> tag.
function buildEmbedJs(configJson: string): string {
  return `(function(){
  var CFG = ${configJson};
  var s = document.currentScript;
  var wrap = document.createElement('div');
  wrap.style.cssText = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:420px';
  var form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  (CFG.fields || []).forEach(function(f){
    var inp = document.createElement('input');
    inp.name = f.name; inp.type = f.type || 'text'; inp.placeholder = f.label || f.name;
    if (f.required) inp.required = true;
    inp.style.cssText = 'padding:11px 13px;border:1px solid #d1d5db;border-radius:'+CFG.radius+';font-size:14px';
    form.appendChild(inp);
  });
  var btn = document.createElement('button');
  btn.type = 'submit'; btn.textContent = CFG.submitLabel || 'Iscriviti';
  btn.style.cssText = 'padding:12px;border:none;border-radius:'+CFG.radius+';background:'+CFG.accent+';color:#fff;font-size:14px;font-weight:600;cursor:pointer';
  form.appendChild(btn);
  var msg = document.createElement('p');
  msg.style.cssText = 'font-size:13px;margin:8px 0 0';
  wrap.appendChild(form); wrap.appendChild(msg);
  if (s && s.parentNode) s.parentNode.insertBefore(wrap, s.nextSibling);
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var data = {}; (CFG.fields||[]).forEach(function(f){ var el = form.elements[f.name]; if(el) data[f.name]=el.value; });
    btn.disabled = true; btn.textContent = '...';
    fetch(CFG.api + '/api/mkt-forms/' + CFG.slug + '/submit', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ data: data })
    }).then(function(r){ return r.json(); }).then(function(res){
      if (res.success) { form.style.display='none'; msg.style.color='#059669'; msg.textContent = res.message || 'Grazie!'; }
      else { msg.style.color='#dc2626'; msg.textContent = res.error || 'Errore'; btn.disabled=false; btn.textContent=CFG.submitLabel; }
    }).catch(function(){ msg.style.color='#dc2626'; msg.textContent='Errore di rete'; btn.disabled=false; btn.textContent=CFG.submitLabel; });
  });
})();`;
}
