/**
 * Quote HTML Renderer — Server-side
 * Generates the same HTML as the client-side preview for PDF generation
 */

function esc(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatCurrency(n: number): string {
  return `€ ${n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function formatDate(d: string): string {
  if (!d) return '';
  const dt = new Date(d);
  const mesi = ['', 'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  return `${dt.getDate()} ${mesi[dt.getMonth() + 1]} ${dt.getFullYear()}`;
}

interface QuoteData {
  title: string;
  description: string;
  customer_name: string;
  company_name: string;
  items: Array<{ description: string; quantity: number; unit_price: number; total: number }>;
  total: number;
  valid_until: string;
  notes: string;
  project_template?: { sections?: Array<{ type: string; data: any }> };
}

interface QuoteSettings {
  colore_primario?: string;
  font?: string;
  ragione_sociale?: string;
  indirizzo?: string;
  piva?: string;
  telefono?: string;
  email_fornitore?: string;
  banca?: string;
  iban?: string;
  nota_iva?: string;
  soglia_bollo?: number;
  importo_bollo?: number;
}

export function renderQuoteHtml(quote: QuoteData, settings: QuoteSettings = {}): string {
  const brand = settings.colore_primario || '#f57f44';
  const font = settings.font || 'Inter, Arial, sans-serif';
  const today = formatDate(new Date().toISOString().split('T')[0]);
  const scadenza = quote.valid_until ? formatDate(quote.valid_until) : '';
  const total = parseFloat(String(quote.total)) || 0;
  const bollo = total > (settings.soglia_bollo || 77.47) ? (settings.importo_bollo || 2) : 0;

  const rawSections = quote.project_template?.sections || [];
  const sections = typeof rawSections === 'string' ? JSON.parse(rawSections) : rawSections;
  const rawItems = quote.items;
  const parsedItems = typeof rawItems === 'string' ? JSON.parse(rawItems) : (rawItems || []);
  let offerte: any[] = [];
  let materiali: string[] = [];
  let tempistiche: any = null;
  let pagamento: any[] = [];
  let premessa: any = null;

  for (const s of sections) {
    if (s.type === 'offerte') offerte.push(...(s.data.offerte || []));
    if (s.type === 'materiali') materiali = s.data.lista || [];
    if (s.type === 'tempistiche') tempistiche = s.data;
    if (s.type === 'pagamento') pagamento = s.data.modalita || [];
    if (s.type === 'premessa') premessa = s.data;
  }

  // If no sections, use items directly
  if (offerte.length === 0 && parsedItems.length) {
    offerte = parsedItems.map((i: any) => ({ nome: i.description, prezzo: i.total, consigliata: false, include: [], esclude: [], descrizione: '' }));
  }

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<style>
:root { --brand: ${brand}; --text: #1a1a1a; --muted: #666; --light: #f7f7f8; --border: #e5e5e5; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: ${font}; font-size: 10pt; line-height: 1.6; color: var(--text); }
h1 { font-size: 22pt; font-weight: 700; }
h2 { font-size: 15pt; font-weight: 700; margin-bottom: 10pt; padding-bottom: 6pt; border-bottom: 2px solid var(--brand); }
h3 { font-size: 12pt; font-weight: 600; margin-bottom: 6pt; }
p { margin-bottom: 8pt; }
.cover { width: 100%; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; position: relative; }
.cover::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, var(--brand), #ff9a5c, var(--brand)); }
.cover-title { font-size: 28pt; font-weight: 800; margin-bottom: 8pt; padding: 0 40pt; line-height: 1.15; }
.cover-subtitle { font-size: 13pt; color: var(--brand); font-weight: 500; margin-bottom: 50pt; }
.cover-client { font-size: 16pt; font-weight: 600; }
.cover-client-sub { font-size: 11pt; color: var(--muted); margin-top: 4pt; }
.cover-date { position: absolute; bottom: 40pt; font-size: 10pt; color: var(--muted); }
.section { margin-bottom: 20pt; }
.box { border: 1px solid var(--border); border-radius: 6pt; padding: 14pt; margin-bottom: 12pt; }
.box-light { background: var(--light); }
.box-brand { border-left: 4px solid var(--brand); }
.offer-box { border: 1px solid var(--border); border-radius: 8pt; padding: 16pt; margin-bottom: 14pt; position: relative; }
.offer-box.recommended { border-color: var(--brand); border-width: 2px; }
.offer-badge { position: absolute; top: -10pt; right: 14pt; background: var(--brand); color: white; font-size: 8pt; font-weight: 700; padding: 3pt 10pt; border-radius: 10pt; text-transform: uppercase; }
.offer-price { font-size: 20pt; font-weight: 800; color: var(--brand); }
.offer-name { font-size: 13pt; font-weight: 700; margin-bottom: 4pt; }
.two-cols { display: flex; gap: 14pt; }
.two-cols > div { flex: 1; }
.check-list { list-style: none; padding: 0; }
.check-list li { padding: 3pt 0 3pt 18pt; position: relative; font-size: 9pt; }
.check-list li::before { content: "✓"; position: absolute; left: 0; color: #16a34a; font-weight: 700; }
.cross-list li::before { content: "✗"; color: #dc2626; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th, td { padding: 8pt 10pt; text-align: left; border-bottom: 1px solid var(--border); }
th { background: var(--light); font-weight: 600; font-size: 8pt; text-transform: uppercase; }
.total-row { font-weight: 700; font-size: 11pt; }
.material-list { list-style: none; padding: 0; }
.material-list li { padding: 6pt 0 6pt 20pt; position: relative; border-bottom: 1px solid var(--border); font-size: 9pt; }
.material-list li::before { content: "☐"; position: absolute; left: 0; font-size: 11pt; color: var(--muted); }
.page-break { page-break-before: always; }
</style></head><body>

<div class="cover">
  <div style="font-size:12pt;font-weight:800;letter-spacing:1pt;color:var(--brand);margin-bottom:40pt;">${esc(settings.ragione_sociale || 'CALICCHIA DESIGN')}</div>
  <div class="cover-title">${esc(quote.title || 'Preventivo')}</div>
  <div class="cover-subtitle">${esc(quote.description || 'Preventivo e Contratto di Incarico')}</div>
  <div class="cover-client">${esc(quote.customer_name || '')}</div>
  ${quote.company_name ? `<div class="cover-client-sub">${esc(quote.company_name)}</div>` : ''}
  <div class="cover-date">${today}</div>
</div>

<div class="page-break"></div>

${premessa?.testo ? `<div class="section"><h2>Premessa</h2><p>${esc(premessa.testo)}</p></div>` : ''}

${offerte.length ? `
<div class="section"><h2>Offerta Economica</h2>
${offerte.map((o: any) => `
<div class="offer-box ${o.consigliata ? 'recommended' : ''}">
  ${o.consigliata ? '<div class="offer-badge">Consigliata</div>' : ''}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10pt;">
    <div class="offer-name">${esc(o.nome)}</div>
    <div class="offer-price">${formatCurrency(o.prezzo || 0)}</div>
  </div>
  ${o.descrizione ? `<p style="font-size:9pt;color:var(--muted);">${esc(o.descrizione)}</p>` : ''}
  <div class="two-cols">
    <div><h3 style="color:#16a34a;font-size:9pt;">Include</h3><ul class="check-list">${(o.include || []).filter(Boolean).map((i: string) => `<li>${esc(i)}</li>`).join('')}</ul></div>
    <div><h3 style="color:#dc2626;font-size:9pt;">Non include</h3><ul class="check-list cross-list">${(o.esclude || []).filter(Boolean).map((e: string) => `<li>${esc(e)}</li>`).join('')}</ul></div>
  </div>
</div>`).join('')}
</div>` : ''}

${materiali.filter(Boolean).length ? `
<div class="section"><h2>Materiali Necessari</h2>
<ul class="material-list">${materiali.filter(Boolean).map((m: string) => `<li>${esc(m)}</li>`).join('')}</ul>
</div>` : ''}

${tempistiche?.prima_bozza ? `
<div class="box box-light box-brand">
  <div style="font-size:11pt;font-weight:700;margin-bottom:6pt;">Tempistiche</div>
  <p style="font-size:9pt;">Prima bozza: <strong>${esc(tempistiche.prima_bozza)}</strong> ${tempistiche.nota ? esc(tempistiche.nota) : ''}</p>
</div>` : ''}

${pagamento.length ? `
<div class="section"><h2>Modalità di Pagamento</h2>
${pagamento.map((m: any) => `
<div class="box box-light">
  <div style="font-size:11pt;font-weight:700;margin-bottom:6pt;">${esc(m.nome)}</div>
  ${m.sconto_percentuale ? `<p style="font-size:9pt;color:#16a34a;">Sconto ${m.sconto_percentuale}% — Totale: ${formatCurrency(total * (1 - m.sconto_percentuale / 100) + bollo)}</p>` : ''}
  ${m.rate?.length ? `<table><tr><th>%</th><th>Importo</th><th>Quando</th></tr>${m.rate.map((r: any) => `<tr><td>${r.percentuale}%</td><td>${formatCurrency((total + bollo) * r.percentuale / 100)}</td><td>${esc(r.momento)}</td></tr>`).join('')}</table>` : ''}
</div>`).join('')}
</div>` : ''}

<div class="box box-light" style="margin-top:20pt;">
  <table>
    <tr><td>Subtotale</td><td style="text-align:right;">${formatCurrency(total)}</td></tr>
    ${bollo ? `<tr><td>Marca da bollo</td><td style="text-align:right;">${formatCurrency(bollo)}</td></tr>` : ''}
    <tr class="total-row"><td>Totale</td><td style="text-align:right;">${formatCurrency(total + bollo)}</td></tr>
  </table>
</div>

${scadenza ? `<p style="font-size:8pt;color:var(--muted);margin-top:10pt;text-align:center;">Preventivo valido fino al ${scadenza}</p>` : ''}

${settings.nota_iva ? `<p style="font-size:7pt;color:#aaa;margin-top:20pt;">${esc(settings.nota_iva)}</p>` : ''}

</body></html>`;
}
