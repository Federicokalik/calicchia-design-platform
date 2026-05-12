import { useMemo, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

interface PdfPreviewProps {
  data: QuotePreviewData;
}

export interface QuotePreviewData {
  title: string;
  subtitle: string;
  customerName: string;
  customerCompany: string;
  tipoCliente: string;
  validUntil: string;
  sections: Array<{ type: string; data: any }>;
  totale: number;
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

function buildHtml(data: QuotePreviewData): string {
  const today = formatDate(new Date().toISOString().split('T')[0]);
  const scadenza = data.validUntil ? formatDate(data.validUntil) : '';
  const bollo = data.totale > 77.47 ? 2 : 0;

  let offerte: any[] = [];
  let materiali: string[] = [];
  let tempistiche: any = null;
  let pagamento: any[] = [];
  let premessa: any = null;
  let comparativa: any[] = [];
  let problemi: any[] = [];
  let clausole: any[] = [];

  for (const s of data.sections) {
    if (s.type === 'offerte') offerte.push(...(s.data.offerte || []));
    if (s.type === 'materiali') materiali = s.data.lista || [];
    if (s.type === 'tempistiche') tempistiche = s.data;
    if (s.type === 'pagamento') pagamento = s.data.modalita || [];
    if (s.type === 'premessa') premessa = s.data;
    if (s.type === 'comparativa') comparativa.push(s.data);
    if (s.type === 'problemi') problemi = s.data.lista || [];
    if (s.type === 'clausole') clausole.push(s.data);
  }

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<style>
@page { size: A4; margin: 18mm; }
@page cover { margin: 0; }
:root { --brand: #f57f44; --success: #16a34a; --error: #dc2626; --info: #2563eb; --text: #1a1a1a; --muted: #666; --light: #f7f7f8; --border: #e5e5e5; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Inter, Arial, sans-serif; font-size: 10pt; line-height: 1.6; color: var(--text); background: #ffffff; }
h1 { font-size: 22pt; font-weight: 700; }
h2 { font-size: 15pt; font-weight: 700; margin-bottom: 10pt; padding-bottom: 6pt; border-bottom: 2px solid var(--brand); }
h3 { font-size: 12pt; font-weight: 600; margin-bottom: 6pt; }
p { margin-bottom: 8pt; }
.cover { page: cover; width: 100%; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; position: relative; }
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
.box-warning { border-left: 4px solid #f59e0b; background: #fffbeb; }
.box-info { border-left: 4px solid var(--info); background: #eff6ff; }
.box-success { border-left: 4px solid var(--success); background: #f0fdf4; }
.box-title { font-size: 11pt; font-weight: 700; margin-bottom: 6pt; }
.stats-grid { display: flex; gap: 10pt; margin: 14pt 0; }
.stat-box { flex: 1; text-align: center; background: var(--light); border-radius: 6pt; padding: 12pt 8pt; border: 1px solid var(--border); }
.stat-value { font-size: 22pt; font-weight: 800; color: var(--brand); line-height: 1; }
.stat-label { font-size: 8pt; color: var(--muted); margin-top: 4pt; }
.offer-box { border: 1px solid var(--border); border-radius: 8pt; padding: 16pt; margin-bottom: 14pt; position: relative; }
.offer-box.recommended { border-color: var(--brand); border-width: 2px; }
.offer-badge { position: absolute; top: -10pt; right: 14pt; background: var(--brand); color: white; font-size: 8pt; font-weight: 700; padding: 3pt 10pt; border-radius: 10pt; text-transform: uppercase; }
.offer-price { font-size: 20pt; font-weight: 800; color: var(--brand); }
.offer-name { font-size: 13pt; font-weight: 700; margin-bottom: 4pt; }
.two-cols { display: flex; gap: 14pt; }
.two-cols > div { flex: 1; }
.check-list { list-style: none; padding: 0; }
.check-list li { padding: 3pt 0 3pt 18pt; position: relative; font-size: 9pt; }
.check-list li::before { content: "✓"; position: absolute; left: 0; color: var(--success); font-weight: 700; }
.cross-list li::before { content: "✗"; color: var(--error); }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th, td { padding: 8pt 10pt; text-align: left; border-bottom: 1px solid var(--border); }
th { background: var(--light); font-weight: 600; font-size: 8pt; text-transform: uppercase; }
.page-break { page-break-before: always; }
.total-row { font-weight: 700; font-size: 11pt; }
.material-list { list-style: none; padding: 0; }
.material-list li { padding: 6pt 0 6pt 20pt; position: relative; border-bottom: 1px solid var(--border); font-size: 9pt; }
.material-list li::before { content: "☐"; position: absolute; left: 0; font-size: 11pt; color: var(--muted); }
</style></head><body>

<!-- COVER -->
<div class="cover">
  <div style="font-size:12pt;font-weight:800;letter-spacing:1pt;color:var(--brand);margin-bottom:40pt;">CALICCHIA DESIGN</div>
  <div class="cover-title">${esc(data.title || 'Preventivo')}</div>
  <div class="cover-subtitle">${esc(data.subtitle || 'Preventivo e Contratto di Incarico')}</div>
  <div class="cover-client">${esc(data.customerName || '')}</div>
  ${data.customerCompany ? `<div class="cover-client-sub">${esc(data.customerCompany)}</div>` : ''}
  <div class="cover-date">${today}</div>
</div>

<div class="page-break"></div>

<!-- PREMESSA -->
${premessa?.testo ? `
<div class="section">
  <h2>Premessa</h2>
  <p>${esc(premessa.testo)}</p>
  ${premessa.statistiche?.length ? `
  <div class="stats-grid">
    ${premessa.statistiche.map((s: any) => `<div class="stat-box"><div class="stat-value">${esc(s.valore)}</div><div class="stat-label">${esc(s.label)}</div></div>`).join('')}
  </div>` : ''}
</div>` : ''}

<!-- COMPARATIVA -->
${comparativa.map((c: any) => c.titolo ? `
<div class="section">
  <h2>${esc(c.titolo)}</h2>
  ${c.intro ? `<p>${esc(c.intro)}</p>` : ''}
  <table>
    <tr><th>Caratteristica</th><th>${esc(c.intestazione_a || 'Proposta')}</th><th>${esc(c.intestazione_b || 'Attuale')}</th></tr>
    ${(c.righe || []).map((r: any) => `<tr><td>${esc(r.caratteristica)}</td><td>${esc(r.colonna_a)}</td><td>${esc(r.colonna_b)}</td></tr>`).join('')}
  </table>
</div>` : '').join('')}

<!-- OFFERTE -->
${offerte.length ? `
<div class="section">
  <h2>Offerta Economica</h2>
  ${offerte.map((o: any) => `
  <div class="offer-box ${o.consigliata ? 'recommended' : ''}">
    ${o.consigliata ? '<div class="offer-badge">Consigliata</div>' : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10pt;">
      <div class="offer-name">${esc(o.nome)}</div>
      <div class="offer-price">${formatCurrency(o.prezzo || 0)}</div>
    </div>
    ${o.descrizione ? `<p style="font-size:9pt;color:var(--muted);">${esc(o.descrizione)}</p>` : ''}
    <div class="two-cols">
      <div>
        <h3 style="color:var(--success);font-size:9pt;">Include</h3>
        <ul class="check-list">${(o.include || []).filter(Boolean).map((i: string) => `<li>${esc(i)}</li>`).join('')}</ul>
      </div>
      <div>
        <h3 style="color:var(--error);font-size:9pt;">Non include</h3>
        <ul class="check-list cross-list">${(o.esclude || []).filter(Boolean).map((e: string) => `<li>${esc(e)}</li>`).join('')}</ul>
      </div>
    </div>
  </div>`).join('')}
</div>` : ''}

<!-- PROBLEMI RISOLTI -->
${problemi.length ? `
<div class="section">
  <h2>Problemi Risolti</h2>
  <table>
    <tr><th>#</th><th>Problema</th><th>Soluzione</th></tr>
    ${problemi.map((p: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(p.problema)}</td><td>${esc(p.soluzione)}</td></tr>`).join('')}
  </table>
</div>` : ''}

<!-- CLAUSOLE -->
${clausole.map((c: any) => c.titolo ? `
<div class="box box-${c.tipo || 'warning'}">
  <div class="box-title">${esc(c.titolo)}</div>
  ${c.testo ? `<p style="font-size:9pt;">${esc(c.testo)}</p>` : ''}
</div>` : '').join('')}

<!-- MATERIALI -->
${materiali.filter(Boolean).length ? `
<div class="section">
  <h2>Materiali Necessari</h2>
  <ul class="material-list">
    ${materiali.filter(Boolean).map((m: string) => `<li>${esc(m)}</li>`).join('')}
  </ul>
</div>` : ''}

<!-- TEMPISTICHE -->
${tempistiche?.prima_bozza ? `
<div class="box box-light box-brand">
  <div class="box-title">Tempistiche</div>
  <p style="font-size:9pt;">Prima bozza: <strong>${esc(tempistiche.prima_bozza)}</strong> ${tempistiche.nota ? esc(tempistiche.nota) : ''}</p>
</div>` : ''}

<!-- PAGAMENTO -->
${pagamento.length ? `
<div class="section">
  <h2>Modalità di Pagamento</h2>
  ${pagamento.map((m: any) => `
  <div class="box box-light">
    <div class="box-title">${esc(m.nome)}</div>
    ${m.sconto_percentuale ? `<p style="font-size:9pt;color:var(--success);">Sconto ${m.sconto_percentuale}% — Totale: ${formatCurrency(data.totale * (1 - m.sconto_percentuale / 100) + bollo)}</p>` : ''}
    ${m.rate?.length ? `<table><tr><th>%</th><th>Importo</th><th>Quando</th></tr>${m.rate.map((r: any) => `<tr><td>${r.percentuale}%</td><td>${formatCurrency((data.totale + bollo) * r.percentuale / 100)}</td><td>${esc(r.momento)}</td></tr>`).join('')}</table>` : ''}
  </div>`).join('')}
</div>` : ''}

<!-- RIEPILOGO -->
<div class="box box-light" style="margin-top:20pt;">
  <table>
    <tr><td>Subtotale</td><td style="text-align:right;">${formatCurrency(data.totale)}</td></tr>
    ${bollo ? `<tr><td>Marca da bollo</td><td style="text-align:right;">${formatCurrency(bollo)}</td></tr>` : ''}
    <tr class="total-row"><td>Totale</td><td style="text-align:right;">${formatCurrency(data.totale + bollo)}</td></tr>
  </table>
</div>

${scadenza ? `<p style="font-size:8pt;color:var(--muted);margin-top:10pt;text-align:center;">Preventivo valido fino al ${scadenza}</p>` : ''}

</body></html>`;
}

function esc(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function PdfPreview({ data }: PdfPreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);

  const html = useMemo(() => buildHtml(data), [data]);
  const srcDoc = html;

  const iframe = (
    <iframe
      srcDoc={srcDoc}
      className="w-full h-full border-0 bg-white"
      title="Preview preventivo"
      sandbox="allow-same-origin"
    />
  );

  return (
    <>
      <div className="relative rounded-lg border bg-white overflow-hidden" style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}>
        <div className="absolute top-2 right-2 z-10">
          <Button variant="secondary" size="icon" className="h-7 w-7 shadow-sm" onClick={() => setFullscreen(true)}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="w-full h-full" style={{ transform: 'scale(0.6)', transformOrigin: 'top left', width: '166.66%', height: '166.66%' }}>
          {iframe}
        </div>
      </div>

      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="max-w-[90vw] h-[90vh] p-0 overflow-hidden">
          <div className="absolute top-3 right-3 z-10">
            <Button variant="secondary" size="icon" className="h-8 w-8" onClick={() => setFullscreen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="w-full h-full bg-white">
            {iframe}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
