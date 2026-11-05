/**
 * HTML della proforma (una pagina A4, stesso stile editoriale dei
 * preventivi: font Funnel inline, colore del brand), reso in PDF da
 * lib/pdf/render.ts. Usa solo dati congelati all'emissione (numero,
 * customer_snapshot, metadata.supplier, line_items, legal_notes): rigenerare
 * il PDF di una proforma emessa produce lo stesso documento.
 */
import { getFontFaceCss } from '../quote-renderer';
import { NOT_FISCAL_NOTICE, type ProformaSupplier } from './settings';
import { formatEuro, type ProformaLine } from './totals';

export interface ProformaCustomerSnapshot {
  name: string;
  contact_name?: string | null;
  company_name?: string | null;
  address?: { street?: string; postal_code?: string; city?: string; province?: string; country?: string };
  vat_number?: string | null;
  fiscal_code?: string | null;
  sdi_code?: string | null;
  pec?: string | null;
  email?: string | null;
  recipients?: string[];
}

export interface ProformaRenderInput {
  number: string;
  issue_date: string;
  due_date: string | null;
  customer: ProformaCustomerSnapshot;
  supplier: ProformaSupplier;
  lines: ProformaLine[];
  subtotal_cents: number;
  stamp_duty_cents: number;
  total_cents: number;
  legal_notes: string;
  notes?: string | null;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

export function formatDateIt(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${MESI[m - 1]} ${y}`;
}

function safeColor(c: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#f57f44';
}

function safeLogo(url: string): string {
  return /^(https:\/\/|data:image\/(png|jpe?g|webp);base64,)/i.test(url) ? url : '';
}

function formatQuantity(q: number): string {
  return new Intl.NumberFormat('it-IT', { maximumFractionDigits: 3 }).format(q);
}

export function renderProformaHtml(p: ProformaRenderInput): string {
  const accent = safeColor(p.supplier.color);
  const logo = safeLogo(p.supplier.logo_url);
  const addr = p.customer.address ?? {};
  const customerLines = [
    p.customer.company_name && p.customer.contact_name && p.customer.company_name !== p.customer.contact_name
      ? `Att.ne ${p.customer.contact_name}` : '',
    addr.street,
    [addr.postal_code, addr.city, addr.province ? `(${addr.province})` : ''].filter(Boolean).join(' '),
    addr.country && addr.country !== 'IT' ? addr.country : '',
    p.customer.vat_number ? `P.IVA ${p.customer.vat_number}` : '',
    p.customer.fiscal_code && p.customer.fiscal_code !== p.customer.vat_number ? `C.F. ${p.customer.fiscal_code}` : '',
    p.customer.sdi_code ? `SDI ${p.customer.sdi_code}` : '',
    p.customer.pec ? `PEC ${p.customer.pec}` : '',
  ].filter(Boolean);
  const supplierLines = [
    p.supplier.address,
    p.supplier.vat_number ? `P.IVA ${p.supplier.vat_number}` : '',
    p.supplier.fiscal_code ? `C.F. ${p.supplier.fiscal_code}` : '',
    [p.supplier.email, p.supplier.phone].filter(Boolean).join(' · '),
    p.supplier.website,
  ].filter(Boolean);

  const rows = p.lines
    .map((l) => `
      <tr class="${l.kind === 'stamp_duty' ? 'stamp' : ''}">
        <td class="desc">${esc(l.description)}</td>
        <td class="num">${esc(formatQuantity(l.quantity))}</td>
        <td class="num">${esc(formatEuro(l.unit_price_cents))}</td>
        <td class="num">${esc(formatEuro(l.amount_cents))}</td>
      </tr>`)
    .join('');

  const legal = p.legal_notes
    .split('\n')
    .filter((line) => line.trim() && line.trim() !== NOT_FISCAL_NOTICE)
    .map((line) => `<p>${esc(line)}</p>`)
    .join('');

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>${esc(p.number)}</title>
<style>
${getFontFaceCss()}
:root { --accent: ${accent}; --ink: #111; --muted: #5c5c58; --subtle: #8c8c86; --line: #e6e4dc; --bg: #fafaf7; }
@page { size: A4 portrait; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: var(--bg); }
body { color: var(--ink); font-family: 'Funnel Sans', ui-sans-serif, system-ui, sans-serif; font-size: 10pt; line-height: 1.45;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; min-height: 297mm; padding: 20mm 18mm 18mm; display: flex; flex-direction: column; gap: 9mm; }
header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--accent); padding-bottom: 6mm; }
header .brand { font-family: 'Funnel Display', sans-serif; font-weight: 600; font-size: 13pt; }
header .brand img { max-height: 14mm; max-width: 60mm; display: block; }
header .meta { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8.5pt; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); line-height: 1.7; }
h1 { font-family: 'Funnel Display', sans-serif; font-weight: 500; font-size: 34pt; letter-spacing: -.03em; line-height: 1; }
h1 .num { color: var(--accent); }
.not-fiscal { display: inline-block; margin-top: 3mm; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8pt; letter-spacing: .12em; text-transform: uppercase;
  color: var(--accent); border: 1px solid var(--accent); padding: 1mm 2.5mm; }
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; }
.parties .k { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; color: var(--subtle); margin-bottom: 2mm; }
.parties .v { font-family: 'Funnel Display', sans-serif; font-weight: 500; font-size: 12pt; }
.parties .small { color: var(--muted); font-size: 9pt; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 400; font-size: 8pt; letter-spacing: .12em; text-transform: uppercase; color: var(--subtle);
  border-bottom: 1px solid var(--ink); padding: 2mm 1.5mm; }
td { border-bottom: 1px solid var(--line); padding: 2.5mm 1.5mm; vertical-align: top; }
td.num, th.num { text-align: right; white-space: nowrap; }
tr.stamp td { color: var(--muted); font-size: 9pt; }
.totals { margin-left: auto; width: 80mm; }
.totals div { display: flex; justify-content: space-between; padding: 1.5mm 0; }
.totals .total { border-top: 1px solid var(--ink); margin-top: 1mm; padding-top: 2.5mm; font-family: 'Funnel Display', sans-serif; font-weight: 500; font-size: 15pt; }
.totals .total span:last-child { color: var(--accent); }
.pay { border-top: 2px solid var(--accent); background: #fff; padding: 5mm; display: grid; grid-template-columns: auto 1fr; gap: 1.5mm 6mm; font-size: 9.5pt; }
.pay .k { color: var(--subtle); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8pt; letter-spacing: .1em; text-transform: uppercase; padding-top: .6mm; }
.notes { font-size: 9pt; color: var(--muted); }
.legal { margin-top: auto; font-size: 8pt; color: var(--muted); display: flex; flex-direction: column; gap: 1.2mm; border-top: 1px solid var(--line); padding-top: 4mm; }
.legal .strong { color: var(--ink); font-weight: 600; }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="brand">${logo ? `<img src="${esc(logo)}" alt="${esc(p.supplier.name)}">` : esc(p.supplier.name)}</div>
    <div class="meta">
      <div>Data ${esc(formatDateIt(p.issue_date))}</div>
      ${p.due_date ? `<div>Scadenza ${esc(formatDateIt(p.due_date))}</div>` : ''}
    </div>
  </header>

  <div>
    <h1>Proforma <span class="num">${esc(p.number.replace(/^PF\s*/, ''))}</span></h1>
    <span class="not-fiscal">${esc(NOT_FISCAL_NOTICE.split('.')[0])}</span>
  </div>

  <section class="parties">
    <div>
      <div class="k">Da</div>
      <div class="v">${esc(p.supplier.name)}</div>
      ${supplierLines.map((l) => `<div class="small">${esc(l)}</div>`).join('')}
    </div>
    <div>
      <div class="k">Per</div>
      <div class="v">${esc(p.customer.name)}</div>
      ${customerLines.map((l) => `<div class="small">${esc(l)}</div>`).join('')}
    </div>
  </section>

  <table>
    <thead><tr><th>Descrizione</th><th class="num">Q.tà</th><th class="num">Prezzo</th><th class="num">Importo</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div><span>Imponibile</span><span>${esc(formatEuro(p.subtotal_cents))}</span></div>
    <div><span>IVA</span><span>non applicata</span></div>
    ${p.stamp_duty_cents ? `<div><span>Rivalsa bollo</span><span>${esc(formatEuro(p.stamp_duty_cents))}</span></div>` : ''}
    <div class="total"><span>Totale</span><span>${esc(formatEuro(p.total_cents))}</span></div>
  </div>

  ${p.supplier.iban ? `
  <section class="pay">
    <div class="k">Bonifico</div><div><strong>${esc(p.supplier.iban)}</strong>${p.supplier.bic ? ` · BIC ${esc(p.supplier.bic)}` : ''}${p.supplier.bank ? ` · ${esc(p.supplier.bank)}` : ''}</div>
    <div class="k">Intestato a</div><div>${esc(p.supplier.holder || p.supplier.name)}</div>
    <div class="k">Causale</div><div>Saldo proforma ${esc(p.number)}</div>
    ${p.due_date ? `<div class="k">Entro il</div><div>${esc(formatDateIt(p.due_date))}</div>` : ''}
  </section>` : ''}

  ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}

  <footer class="legal">
    ${legal}
    <p class="strong">${esc(NOT_FISCAL_NOTICE)}</p>
  </footer>
</div>
</body>
</html>`;
}
