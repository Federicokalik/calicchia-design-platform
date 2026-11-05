/**
 * Invio della proforma via email con il PDF allegato.
 *
 * L'allegato si risolve LATO SERVER dal PDF della proforma (generato ora se
 * manca): nessun base64 o URL passa dalla richiesta, quindi via MCP basta
 * l'id. Destinatari di default: billing_emails del cliente (altrimenti
 * email). L'invio usa la casella collegata (lib/mail/outbound.ts) con copia
 * in Inviati; in alternativa si crea una bozza in Posta da rivedere.
 */
import { createHash } from 'node:crypto';
import { sql } from '../../db';
import { billingRecipients } from '../customer-recipients';
import type { ResolvedAttachment } from '../mail/attachments';
import { createDraft, type DraftRow } from '../mail/drafts';
import type { MailAddress } from '../mail/message-schema';
import { loadOutboundAccount, sendFromAccount, type OutboundResult } from '../mail/outbound';
import { formatDateIt } from './render';
import { formatEuro } from './totals';
import { getProforma, ProformaError, proformaPdf, type ProformaRow } from './service';

export interface ProformaMailInput {
  account_id?: string;
  to?: MailAddress[];
  cc?: MailAddress[];
  subject?: string;
  text?: string;
}

async function attachmentFor(id: string): Promise<{ row: ProformaRow; attachment: ResolvedAttachment }> {
  const { row, buffer, filename } = await proformaPdf(id);
  return {
    row,
    attachment: {
      filename,
      contentType: 'application/pdf',
      content: buffer,
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      source: 'private',
    },
  };
}

function domainOf(row: ProformaRow): string | null {
  const line = row.line_items.find((l) => l.kind === 'domain_renewal');
  return line ? (/Rinnovo dominio (\S+)/.exec(line.description)?.[1] ?? null) : null;
}

export function defaultProformaSubject(row: ProformaRow): string {
  const domain = domainOf(row);
  return `Proforma ${row.number}${domain ? ` – rinnovo dominio ${domain}` : ''}`;
}

export function defaultProformaText(row: ProformaRow): string {
  const name = row.customer_snapshot?.contact_name || row.customer_snapshot?.name || '';
  const domain = domainOf(row);
  return [
    `Buongiorno${name ? ` ${name}` : ''},`,
    '',
    `in allegato la proforma ${row.number} di ${formatEuro(row.total_cents)}${domain ? ` per il rinnovo del dominio ${domain}` : ''}.`,
    row.due_date ? `Il pagamento è da effettuare entro il ${formatDateIt(row.due_date)} con bonifico, indicando nella causale "Saldo proforma ${row.number}".` : '',
    'Al ricevimento del pagamento emetterò la fattura.',
    '',
    'Grazie e buona giornata.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

async function recipientsFor(row: ProformaRow, override?: MailAddress[]): Promise<MailAddress[]> {
  if (override?.length) return override;
  const [c] = await sql<Array<{ email: string | null; billing_emails: string[] | null }>>`
    SELECT email, billing_emails FROM customers WHERE id = ${row.customer_id}
  `;
  const list = c ? billingRecipients(c) : [];
  if (!list.length) throw new ProformaError('Il cliente non ha indirizzi email (né billing_emails né email): indica "to"', 422);
  return list.map((address) => ({ name: '', address }));
}

function assertSendable(row: ProformaRow | null): asserts row is ProformaRow {
  if (!row) throw new ProformaError('Proforma non trovata', 404);
  if (row.status === 'draft') throw new ProformaError('La proforma è in bozza: emettila prima di inviarla', 409);
  if (row.status === 'cancelled') throw new ProformaError('La proforma è annullata', 409);
}

export interface SendProformaResult {
  proforma: ProformaRow;
  delivery: OutboundResult;
  to: string[];
}

export async function sendProforma(id: string, input: ProformaMailInput = {}): Promise<SendProformaResult> {
  assertSendable(await getProforma(id));
  const { row, attachment } = await attachmentFor(id);
  const to = await recipientsFor(row, input.to);
  const account = await loadOutboundAccount(null, input.account_id);
  if (!account) throw new ProformaError(input.account_id ? 'Casella email (account_id) non trovata' : 'Nessuna casella email configurata in Posta', 422);

  // Errori SMTP: MailDeliveryError, gestita dalla route (502).
  const delivery = await sendFromAccount(account, {
    to,
    cc: input.cc,
    subject: input.subject?.trim() || defaultProformaSubject(row),
    text: input.text?.trim() || defaultProformaText(row),
    attachments: [attachment],
  });

  await sql`
    UPDATE proformas SET
      status = CASE WHEN status = 'issued' THEN 'sent' ELSE status END,
      sent_at = now(),
      sent_to = ${to.map((a) => a.address)}::text[],
      sent_message_id = ${delivery.messageId}
    WHERE id = ${id}
  `;
  return { proforma: (await getProforma(id))!, delivery, to: to.map((a) => a.address) };
}

/** Bozza in Posta con il PDF allegato: la proforma resta 'issued' finché non viene inviata. */
export async function draftProformaEmail(id: string, input: ProformaMailInput = {}): Promise<{ proforma: ProformaRow; draft: DraftRow }> {
  assertSendable(await getProforma(id));
  const { row, attachment } = await attachmentFor(id);
  const to = await recipientsFor(row, input.to);
  const account = await loadOutboundAccount(null, input.account_id);
  if (!account) throw new ProformaError(input.account_id ? 'Casella email (account_id) non trovata' : 'Nessuna casella email configurata in Posta', 422);
  const draft = await createDraft({
    userId: account.user_id,
    accountId: account.id,
    to,
    cc: input.cc ?? [],
    subject: input.subject?.trim() || defaultProformaSubject(row),
    body: input.text?.trim() || defaultProformaText(row),
    inReplyToMsgid: null,
    replyToMessageId: null,
    source: 'manual',
    attachments: [attachment],
  });
  return { proforma: row, draft };
}
