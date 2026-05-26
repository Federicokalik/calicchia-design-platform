/**
 * First-contact GDPR disclaimer for WhatsApp outbound.
 *
 * L16 della checklist GDPR (`whatsapp first contact con disclaimer
 * preferenze`). Al primo messaggio outbound verso un numero che non ha mai
 * ricevuto un messaggio dal nostro device WhatsApp, aggiungiamo un blocco
 * informativo standard con:
 *  - chi sta scrivendo e da quale numero
 *  - link alla pagina preferenze del portale clienti
 *  - istruzioni per opt-out via reply "STOP"
 *  - link all'informativa privacy completa
 *
 * Questa disclosure soddisfa l'obbligo di informativa al primo contatto
 * (art. 13 GDPR) e rende il canale WA conforme alla decisione Garante 330/2025
 * che richiede informativa preventiva accessibile e canali di opt-out chiari.
 *
 * Il rilevamento "primo contatto" si basa sull'assenza di qualunque message
 * outbound precedente nella tabella `whatsapp_messages` per il phone target.
 * Il phone viene normalizzato via formatPhone() per gestire le varianti di
 * input (con/senza +39, spazi, parentesi).
 */

import { sql } from '../db';
import { formatPhone } from './whatsapp';

const SITE_BASE = (process.env.PUBLIC_SITE_URL || 'https://calicchia.design').replace(/\/+$/, '');

/**
 * Template di default del disclaimer. Conservalo conciso: WhatsApp tronca i
 * messaggi lunghi nelle preview e un wall-of-text al primo contatto e`
 * controproducente.
 *
 * L'admin puo` sovrascrivere questo template dalla pagina "Impostazioni →
 * WhatsApp" salvando `whatsapp.first_contact_disclaimer` in site_settings.
 * Se la setting e` vuota si usa questo default.
 */
export const FIRST_CONTACT_DISCLAIMER_DEFAULT = [
  '—',
  'Sono Federico (Calicchia Design). Questo numero WhatsApp e` ufficiale e lo uso solo per comunicazioni legate ai nostri rapporti professionali.',
  '',
  `Gestione preferenze: ${SITE_BASE}/clienti/preferenze`,
  'Opt-out totale: rispondi "STOP". Opt-out solo offerte: "STOP MARKETING".',
  `Informativa privacy: ${SITE_BASE}/privacy-policy`,
].join('\n');

/**
 * Backwards-compat: alcuni moduli importavano `FIRST_CONTACT_DISCLAIMER` come
 * costante. Lo manteniamo esportato come alias del default per non rompere
 * le import-path esistenti; per logica di runtime usa `getFirstContactDisclaimer()`.
 */
export const FIRST_CONTACT_DISCLAIMER = FIRST_CONTACT_DISCLAIMER_DEFAULT;

/**
 * Legge il template attivo da `site_settings.whatsapp.first_contact_disclaimer`.
 * Se la setting e` vuota / mancante / il DB e` irraggiungibile, ritorna il
 * default. Fail-open coerente con `hasPriorOutboundTo`: la disclosure deve
 * arrivare anche se la setting non e` leggibile.
 */
export async function getFirstContactDisclaimer(): Promise<string> {
  try {
    const rows = (await sql`
      SELECT value FROM site_settings WHERE key = 'whatsapp' LIMIT 1
    `) as Array<{ value: { first_contact_disclaimer?: unknown } | null }>;
    const raw = rows[0]?.value?.first_contact_disclaimer;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  } catch {
    // ignore — fall back to default
  }
  return FIRST_CONTACT_DISCLAIMER_DEFAULT;
}

/**
 * Sentinel string usata per riconoscere se un messaggio contiene gia` il
 * disclaimer (evita la doppia accodatura se un admin lo include manualmente
 * o se il messaggio e` stato gia` arricchito a monte).
 *
 * NOTE: se l'admin sovrascrive il template rimuovendo il link
 * `/clienti/preferenze`, il rilevamento anti-doppio non funziona per il
 * template custom. La pagina Impostazioni avvisa l'utente di mantenere la
 * stringa nel template per preservare la guardia.
 */
const DISCLAIMER_SENTINEL = '/clienti/preferenze';

export function alreadyHasDisclaimer(body: string): boolean {
  return body.includes(DISCLAIMER_SENTINEL);
}

/**
 * True se a questo numero abbiamo gia` inviato almeno un messaggio outbound.
 *
 * Fail-open: in caso di errore DB ritorna `true` (= disclaimer non aggiunto)
 * per evitare di bloccare outbound transazionali (es. notifica fattura) per
 * un'indisponibilita` temporanea del database. La compliance e` una proprieta`
 * statistica della popolazione di outbound, un singolo skip in caso di
 * incidente DB e` accettabile vs il rischio di bloccare la consegna.
 */
export async function hasPriorOutboundTo(phone: string): Promise<boolean> {
  const target = formatPhone(phone);
  if (!target) return true;
  try {
    const rows = (await sql`
      SELECT 1
      FROM whatsapp_conversations c
      JOIN whatsapp_messages m ON m.conversation_id = c.id
      WHERE c.phone = ${target}
        AND m.direction = 'outbound'
      LIMIT 1
    `) as Array<{ '?column?'?: number }>;
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * Compone il messaggio finale aggiungendo il disclaimer al primo contatto.
 * Ritorna `original` invariato se:
 *   - e` gia` presente un disclaimer
 *   - il numero ha gia` ricevuto outbound
 *
 * Usato internamente da `sendWhatsAppText` e `sendWhatsAppMedia`; non serve
 * chiamarlo a mano dai consumer del modulo whatsapp.
 */
export async function attachDisclaimerIfFirstContact(
  phone: string,
  original: string,
): Promise<string> {
  if (!original) return original;
  if (alreadyHasDisclaimer(original)) return original;
  const seen = await hasPriorOutboundTo(phone);
  if (seen) return original;
  const disclaimer = await getFirstContactDisclaimer();
  return `${original}\n\n${disclaimer}`;
}
