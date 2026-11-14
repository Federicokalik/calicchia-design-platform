/**
 * Ciclo di vita della proforma (design: docs/proforma/design.md).
 *
 *   draft ──issue──▶ issued ──send──▶ sent ──mark-paid──▶ converted
 *     │                 │               │
 *     └────────────── cancel ───────────┘──▶ cancelled
 *
 * - draft: righe e importi modificabili, nessun numero.
 * - issue: numero PF n/anno (automatico o indicato), snapshot di cliente,
 *   fornitore e diciture, importi ricalcolati con le impostazioni correnti,
 *   PDF. Dopo l'emissione importi e righe non cambiano.
 * - mark-paid: in UNA transazione crea la fattura (bozza, salvo richiesta
 *   esplicita "paid"), rinnova i domini delle righe domain_renewal e segna la
 *   proforma convertita. Idempotente: una seconda chiamata restituisce la
 *   fattura già creata.
 */
import { createHash } from 'node:crypto';
import { jsonb, sql } from '../../db';
import { logger } from '../logger';
import { billingRecipients } from '../customer-recipients';
import { effectiveFiscal } from '../customers/fiscal';
import { readPrivateFile, savePrivateFile, signFileUrl } from '../private-files';
import { htmlToPdf } from '../pdf/render';
import { DomainRenewError, renewDomain } from '../domains/renew';
import { assignProformaNumber, ProformaNumberConflict, parseProformaNumber } from './numbering';
import { renderProformaHtml, formatDateIt, type ProformaCustomerSnapshot } from './render';
import { buildLegalNotes, loadProformaSettings, type ProformaSettings, type ProformaSupplier } from './settings';
import { computeProformaTotals, formatEuro, type ProformaLine, type ProformaLineInput } from './totals';

const log = logger.child({ scope: 'proforma' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
type Tx = any;

export type ProformaStatus = 'draft' | 'issued' | 'sent' | 'converted' | 'cancelled';

export interface ProformaRow {
  id: string;
  year: number | null;
  seq: number | null;
  number: string | null;
  status: ProformaStatus;
  customer_id: string;
  customer_snapshot: ProformaCustomerSnapshot | null;
  issue_date: string | null;
  due_date: string | null;
  line_items: ProformaLine[];
  subtotal_cents: number;
  stamp_duty_cents: number;
  total_cents: number;
  currency: string;
  regime: string | null;
  legal_notes: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  pdf_generated_at: string | null;
  sent_at: string | null;
  sent_to: string[];
  sent_message_id: string | null;
  paid_at: string | null;
  payment_method: string | null;
  paid_amount_cents: number | null;
  converted_invoice_id: string | null;
  domain_id: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class ProformaError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 = 400, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProformaError';
  }
}

const COLUMNS = () => sql`
  p.id, p.year, p.seq, p.number, p.status, p.customer_id, p.customer_snapshot,
  p.issue_date::text AS issue_date, p.due_date::text AS due_date, p.line_items,
  p.subtotal_cents, p.stamp_duty_cents, p.total_cents, p.currency, p.regime, p.legal_notes,
  p.pdf_path, p.pdf_sha256, p.pdf_generated_at, p.sent_at, p.sent_to, p.sent_message_id,
  p.paid_at, p.payment_method, p.paid_amount_cents, p.converted_invoice_id, p.domain_id,
  p.cancelled_at, p.cancel_reason, p.notes, p.metadata, p.created_at, p.updated_at
`;

/** Proforma per le risposte API: importi anche in euro, URL firmato del PDF. */
export function presentProforma(row: ProformaRow & { customer_name?: string | null; domain_name?: string | null }) {
  const pdfName = row.pdf_path?.startsWith('proformas/') ? row.pdf_path.slice('proformas/'.length) : null;
  return {
    ...row,
    subtotal: row.subtotal_cents / 100,
    stamp_duty: row.stamp_duty_cents / 100,
    total: row.total_cents / 100,
    total_label: formatEuro(row.total_cents),
    pdf_url: pdfName ? signFileUrl('proformas', pdfName) : null,
  };
}

export async function getProforma(id: string, tx: Tx = sql, lock = false): Promise<ProformaRow | null> {
  const [row] = await tx`
    SELECT ${COLUMNS()} FROM proformas p WHERE p.id = ${id} ${lock ? tx`FOR UPDATE` : tx``}
  `;
  return (row as ProformaRow) ?? null;
}

export async function listProformas(filters: { status?: string; customer_id?: string; domain_id?: string; year?: number; limit?: number }) {
  const where = [
    filters.status ? sql`AND p.status = ${filters.status}` : sql``,
    filters.customer_id ? sql`AND p.customer_id = ${filters.customer_id}` : sql``,
    filters.domain_id ? sql`AND p.domain_id = ${filters.domain_id}` : sql``,
    filters.year ? sql`AND p.year = ${filters.year}` : sql``,
  ];
  const rows = await sql`
    SELECT ${COLUMNS()}, COALESCE(c.company_name, c.contact_name) AS customer_name, d.full_domain AS domain_name
    FROM proformas p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN domains d ON d.id = p.domain_id
    WHERE 1=1 ${where[0]} ${where[1]} ${where[2]} ${where[3]}
    ORDER BY COALESCE(p.year, 9999) DESC, p.seq DESC NULLS FIRST, p.created_at DESC
    LIMIT ${Math.min(filters.limit ?? 100, 500)}
  `;
  return rows as unknown as Array<ProformaRow & { customer_name: string | null; domain_name: string | null }>;
}

// ─── Creazione e modifica della bozza ───────────────────────────────

export interface DraftInput {
  customer_id: string;
  lines: ProformaLineInput[];
  due_days?: number;
  notes?: string | null;
  domain_id?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Impostazioni validate per una proforma. Va chiamata FUORI dalle
 * transazioni: legge con il pool, e una transazione che aspetta una
 * connessione del pool mentre ne tiene una può esaurirlo (con 10+ emissioni
 * concorrenti il processo si bloccava).
 */
export async function loadIssueSettings(): Promise<ProformaSettings> {
  return assertSupportedRegime();
}

async function assertSupportedRegime(): Promise<ProformaSettings> {
  const settings = await loadProformaSettings();
  if (settings.regime === 'ordinario') {
    throw new ProformaError('Le proforma sono supportate solo in regime forfettario (freelancer.studio.vat_regime)', 422, { regime: settings.regime });
  }
  return settings;
}

export async function createProformaDraft(input: DraftInput, tx: Tx = sql): Promise<ProformaRow> {
  const settings = await assertSupportedRegime();
  if (!input.lines.length) throw new ProformaError('Serve almeno una riga', 400);
  const [customer] = await tx`SELECT id FROM customers WHERE id = ${input.customer_id}`;
  if (!customer) throw new ProformaError('customer_id: cliente inesistente', 400);

  if (input.domain_id) {
    const [open] = await tx`SELECT id, number, status FROM proformas WHERE domain_id = ${input.domain_id} AND status IN ('draft','issued','sent') LIMIT 1`;
    if (open) throw new ProformaError(`Esiste già una proforma aperta per questo dominio${open.number ? ` (${open.number})` : ''}`, 409, { existing: open });
  }

  const totals = computeProformaTotals(input.lines, { applyStampDuty: true, stampDuty: settings.stampDuty });
  try {
    const [row] = await tx`
      INSERT INTO proformas ${tx({
        customer_id: input.customer_id,
        line_items: jsonb(totals.lines),
        subtotal_cents: totals.subtotal_cents,
        stamp_duty_cents: totals.stamp_duty_cents,
        total_cents: totals.total_cents,
        regime: settings.regime,
        notes: input.notes ?? null,
        domain_id: input.domain_id ?? null,
        metadata: jsonb({ ...(input.metadata ?? {}), due_days: input.due_days ?? settings.defaultDueDays }),
      })}
      RETURNING id
    `;
    return (await getProforma(row.id, tx))!;
  } catch (err) {
    // Gara fra due creazioni: l'indice unico proformas_open_per_domain_idx decide.
    if ((err as { code?: string }).code === '23505' && input.domain_id) {
      throw new ProformaError('Esiste già una proforma aperta per questo dominio', 409);
    }
    throw err;
  }
}

export async function updateProformaDraft(id: string, patch: Partial<Omit<DraftInput, 'domain_id'>>): Promise<ProformaRow> {
  const settings = await assertSupportedRegime();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin(async (tx: any) => {
    const current = await getProforma(id, tx, true);
    if (!current) throw new ProformaError('Proforma non trovata', 404);
    if (current.status !== 'draft') throw new ProformaError(`Solo le bozze sono modificabili (stato: ${current.status})`, 409);
    if (patch.customer_id) {
      const [customer] = await tx`SELECT id FROM customers WHERE id = ${patch.customer_id}`;
      if (!customer) throw new ProformaError('customer_id: cliente inesistente', 400);
    }
    const updates: Record<string, unknown> = {};
    if (patch.customer_id) updates.customer_id = patch.customer_id;
    if (patch.notes !== undefined) updates.notes = patch.notes;
    if (patch.lines) {
      if (!patch.lines.length) throw new ProformaError('Serve almeno una riga', 400);
      const lines = patch.lines.map((l) => ({ ...l }));
      const totals = computeProformaTotals(lines, { applyStampDuty: true, stampDuty: settings.stampDuty });
      Object.assign(updates, {
        line_items: jsonb(totals.lines),
        subtotal_cents: totals.subtotal_cents,
        stamp_duty_cents: totals.stamp_duty_cents,
        total_cents: totals.total_cents,
      });
    }
    if (patch.due_days !== undefined || patch.metadata) {
      updates.metadata = jsonb({ ...current.metadata, ...(patch.metadata ?? {}), ...(patch.due_days !== undefined ? { due_days: patch.due_days } : {}) });
    }
    if (Object.keys(updates).length) await tx`UPDATE proformas SET ${tx(updates)} WHERE id = ${id}`;
    return (await getProforma(id, tx))!;
  });
}

// ─── Emissione ───────────────────────────────

async function customerSnapshot(tx: Tx, customerId: string): Promise<ProformaCustomerSnapshot> {
  const [c] = await tx`
    SELECT id, contact_name, company_name, email, billing_emails, billing_address,
           vat_number, fiscal_code, sdi_code, pec
    FROM customers WHERE id = ${customerId}
  `;
  if (!c) throw new ProformaError('Cliente della proforma non trovato', 422);
  const billing = (c.billing_address && typeof c.billing_address === 'object' ? c.billing_address : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const fiscal = effectiveFiscal(c);
  return {
    name: c.company_name || c.contact_name,
    contact_name: c.contact_name,
    company_name: c.company_name,
    email: c.email,
    recipients: billingRecipients(c),
    address: {
      street: s(billing.street),
      postal_code: s(billing.postal_code),
      city: s(billing.city),
      province: s(billing.province),
      country: s(billing.country) ?? 'IT',
    },
    ...fiscal,
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Oggi nel fuso di Roma (le date dei documenti sono date civili italiane). */
export function todayRome(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
}

export interface IssueInput {
  issue_date?: string;
  /** Numero indicato a mano: 3, "3", "3/2026" o "PF 3/2026". */
  number?: string | number;
}

export interface IssueResult {
  proforma: ProformaRow;
  pdf_error?: string;
}

/**
 * Emissione dentro una transazione esistente (senza PDF: va generato dopo il
 * commit). `settings` da loadIssueSettings(), caricate prima della transazione.
 */
export async function issueProformaTx(tx: Tx, id: string, input: IssueInput, settings: ProformaSettings): Promise<ProformaRow> {
  if (!settings.supplier.name) {
    throw new ProformaError('Dati del fornitore mancanti: compila la ragione sociale in Impostazioni → Preventivi (quote.settings) o nel profilo aziendale', 422);
  }
  const current = await getProforma(id, tx, true);
  if (!current) throw new ProformaError('Proforma non trovata', 404);
  if (current.status !== 'draft') throw new ProformaError(`La proforma è già emessa (${current.number ?? current.status})`, 409);

  const issueDate = input.issue_date ?? todayRome();
  let explicit: { seq: number; year?: number } | null = null;
  if (input.number !== undefined && input.number !== null && input.number !== '') {
    explicit = parseProformaNumber(input.number);
    if (!explicit) throw new ProformaError('number: formato non valido (es. 3, "3/2026" o "PF 3/2026")', 400);
  }
  const year = explicit?.year ?? Number(issueDate.slice(0, 4));

  // Importi ricalcolati con le impostazioni di oggi (soglia e importo del bollo).
  const serviceLines: ProformaLineInput[] = current.line_items
    .filter((l) => l.kind !== 'stamp_duty')
    .map((l) => ({
      kind: l.kind === 'domain_renewal' ? 'domain_renewal' : 'service',
      description: l.description,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
      ...(l.domain_id ? { domain_id: l.domain_id } : {}),
      ...(l.years ? { years: l.years } : {}),
    }));
  const totals = computeProformaTotals(serviceLines, { applyStampDuty: true, stampDuty: settings.stampDuty });

  let seq: number;
  try {
    seq = await assignProformaNumber(tx, year, explicit?.seq);
  } catch (err) {
    if (err instanceof ProformaNumberConflict) throw new ProformaError(err.message, 409);
    throw err;
  }
  const dueDays = Number(current.metadata?.due_days ?? settings.defaultDueDays);
  await tx`
    UPDATE proformas SET ${tx({
      year,
      seq,
      status: 'issued',
      issue_date: issueDate,
      due_date: addDays(issueDate, Number.isFinite(dueDays) ? dueDays : settings.defaultDueDays),
      customer_snapshot: jsonb(await customerSnapshot(tx, current.customer_id)),
      line_items: jsonb(totals.lines),
      subtotal_cents: totals.subtotal_cents,
      stamp_duty_cents: totals.stamp_duty_cents,
      total_cents: totals.total_cents,
      regime: settings.regime,
      legal_notes: buildLegalNotes(settings, totals.stamp_duty_cents > 0),
      metadata: jsonb({ ...current.metadata, supplier: settings.supplier }),
    })}
    WHERE id = ${id}
  `;
  return (await getProforma(id, tx))!;
}

/** Emissione + PDF. Se il PDF fallisce la proforma resta emessa: si rigenera con /pdf. */
export async function issueProforma(id: string, input: IssueInput = {}): Promise<IssueResult> {
  const settings = await loadIssueSettings();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  const issued = await sql.begin((tx: any) => issueProformaTx(tx, id, input, settings));
  try {
    return { proforma: await generateProformaPdf(issued.id) };
  } catch (err) {
    log.error({ err, proformaId: id }, 'PDF della proforma non generato');
    return { proforma: issued, pdf_error: (err as Error).message };
  }
}

// ─── PDF ───────────────────────────────

function pdfFileName(row: ProformaRow): string {
  return `PF-${row.seq}-${row.year}-${row.id.slice(0, 8)}.pdf`;
}

export function renderInputFor(row: ProformaRow) {
  if (!row.number || !row.issue_date || !row.customer_snapshot) {
    throw new ProformaError('La proforma non è ancora emessa: nessun PDF', 409);
  }
  return {
    number: row.number,
    issue_date: row.issue_date,
    due_date: row.due_date,
    customer: row.customer_snapshot,
    supplier: (row.metadata?.supplier ?? {}) as ProformaSupplier,
    lines: row.line_items,
    subtotal_cents: row.subtotal_cents,
    stamp_duty_cents: row.stamp_duty_cents,
    total_cents: row.total_cents,
    legal_notes: row.legal_notes ?? '',
    notes: row.notes,
  };
}

export async function generateProformaPdf(id: string): Promise<ProformaRow> {
  const row = await getProforma(id);
  if (!row) throw new ProformaError('Proforma non trovata', 404);
  if (row.status === 'draft') throw new ProformaError('La proforma è in bozza: emettila prima di generare il PDF', 409);
  const pdf = await htmlToPdf(renderProformaHtml(renderInputFor(row)));
  const name = pdfFileName(row);
  await savePrivateFile('proformas', name, pdf);
  await sql`
    UPDATE proformas SET pdf_path = ${`proformas/${name}`},
      pdf_sha256 = ${createHash('sha256').update(pdf).digest('hex')},
      pdf_generated_at = now()
    WHERE id = ${id}
  `;
  return (await getProforma(id))!;
}

/** Byte del PDF (generato ora se manca). */
export async function proformaPdf(id: string): Promise<{ row: ProformaRow; buffer: Buffer; filename: string }> {
  let row = await getProforma(id);
  if (!row) throw new ProformaError('Proforma non trovata', 404);
  if (!row.pdf_path) row = await generateProformaPdf(id);
  const name = row.pdf_path!.slice('proformas/'.length);
  const buffer = await readPrivateFile('proformas', name);
  return { row, buffer, filename: `Proforma ${row.number!.replace(/^PF\s*/, '').replace('/', '-')}.pdf` };
}

// ─── Annullamento ───────────────────────────────

export async function cancelProforma(id: string, reason?: string | null): Promise<ProformaRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin(async (tx: any) => {
    const current = await getProforma(id, tx, true);
    if (!current) throw new ProformaError('Proforma non trovata', 404);
    if (current.status === 'converted') throw new ProformaError('Proforma già pagata e convertita in fattura: non annullabile', 409);
    if (current.status === 'cancelled') return current;
    await tx`UPDATE proformas SET status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason ?? null} WHERE id = ${id}`;
    return (await getProforma(id, tx))!;
  });
}

// ─── Pagamento → fattura ───────────────────────────────

export interface MarkPaidInput {
  paid_at?: string;
  payment_method?: string | null;
  /** Importo incassato in euro (default: totale della proforma). */
  amount?: number;
  /**
   * Stato della fattura creata: 'draft' (default, decisione 4: da rivedere
   * prima dell'invio SDI) oppure 'paid' solo se richiesto esplicitamente.
   */
  invoice_status?: 'draft' | 'paid';
  invoice_number?: string | null;
}

export interface MarkPaidResult {
  proforma: ProformaRow;
  invoice: Record<string, unknown>;
  renewals: Array<{ domain_id: string; full_domain: string | null; expiration_before: string; expiration_after: string }>;
  warnings: string[];
  already_converted: boolean;
}

export async function markProformaPaid(id: string, input: MarkPaidInput = {}): Promise<MarkPaidResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin(async (tx: any) => {
    const current = await getProforma(id, tx, true);
    if (!current) throw new ProformaError('Proforma non trovata', 404);
    if (current.status === 'converted' && current.converted_invoice_id) {
      const [invoice] = await tx`SELECT * FROM invoices WHERE id = ${current.converted_invoice_id}`;
      return { proforma: current, invoice, renewals: [], warnings: [], already_converted: true };
    }
    if (current.status !== 'issued' && current.status !== 'sent') {
      throw new ProformaError(`Solo una proforma emessa o inviata può essere segnata pagata (stato: ${current.status})`, 409);
    }

    const paidAt = input.paid_at ?? new Date().toISOString();
    const paidAmountCents = input.amount !== undefined ? Math.round(input.amount * 100) : current.total_cents;
    const invoicePaid = input.invoice_status === 'paid';
    const total = current.total_cents / 100;
    const lineItems = current.line_items.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price_cents / 100,
      amount: l.amount_cents / 100,
      kind: l.kind === 'stamp_duty' ? 'stamp_duty' : 'service',
    }));

    const [invoice] = await tx`
      INSERT INTO invoices ${tx({
        customer_id: current.customer_id,
        status: invoicePaid ? 'paid' : 'draft',
        invoice_number: input.invoice_number ?? null,
        source: 'proforma',
        line_items: jsonb(lineItems),
        subtotal: total,
        tax: 0,
        tax_amount: 0,
        tax_rate: 0,
        total,
        currency: current.currency,
        amount_due: invoicePaid ? 0 : total,
        amount_paid: invoicePaid ? paidAmountCents / 100 : 0,
        payment_status: invoicePaid ? 'paid' : 'unpaid',
        paid_at: invoicePaid ? paidAt : null,
        notes: `Da proforma ${current.number}, pagata il ${formatDateIt(paidAt.slice(0, 10))}${input.payment_method ? ` (${input.payment_method})` : ''}.`,
      })}
      RETURNING *
    `;

    const renewals: MarkPaidResult['renewals'] = [];
    const warnings: string[] = [];
    for (const line of current.line_items) {
      if (line.kind !== 'domain_renewal' || !line.domain_id) continue;
      try {
        const r = await renewDomain(tx, line.domain_id, {
          years: line.years ?? 1,
          cost: line.amount_cents / 100,
          invoiceId: invoice.id,
          notes: `Pagamento proforma ${current.number}`,
        });
        renewals.push({
          domain_id: line.domain_id,
          full_domain: (r.domain.full_domain as string) ?? null,
          expiration_before: r.renewal.expiration_before,
          expiration_after: r.renewal.expiration_after,
        });
      } catch (err) {
        if (err instanceof DomainRenewError && err.status === 404) {
          warnings.push(`Dominio ${line.domain_id} non trovato: scadenza non aggiornata`);
          continue;
        }
        throw err;
      }
    }

    await tx`
      UPDATE proformas SET status = 'converted', paid_at = ${paidAt}, payment_method = ${input.payment_method ?? null},
        paid_amount_cents = ${paidAmountCents}, converted_invoice_id = ${invoice.id}
      WHERE id = ${id}
    `;
    if (paidAmountCents !== current.total_cents) {
      warnings.push(`Importo incassato (${formatEuro(paidAmountCents)}) diverso dal totale della proforma (${formatEuro(current.total_cents)})`);
    }
    return { proforma: (await getProforma(id, tx))!, invoice, renewals, warnings, already_converted: false };
  });
}

// ─── Rinnovo dominio ───────────────────────────────

export interface DomainRenewalInput {
  years?: number;
  /** Prezzo per anno in euro (default: domains.renewal_cost). */
  unit_price?: number;
  due_days?: number;
  notes?: string | null;
}

function addYearsIso(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y + years, m - 1, d));
  // 29 febbraio → 28 febbraio negli anni non bisestili, come make_interval in SQL.
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** Bozza di proforma per il rinnovo di un dominio (riga domain_renewal collegata). */
export async function createDomainRenewalDraft(domainId: string, input: DomainRenewalInput = {}): Promise<ProformaRow> {
  const years = input.years ?? 1;
  if (!Number.isInteger(years) || years < 1 || years > 10) throw new ProformaError('years: intero fra 1 e 10', 400);
  const [domain] = await sql`
    SELECT id, customer_id, full_domain, expiration_date::text AS expiration_date, renewal_cost
    FROM domains WHERE id = ${domainId}
  `;
  if (!domain) throw new ProformaError('Dominio non trovato', 404);
  const unitPrice = input.unit_price ?? (domain.renewal_cost !== null ? Number(domain.renewal_cost) : undefined);
  if (unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw new ProformaError('unit_price: indica il prezzo del rinnovo (il dominio non ha renewal_cost)', 400);
  }
  const newExpiry = addYearsIso(domain.expiration_date, years);
  return createProformaDraft({
    customer_id: domain.customer_id,
    domain_id: domain.id,
    due_days: input.due_days,
    notes: input.notes ?? null,
    lines: [{
      kind: 'domain_renewal',
      description: `Rinnovo dominio ${domain.full_domain} – ${years} ${years === 1 ? 'anno' : 'anni'} (scadenza ${formatDateIt(domain.expiration_date)} → ${formatDateIt(newExpiry)})`,
      quantity: years,
      unit_price_cents: Math.round(unitPrice * 100),
      domain_id: domain.id,
      years,
    }],
  });
}
