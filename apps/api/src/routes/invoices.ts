import { Hono } from 'hono';
import { sql } from '../db';
import {
  generateFatturaPAXml,
  type FatturaPAConfig,
  type FatturaPACustomer,
  type FatturaPAInvoice,
  type FatturaPALineItem,
} from '../lib/sdi/xml';
import {
  getDefaultSettingValue,
  validateSettingValue,
  type SettingKey,
} from '../lib/settings-schema';

export const invoices = new Hono();

invoices.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');
  const search = c.req.query('search');

  const statusFilter = status && status !== 'all' ? sql`AND i.status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND i.customer_id = ${customerId}` : sql``;
  const searchFilter = search
    ? sql`AND (i.invoice_number ILIKE ${'%' + search + '%'} OR i.notes ILIKE ${'%' + search + '%'})`
    : sql``;

  const rows = await sql`
    SELECT i.*,
      jsonb_build_object('id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name, 'email', c.email) AS customers
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE 1=1 ${statusFilter} ${customerFilter} ${searchFilter}
    ORDER BY i.issue_date DESC
  `;

  const now = new Date();
  const stats = {
    total: rows.length,
    draft: rows.filter((i) => i.status === 'draft').length,
    open: rows.filter((i) => i.status === 'open').length,
    sent: rows.filter((i) => i.status === 'open' && i.sent_at).length,
    paid: rows.filter((i) => i.status === 'paid').length,
    overdue: rows.filter((i) => i.status === 'open' && i.due_date && new Date(i.due_date as string) < now).length,
    total_amount: rows.reduce((acc, i) => acc + ((i.total as number) || (i.amount_due as number) || 0), 0),
    paid_amount: rows.reduce((acc, i) => acc + (i.status === 'paid' ? ((i.total as number) || (i.amount_due as number) || 0) : 0), 0),
  };

  return c.json({ invoices: rows, stats });
});

invoices.get('/:id', async (c) => {
  const id = c.req.param('id');

  const rows = await sql`
    SELECT i.*, to_jsonb(c.*) AS customers
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ${id}
  `;

  if (!rows.length) return c.json({ error: 'Fattura non trovata' }, 404);
  return c.json({ invoice: rows[0] });
});

invoices.post('/', async (c) => {
  const body = await c.req.json();
  const { status: _s, amount_due: _ad, issue_date, ...rest } = body;

  const [invoice] = await sql`
    INSERT INTO invoices ${sql({
      ...rest,
      status: 'draft',
      amount_due: body.total,
      issue_date: issue_date || new Date().toISOString().split('T')[0],
    })}
    RETURNING *
  `;

  return c.json({ invoice }, 201);
});

invoices.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const [invoice] = await sql`UPDATE invoices SET ${sql(body)} WHERE id = ${id} RETURNING *`;
  return c.json({ invoice });
});

function resolveStatus(body: Record<string, any>): { status: string; extra: Record<string, any> } {
  const actionMap: Record<string, string> = { issue: 'open', send: 'open', pay: 'paid', void: 'void' };
  const status = body.action ? (actionMap[body.action] || body.action) : body.status;
  const extra: Record<string, any> = {};

  if (body.action === 'send') extra.sent_at = new Date().toISOString();
  if (status === 'paid') {
    extra.paid_at = body.paid_at || new Date().toISOString();
    extra.amount_due = 0;
    if (body.amount) extra.amount_paid = body.amount;
  }

  return { status, extra };
}

invoices.put('/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, extra } = resolveStatus(body);

  const [invoice] = await sql`UPDATE invoices SET ${sql({ status, ...extra })} WHERE id = ${id} RETURNING *`;
  return c.json({ invoice });
});

invoices.post('/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, extra } = resolveStatus(body);

  const [invoice] = await sql`UPDATE invoices SET ${sql({ status, ...extra })} WHERE id = ${id} RETURNING *`;
  return c.json({ invoice });
});

invoices.delete('/:id', async (c) => {
  await sql`DELETE FROM invoices WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// ── SDI / FatturaPA XML generation ─────────────────────────────────────
//
// Generates the FatturaPA 1.2.2 XML on-demand from invoice + customer +
// site_settings (regime forfettario). The bytes aren't persisted — they're
// deterministic — but we record `sdi_xml_generated_at`, `sdi_xml_filename`,
// and bump `sdi_status` to 'generated' on first run. Later lifecycle states
// ('sent'/'accepted'/'rejected') are reserved for when an intermediario or
// PEC transmission is wired up.

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function loadSetting<K extends SettingKey>(key: K) {
  const rows = (await sql`
    SELECT value FROM site_settings WHERE key = ${key} LIMIT 1
  `) as Array<{ value: unknown }>;
  const raw = rows[0]?.value;
  const parsed = validateSettingValue(key, raw);
  return parsed.success ? parsed.data : getDefaultSettingValue(key);
}

/**
 * The admin "Impostazioni → Profilo" form writes flat keys (address_street,
 * address_zip, address_city, address_province, tax_code, pec) via passthrough,
 * but the canonical zod schema defines a nested `address` object with
 * `street/city/postal_code/country`. Read both shapes, prefer whichever has
 * a real value.
 */
function buildCedenteConfig(profile: AnyRecord): {
  config?: FatturaPAConfig;
  missing: string[];
} {
  const nested = isRecord(profile.address) ? profile.address : {};
  const vat = str(profile.vat_number);
  const fiscal = str(profile.fiscal_code) ?? str(profile.tax_code);
  const street = str(profile.address_street) ?? str(nested.street);
  const postalCode = str(profile.address_zip) ?? str(nested.postal_code);
  const city = str(profile.address_city) ?? str(nested.city);
  const province = str(profile.address_province) ?? str(nested.province);
  const country = str(profile.address_country) ?? str(nested.country) ?? 'IT';
  const companyName = str(profile.company_name) ?? str(profile.legal_name);

  const missing: string[] = [];
  if (!vat) missing.push('business.profile.vat_number');
  if (!fiscal) missing.push('business.profile.fiscal_code (o tax_code)');
  if (!street) missing.push('business.profile.address_street');
  if (!postalCode) missing.push('business.profile.address_zip');
  if (!city) missing.push('business.profile.address_city');
  if (!province) missing.push('business.profile.address_province');
  if (!companyName) missing.push('business.profile.company_name (o legal_name)');

  if (missing.length > 0 || !vat || !fiscal || !street || !postalCode || !city || !province) {
    return { missing };
  }

  return {
    missing: [],
    config: {
      vat_number: vat,
      fiscal_code: fiscal,
      company_name: companyName,
      address: { street, postal_code: postalCode, city, province, country },
    },
  };
}

function buildCessionarioCustomer(customer: AnyRecord): {
  customer?: FatturaPACustomer;
  missing: string[];
} {
  const billing = isRecord(customer.billing_address) ? customer.billing_address : {};
  const name = str(customer.company_name) ?? str(customer.contact_name);
  const vat = str(billing.vat_number);
  const fiscal = str(billing.fiscal_code);
  const street = str(billing.street);
  const postalCode = str(billing.postal_code);
  const city = str(billing.city);
  const province = str(billing.province);
  const country = str(billing.country) ?? 'IT';
  const sdiCode = str(billing.sdi_code);
  const pec = str(billing.pec_email) ?? str(customer.pec_email);
  const isCompany = Boolean(str(customer.company_name));

  const missing: string[] = [];
  if (!name) missing.push('customer.contact_name (o company_name)');
  if (!vat && !fiscal) missing.push('customer.billing_address.vat_number (o fiscal_code)');
  if (!street) missing.push('customer.billing_address.street');
  if (!postalCode) missing.push('customer.billing_address.postal_code');
  if (!city) missing.push('customer.billing_address.city');
  if (!province) missing.push('customer.billing_address.province');

  if (missing.length > 0 || !name || !street || !postalCode || !city || !province) {
    return { missing };
  }

  return {
    missing: [],
    customer: {
      name,
      vat_number: vat,
      fiscal_code: fiscal,
      sdi_code: sdiCode,
      pec_email: pec,
      is_company: isCompany,
      address: { street, postal_code: postalCode, city, province, country },
    },
  };
}

function buildInvoicePayload(row: AnyRecord): {
  invoice?: FatturaPAInvoice;
  missing: string[];
} {
  const id = str(row.id);
  const invoiceNumber = str(row.invoice_number);
  const issueDateRaw = row.issue_date;
  const issueDate = issueDateRaw instanceof Date
    ? issueDateRaw.toISOString().slice(0, 10)
    : str(issueDateRaw)?.slice(0, 10);
  const total = Number(row.total ?? row.amount_due ?? 0);
  const currency = str(row.currency) ?? 'EUR';
  const notes = str(row.notes);

  const rawLines = Array.isArray(row.line_items) ? row.line_items : [];
  const lineItems: FatturaPALineItem[] = rawLines
    .filter(isRecord)
    .map((item) => {
      const quantity = Number(item.quantity ?? 1);
      const unitPrice = Number(item.unit_price ?? item.price ?? 0);
      const amount = Number(item.amount ?? quantity * unitPrice);
      return {
        description: str(item.description) ?? 'Servizio',
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        unit_price: Number.isFinite(unitPrice) ? unitPrice : 0,
        amount: Number.isFinite(amount) ? amount : 0,
      };
    });

  const missing: string[] = [];
  if (!id) missing.push('invoice.id');
  if (!invoiceNumber) missing.push('invoice.invoice_number');
  if (!issueDate) missing.push('invoice.issue_date');
  if (!Number.isFinite(total) || total <= 0) missing.push('invoice.total');
  if (lineItems.length === 0) missing.push('invoice.line_items');

  if (missing.length > 0 || !id || !invoiceNumber || !issueDate) {
    return { missing };
  }

  return {
    missing: [],
    invoice: {
      id,
      invoice_number: invoiceNumber,
      issue_date: issueDate,
      currency,
      total,
      line_items: lineItems,
      notes,
    },
  };
}

invoices.get('/:id/sdi-xml', async (c) => {
  const id = c.req.param('id');

  const [row] = (await sql`
    SELECT i.*, to_jsonb(c.*) AS customer
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ${id}
  `) as Array<AnyRecord>;

  if (!row) return c.json({ error: 'Fattura non trovata' }, 404);
  if (!isRecord(row.customer)) {
    return c.json({ error: 'Fattura senza cliente associato' }, 400);
  }
  if (row.status === 'draft') {
    return c.json(
      { error: 'Impossibile generare XML SDI per una fattura in bozza. Emetti prima la fattura.' },
      400,
    );
  }

  const profile = await loadSetting('business.profile') as AnyRecord;
  const studio = await loadSetting('freelancer.studio') as AnyRecord;

  if (studio.vat_regime && studio.vat_regime !== 'forfettario') {
    return c.json(
      {
        error:
          'La generazione XML è attualmente supportata solo per regime forfettario. Aggiorna freelancer.studio.vat_regime o estendi lib/sdi/xml.ts per il regime ordinario.',
        regime: studio.vat_regime,
      },
      400,
    );
  }

  const cedente = buildCedenteConfig(profile);
  const cessionario = buildCessionarioCustomer(row.customer);
  const invoice = buildInvoicePayload(row);

  const missing = [...cedente.missing, ...cessionario.missing, ...invoice.missing];
  if (missing.length > 0 || !cedente.config || !cessionario.customer || !invoice.invoice) {
    return c.json(
      {
        error: 'Dati mancanti per generare XML FatturaPA',
        missing,
        hint:
          'Compila i campi mancanti in Impostazioni → Profilo e nel record cliente (billing_address).',
      },
      400,
    );
  }

  const xml = generateFatturaPAXml(invoice.invoice, cessionario.customer, cedente.config);

  const progressivo = invoice.invoice.id
    .replace(/-/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8) || '00001';
  const filename = `IT${cedente.config.vat_number}_${progressivo}.xml`;

  // Bump status to 'generated' only if still pending — don't overwrite
  // 'sent'/'accepted'/'rejected' once the invoice is in the SDI pipeline.
  await sql`
    UPDATE invoices SET
      sdi_xml_generated_at = NOW(),
      sdi_xml_filename = ${filename},
      sdi_status = CASE WHEN sdi_status = 'pending' THEN 'generated' ELSE sdi_status END
    WHERE id = ${id}
  `;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
});
