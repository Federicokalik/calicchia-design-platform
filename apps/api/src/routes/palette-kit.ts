/**
 * Brand kit in PDF del tool "Palette di settore" (pubblico).
 *
 *   POST /api/palette/kit           richiesta dal sito (captcha contact_form)
 *   GET  /api/palette/kit/confirm   pagina con il bottone di conferma
 *   POST /api/palette/kit/confirm   conferma (form della pagina)
 *
 * La conferma è un POST: i filtri antivirus delle caselle aprono i link in
 * GET e non devono poter confermare un'iscrizione al posto della persona.
 * La logica è in lib/palette-kit.
 */

import { Hono } from 'hono';
import { firstZodIssue } from '@calicchia/shared';
import { kitRequestSchema } from '@calicchia/shared/palette';
import { captcha } from '../lib/captcha';
import { getClientIp } from '../lib/client-ip';
import { logger } from '../lib/logger';
import { confirmBrandKit, peekBrandKitToken, requestBrandKit } from '../lib/palette-kit';

const log = logger.child({ scope: 'palette-kit' });

export const paletteKit = new Hono();

paletteKit.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = kitRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: firstZodIssue(parsed.error) }, 400);

  const ip = getClientIp(c);
  const check = await captcha.verify(parsed.data.turnstile_token ?? '', {
    remoteIp: ip ?? undefined,
    siteKeyId: 'contact_form',
  });
  if (!check.ok) return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);

  try {
    const outcome = await requestBrandKit(parsed.data, {
      ip,
      userAgent: (c.req.header('user-agent') ?? '').slice(0, 512) || null,
    });
    log.info({ outcome }, 'richiesta brand kit');
  } catch (err) {
    log.error({ err }, 'richiesta brand kit fallita');
    return c.json({ error: 'Non sono riuscito a registrare la richiesta. Riprova tra poco.' }, 500);
  }
  // Stessa risposta per ogni indirizzo: non si scopre chi è già iscritto.
  return c.json({ ok: true }, 202);
});

type PageState = 'pending' | 'confirmed' | 'already' | 'invalid' | 'error';
type PageLocale = 'it' | 'en';

const PAGE_COPY: Record<PageLocale, Record<PageState, { title: string; body: string }> & { eyebrow: string; button: string; note: string }> = {
  it: {
    eyebrow: 'Palette di settore',
    button: 'Confermo l’iscrizione',
    note: 'Ti puoi disiscrivere quando vuoi dal link in fondo a ogni email.',
    pending: {
      title: 'Conferma l’iscrizione',
      body: 'Confermando ti iscrivi alla newsletter di Calicchia Design e ricevi via email il brand kit in PDF della tua palette.',
    },
    confirmed: {
      title: 'Iscrizione confermata',
      body: 'Grazie! Il brand kit in PDF arriva nella tua casella entro pochi minuti. Se non lo vedi, controlla anche la cartella Promozioni o Spam.',
    },
    already: {
      title: 'Già confermata',
      body: 'Questa richiesta è già stata confermata: il brand kit è in arrivo o è già nella tua casella.',
    },
    invalid: {
      title: 'Link non valido',
      body: 'Il link non è valido o è scaduto (le richieste non confermate si cancellano dopo 7 giorni). Puoi chiedere di nuovo il brand kit dal tool.',
    },
    error: {
      title: 'Qualcosa non ha funzionato',
      body: 'Non sono riuscito a confermare l’iscrizione. Riprova tra qualche minuto.',
    },
  },
  en: {
    eyebrow: 'Industry colour palette',
    button: 'Confirm my subscription',
    note: 'You can unsubscribe at any time from the link at the bottom of every email.',
    pending: {
      title: 'Confirm your subscription',
      body: 'By confirming you subscribe to the Calicchia Design newsletter and get the PDF brand kit of your palette by email.',
    },
    confirmed: {
      title: 'Subscription confirmed',
      body: 'Thank you! The PDF brand kit reaches your inbox within a few minutes. If you cannot see it, check the Promotions or Spam folder too.',
    },
    already: {
      title: 'Already confirmed',
      body: 'This request has already been confirmed: the brand kit is on its way or already in your inbox.',
    },
    invalid: {
      title: 'Invalid link',
      body: 'The link is invalid or has expired (unconfirmed requests are deleted after 7 days). You can ask for the brand kit again from the tool.',
    },
    error: {
      title: 'Something went wrong',
      body: 'I could not confirm your subscription. Please try again in a few minutes.',
    },
  },
};

function page(state: PageState, locale: PageLocale, token = ''): string {
  const copy = PAGE_COPY[locale];
  const t = copy[state];
  const form =
    state === 'pending'
      ? `<form method="post" action="/api/palette/kit/confirm" style="margin:24px 0 0">
<input type="hidden" name="t" value="${token.replace(/[^0-9a-fA-F-]/g, '')}">
<input type="hidden" name="l" value="${locale}">
<button type="submit" style="font:inherit;font-weight:600;background:#F57F44;color:#111111;border:0;padding:12px 24px;cursor:pointer">${copy.button}</button>
</form>
<p style="font-size:12px;color:#8C8C86;line-height:1.6;margin:20px 0 0">${copy.note}</p>`
      : '';
  return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${t.title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FAFAF7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;box-sizing:border-box">
<div style="background:#fff;border:1px solid #E6E4DC;padding:40px;max-width:460px;text-align:left">
<p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8C8C86;margin:0 0 12px">${copy.eyebrow}</p>
<h1 style="font-size:22px;color:#111111;margin:0 0 12px">${t.title}</h1>
<p style="font-size:14px;color:#5C5C58;line-height:1.6;margin:0">${t.body}</p>${form}
</div></body></html>`;
}

/** Lingua della pagina: dal link dell'email (`l=en`), di default italiano. */
const pageLocale = (value: unknown): PageLocale => (value === 'en' ? 'en' : 'it');

const STATUS: Record<PageState, 200 | 400 | 404 | 500> = { pending: 200, confirmed: 200, already: 200, invalid: 404, error: 500 };

/** La CSP di default dell'API è deny-all: queste pagine hanno solo stili inline e il form di conferma. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

paletteKit.get('/confirm', async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  const token = c.req.query('t') ?? '';
  const locale = pageLocale(c.req.query('l'));
  try {
    const state = await peekBrandKitToken(token);
    return c.html(page(state, locale, token), STATUS[state]);
  } catch (err) {
    log.warn({ err }, 'pagina di conferma brand kit fallita');
    return c.html(page('error', locale), 500);
  }
});

paletteKit.post('/confirm', async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = typeof form.t === 'string' ? form.t : '';
  const locale = pageLocale(form.l);
  try {
    const state = await confirmBrandKit(token, getClientIp(c));
    return c.html(page(state, locale), STATUS[state]);
  } catch (err) {
    log.warn({ err }, 'conferma brand kit fallita');
    return c.html(page('error', locale), 500);
  }
});
