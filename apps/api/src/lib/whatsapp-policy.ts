/**
 * WhatsApp send policy — enforcement degli opt-out per categoria.
 *
 * Tre categorie (vedi 096_whatsapp.sql + GDPR-COMPLIANCE.md):
 *   - transactional → Art. 6(1)(b) GDPR. Sempre consentito (fatture, scadenze,
 *                     sicurezza). NON disattivabile dal cliente.
 *   - operational   → Art. 6(1)(f). Default ON, cliente può fare opt-out
 *                     (reminder appuntamenti, follow-up progetti).
 *   - marketing     → Art. 6(1)(a). Default OFF, richiede opt-in esplicito
 *                     (offerte, broadcast).
 *
 * Tutti gli invii outbound (admin compose, AI tool, workflow node, cron) DEVONO
 * passare per canSendWhatsApp() prima di chiamare sendWhatsAppText/Media.
 */

import { sql } from '../db';
import { formatPhone } from './whatsapp';

export type WhatsAppCategory = 'transactional' | 'operational' | 'marketing';

export interface PolicyCheck {
  allowed: boolean;
  reason?: 'opt_out_operational' | 'opt_out_marketing' | 'missing_phone';
  preferencesId?: string;
}

interface CommPrefsRow {
  id: string;
  whatsapp_operational: boolean;
  whatsapp_marketing: boolean;
}

interface LookupHint {
  customerId?: string | null;
  leadId?: string | null;
}

async function lookupPreferences(phone: string, hint?: LookupHint): Promise<CommPrefsRow | null> {
  // Lookup gerarchico: customer_id > lead_id > phone match.
  if (hint?.customerId) {
    const rows = await sql`
      SELECT id, whatsapp_operational, whatsapp_marketing
      FROM communication_preferences
      WHERE customer_id = ${hint.customerId}
      LIMIT 1
    ` as CommPrefsRow[];
    if (rows[0]) return rows[0];
  }
  if (hint?.leadId) {
    const rows = await sql`
      SELECT id, whatsapp_operational, whatsapp_marketing
      FROM communication_preferences
      WHERE lead_id = ${hint.leadId}
      LIMIT 1
    ` as CommPrefsRow[];
    if (rows[0]) return rows[0];
  }
  const rows = await sql`
    SELECT id, whatsapp_operational, whatsapp_marketing
    FROM communication_preferences
    WHERE phone = ${phone}
    ORDER BY updated_at DESC
    LIMIT 1
  ` as CommPrefsRow[];
  return rows[0] || null;
}

/**
 * Verifica se è consentito inviare un messaggio WA al numero indicato per la
 * categoria data. Se non esiste alcuna riga preferences, applica i default:
 *   transactional → allowed
 *   operational   → allowed (default ON)
 *   marketing     → blocked (default OFF — opt-in richiesto)
 */
export async function canSendWhatsApp(
  phone: string,
  category: WhatsAppCategory,
  hint?: LookupHint
): Promise<PolicyCheck> {
  if (!phone) return { allowed: false, reason: 'missing_phone' };
  if (category === 'transactional') return { allowed: true };

  const normalized = formatPhone(phone);
  const prefs = await lookupPreferences(normalized, hint);

  if (category === 'operational') {
    if (!prefs) return { allowed: true }; // default ON
    return prefs.whatsapp_operational
      ? { allowed: true, preferencesId: prefs.id }
      : { allowed: false, reason: 'opt_out_operational', preferencesId: prefs.id };
  }

  // marketing
  if (!prefs) return { allowed: false, reason: 'opt_out_marketing' };
  return prefs.whatsapp_marketing
    ? { allowed: true, preferencesId: prefs.id }
    : { allowed: false, reason: 'opt_out_marketing', preferencesId: prefs.id };
}

/**
 * Trova-o-crea la riga preferences per un dato phone (auto-link a customer
 * se trovato tramite phone match). Usato dalla portal page e dal flusso STOP.
 */
export async function ensurePreferencesByPhone(phone: string): Promise<string> {
  const normalized = formatPhone(phone);
  const existing = await sql`
    SELECT id FROM communication_preferences
    WHERE phone = ${normalized}
    ORDER BY updated_at DESC LIMIT 1
  ` as Array<{ id: string }>;
  if (existing[0]) return existing[0].id;

  // Prova ad attaccare a un customer esistente per phone.
  const customer = await sql`
    SELECT id FROM customers WHERE phone IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = ${normalized}
    LIMIT 1
  ` as Array<{ id: string }>;

  const inserted = await sql`
    INSERT INTO communication_preferences (customer_id, phone)
    VALUES (${customer[0]?.id ?? null}, ${normalized})
    RETURNING id
  ` as Array<{ id: string }>;
  return inserted[0].id;
}

/**
 * Marca tutti gli opt-out non-transactional per un phone (usato dal flusso "STOP"
 * via WA in entrata e dai link pubblici).
 */
export async function applyStopAll(phone: string, via: string): Promise<void> {
  const normalized = formatPhone(phone);
  const id = await ensurePreferencesByPhone(normalized);
  await sql`
    UPDATE communication_preferences
    SET whatsapp_operational = FALSE,
        whatsapp_marketing = FALSE,
        email_marketing = FALSE,
        updated_via = ${via},
        updated_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Marca opt-out marketing only ("STOP MARKETING") — mantiene operational.
 */
export async function applyStopMarketing(phone: string, via: string): Promise<void> {
  const normalized = formatPhone(phone);
  const id = await ensurePreferencesByPhone(normalized);
  await sql`
    UPDATE communication_preferences
    SET whatsapp_marketing = FALSE,
        email_marketing = FALSE,
        updated_via = ${via},
        updated_at = now()
    WHERE id = ${id}
  `;
}
