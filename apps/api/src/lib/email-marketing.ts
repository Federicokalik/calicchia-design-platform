/**
 * Marketing email rendering + send.
 *
 * Two-stage compile so per-recipient work stays O(string-replace):
 *  1. compileCampaignTemplate(campaign) — ONCE per campaign: renders the block
 *     tree (or raw html) into an email-safe layout, rewrites links into
 *     click-tracking redirects (persisting mkt_links), and leaves placeholders
 *     __MSGID__ / __UNSUB_URL__ where per-recipient values go. Stored as
 *     mkt_campaigns.compiled_html.
 *  2. renderForMessage(compiledHtml, message) — per recipient: substitutes the
 *     placeholders and appends the open pixel. Cheap.
 *
 * Reuses sendEmail()'s transport layer via transport='marketing' (dedicated
 * Resend subdomain) and adds List-Unsubscribe headers (Gmail/Yahoo bulk rules).
 */
import { randomUUID } from 'crypto';
import { sql } from '../db';
import { sendEmail } from './email';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const SITE_URL = process.env.SITE_URL || 'https://calicchia.design';

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Block tree → email-safe HTML ──────────────────────
export interface Block {
  type: 'heading' | 'text' | 'button' | 'image' | 'divider' | 'spacer';
  text?: string;
  level?: 1 | 2 | 3;
  url?: string;
  src?: string;
  alt?: string;
  href?: string;
  size?: number;
}

function renderBlock(b: Block): string {
  switch (b.type) {
    case 'heading': {
      const sizes = { 1: 26, 2: 21, 3: 18 } as const;
      const fs = sizes[b.level ?? 2];
      return `<h${b.level ?? 2} style="margin:0 0 14px;font-size:${fs}px;line-height:1.3;color:#111827;font-weight:600">${esc(b.text)}</h${b.level ?? 2}>`;
    }
    case 'text':
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151">${esc(b.text).replace(/\n/g, '<br>')}</p>`;
    case 'button':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:6px;background-color:#111827">
        <a href="${esc(b.url) || '#'}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${esc(b.text) || 'Scopri di più'}</a>
      </td></tr></table>`;
    case 'image': {
      const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" style="max-width:100%;height:auto;border-radius:6px;display:block" />`;
      return `<div style="margin:0 0 18px">${b.href ? `<a href="${esc(b.href)}">${img}</a>` : img}</div>`;
    }
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />`;
    case 'spacer':
      return `<div style="height:${Math.max(4, Math.min(80, b.size ?? 16))}px"></div>`;
    default:
      return '';
  }
}

function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join('\n');
}

// ── Personalization tokens ────────────────────────────
// Merge tags written as {{nome}} / {{azienda|fallback}} into copy. Tokens survive
// the block compile (esc() leaves {{ }} untouched) and are resolved per-recipient
// in renderForMessage. Italian token aliases map to mkt_contacts columns.
export interface PersonalizationVars {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  role?: string | null;
  email?: string | null;
}

const TOKEN_FIELD: Record<string, keyof PersonalizationVars> = {
  nome: 'first_name',
  cognome: 'last_name',
  azienda: 'company',
  ruolo: 'role',
  email: 'email',
};

export const PERSONALIZATION_TOKENS = Object.keys(TOKEN_FIELD);

const TOKEN_RE = /\{\{\s*(nome|cognome|azienda|ruolo|email)\s*(?:\|([^}]*))?\}\}/gi;

/**
 * Replace {{token}} (optionally {{token|fallback}}) with the contact's value.
 * Empty values fall back to the provided default or ''. When the text is HTML,
 * pass escapeHtml so injected values can't break the markup.
 */
export function personalize(text: string, vars: PersonalizationVars, opts?: { escapeHtml?: boolean }): string {
  if (!text || text.indexOf('{{') === -1) return text;
  return text.replace(TOKEN_RE, (_m, key: string, fallback?: string) => {
    const field = TOKEN_FIELD[key.toLowerCase()];
    const raw = (vars[field] ?? '').toString().trim();
    const val = raw || (fallback ?? '').trim();
    return opts?.escapeHtml ? esc(val) : val;
  });
}

function wrapLayout(bodyHtml: string, preheader?: string | null): string {
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Ubuntu,sans-serif;margin:0;padding:32px 0">
  ${pre}
  <div style="background-color:#ffffff;border-radius:8px;max-width:600px;margin:0 auto;box-shadow:0 1px 3px 0 rgba(0,0,0,0.08)">
    <div style="padding:32px 40px">
      ${bodyHtml}
    </div>
    <div style="padding:20px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px">
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0 0 6px">
        Calicchia Design — <a href="${SITE_URL}" style="color:#6b7280">${SITE_URL}</a>
      </p>
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0">
        Non vuoi più ricevere queste email? <a href="__UNSUB_URL__" style="color:#2563eb;text-decoration:underline">Disiscriviti</a>
        &nbsp;|&nbsp;<a href="${SITE_URL}/privacy-policy" style="color:#6b7280">Privacy Policy</a>
      </p>
    </div>
  </div>
</body></html>`;
}

/**
 * Rewrite http(s) links in the body into click-tracking redirects, persisting a
 * mkt_links row per (campaign, url). Returns the rewritten html. Links point to
 * /api/mkt-track/c/<token>?m=__MSGID__ (the message id is filled per recipient).
 */
async function rewriteLinks(html: string, campaignId: string): Promise<string> {
  const urls = new Set<string>();
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) urls.add(m[1]);
  if (!urls.size) return html;

  const tokenByUrl = new Map<string, string>();
  for (const url of urls) {
    const token = randomUUID().replace(/-/g, '').slice(0, 22);
    const [row] = await sql`
      INSERT INTO mkt_links (campaign_id, token, original_url)
      VALUES (${campaignId}, ${token}, ${url})
      ON CONFLICT (token) DO NOTHING
      RETURNING token`;
    tokenByUrl.set(url, row?.token ?? token);
  }
  return html.replace(re, (_full, url: string) => {
    const token = tokenByUrl.get(url);
    return token ? `href="${API_URL}/api/mkt-track/c/${token}?m=__MSGID__"` : `href="${url}"`;
  });
}

/** Compile the campaign body into a reusable template (placeholders intact). */
export async function compileCampaignTemplate(campaign: {
  id: string; content_mode: string; content_blocks: unknown; content_html: string | null;
  preheader: string | null; track_clicks: boolean; track_opens: boolean;
}): Promise<string> {
  let body: string;
  if (campaign.content_mode === 'html') {
    body = campaign.content_html || '';
  } else {
    // blocks | ai → both stored as a block tree { blocks: [...] }
    const raw = campaign.content_blocks as { blocks?: Block[] } | Block[] | null;
    const blocks = Array.isArray(raw) ? raw : (raw?.blocks ?? []);
    body = renderBlocks(blocks);
  }

  let html = wrapLayout(body, campaign.preheader);
  if (campaign.track_clicks) html = await rewriteLinks(html, campaign.id);
  if (campaign.track_opens) {
    const pixel = `<img src="${API_URL}/api/mkt-track/o/__MSGID__" width="1" height="1" alt="" style="display:none" />`;
    html = html.replace('</body>', `${pixel}</body>`);
  }
  return html;
}

/**
 * Render a standalone marketing email (automation steps / transactional-marketing
 * sends) — wraps a block tree with the layout + a contact-level unsubscribe link.
 * No open/click tracking (these are 1:1 operational sends, not campaigns).
 */
export function renderStandaloneEmailHtml(
  blocks: Block[], contactUnsubToken: string, preheader?: string | null, vars?: PersonalizationVars,
): string {
  const unsubUrl = `${API_URL}/api/mkt-track/u/${contactUnsubToken}`;
  let html = wrapLayout(renderBlocks(blocks), preheader).split('__UNSUB_URL__').join(unsubUrl);
  if (vars) html = personalize(html, vars, { escapeHtml: true });
  return html;
}

/** Per-recipient render: fill placeholders + personalize + return final HTML. */
export function renderForMessage(
  compiledHtml: string, message: { id: string; unsubscribe_token: string }, vars?: PersonalizationVars,
): string {
  const unsubUrl = `${API_URL}/api/mkt-track/u/${message.unsubscribe_token}`;
  let html = compiledHtml
    .split('__MSGID__').join(message.id)
    .split('__UNSUB_URL__').join(unsubUrl);
  if (vars) html = personalize(html, vars, { escapeHtml: true });
  return html;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim()
    .slice(0, 4000);
}

/** Double-opt-in confirmation for an embeddable marketing form submission. */
export async function sendMarketingFormConfirmEmail(data: {
  to: string; name?: string | null; token: string;
}): Promise<{ success: boolean; error?: string }> {
  const confirmUrl = `${API_URL}/api/mkt-forms/confirm?token=${data.token}`;
  const greeting = data.name?.trim() ? `Ciao ${esc(data.name)},` : 'Ciao,';
  const html = wrapLayout(`
    <h1 style="margin:0 0 14px;font-size:22px;color:#111827">Conferma la tua iscrizione</h1>
    <p style="margin:0 0 16px;color:#374151;line-height:1.6">${greeting}</p>
    <p style="margin:0 0 22px;color:#374151;line-height:1.6">Per completare l'iscrizione, clicca il pulsante qui sotto.</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:6px;background:#111827">
      <a href="${confirmUrl}" style="display:inline-block;padding:12px 24px;color:#fff;text-decoration:none;font-weight:600">Conferma iscrizione</a>
    </td></tr></table>
    <p style="margin:22px 0 0;color:#9ca3af;font-size:12px;line-height:1.6">Se non hai richiesto tu l'iscrizione, ignora questa email.</p>`)
    .replace('__UNSUB_URL__', `${SITE_URL}/privacy-policy`);
  // Confirm email uses the 'critical' transport: first-touch deliverability makes
  // or breaks the GDPR consent trail.
  const res = await sendEmail({
    to: data.to, subject: 'Conferma la tua iscrizione — Calicchia Design', html,
    text: `${greeting}\n\nConferma la tua iscrizione: ${confirmUrl}`,
    transport: 'critical',
  });
  return { success: res.success, error: res.error };
}

/** Send one rendered marketing email (used by the send cron). */
export async function sendMarketingEmail(opts: {
  to: string; subject: string; html: string; from?: string; replyTo?: string; unsubscribeUrl: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const res = await sendEmail({
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: htmlToText(opts.html),
    from: opts.from,
    replyTo: opts.replyTo,
    transport: 'marketing',
    headers: {
      // One-click unsubscribe — required by Gmail/Yahoo bulk-sender rules.
      'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  return { success: res.success, messageId: res.messageId, error: res.error };
}
