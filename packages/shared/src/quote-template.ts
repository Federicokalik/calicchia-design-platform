/**
 * Quote template — Swiss editorial, single source of truth.
 *
 * Renders a quotes_v2 row (+ quote.settings) into a fixed-page A4 HTML
 * document: cover, computed table of contents, one page-group per populated
 * section, and a closing acceptance/signature page (with the artt. 1341-1342
 * c.c. "clausole vessatorie" recap when a contract section is present).
 *
 * Consumed by BOTH:
 *  - apps/api  → Puppeteer PDF (fonts injected as data-URI @font-face)
 *  - apps/admin → live iframe preview (fonts served from /api/assets/fonts)
 *
 * Design tokens mirror apps/sito-v3/src/styles/tokens.css (warm-white
 * surfaces, ink text, single ambra accent, hairline borders, Funnel type).
 *
 * Pagination model: every page is a fixed 210×297mm box with overflow:hidden
 * — one section ≈ one page (long sections split deterministically into
 * consecutive pages), so TOC page numbers are plain computed integers and
 * the preview shows exactly what prints. Content that exceeds a page is
 * clipped visibly in the preview rather than silently reflowing the TOC.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuoteSectionInput {
  id?: string;
  type: string;
  data: unknown;
}

/** Shape of the quotes_v2 row (post customer JOIN) the template consumes. */
export interface QuoteTemplateInput {
  title: string;
  description?: string;
  customer_name?: string;
  company_name?: string;
  items?: Array<{ description: string; quantity: number; unit_price: number; total: number }> | string;
  total?: number | string;
  valid_until?: string | null;
  notes?: string | null;
  created_at?: string | null;
  signed_at?: string | null;
  signer_name?: string | null;
  signature_image?: string | null;
  vessatorie_approved_at?: string | null;
  project_template?: { sections?: QuoteSectionInput[] | string } | null;
}

/** Subset of the `quote.settings` site_settings row the template reads. */
export interface QuoteTemplateSettings {
  logo_url?: string;
  colore_primario?: string;
  ragione_sociale?: string;
  indirizzo?: string;
  piva?: string;
  legale_rappresentante?: string;
  telefono?: string;
  email_fornitore?: string;
  banca?: string;
  iban?: string;
  bic?: string;
  nota_iva?: string;
  marca_bollo_nota?: string;
  soglia_bollo?: number;
  importo_bollo?: number;
  foro_competente?: string;
  clausole_vessatorie?: number[];
  contratto_articoli?: string[];
  sito_web?: string;
}

export interface QuoteTemplateOptions {
  /** @font-face CSS block supplied by the caller (data URIs or URLs). */
  fontFaceCss?: string;
  /** Document reference shown on cover/headers (e.g. "2026-A1B2C3"). */
  numero?: string;
  /** Render a DRAFT watermark-style ref instead of a number. */
  draft?: boolean;
}

export interface ContractArticle {
  numero: number;
  titolo: string;
  testo: string;
  vessatoria: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function esc(s: unknown): string {
  if (s === null || s === undefined || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatCurrency(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `€ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

const MESI = ['', 'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

export function formatQuoteDate(d?: string | null): string {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getDate()} ${MESI[dt.getMonth() + 1]} ${dt.getFullYear()}`;
}

/**
 * Parse a `quote.settings.contratto_articoli` entry, format
 * `"Art. N — TITOLO: testo"`. Tolerates hyphen/en-dash variants and a
 * missing prefix (falls back to positional numbering).
 */
export function parseContractArticle(raw: string, index: number, vessatorie: number[] = []): ContractArticle {
  const m = /^Art\.?\s*(\d+)\s*[—–-]+\s*([^:]+):\s*([\s\S]*)$/i.exec(raw || '');
  if (m) {
    const numero = parseInt(m[1], 10);
    return { numero, titolo: m[2].trim(), testo: m[3].trim(), vessatoria: vessatorie.includes(numero) };
  }
  const numero = index + 1;
  return { numero, titolo: `Articolo ${numero}`, testo: (raw || '').trim(), vessatoria: vessatorie.includes(numero) };
}

/**
 * Default 15-article contract. Single source shared by the api settings
 * schema defaults and the admin Impostazioni editor (previously duplicated
 * in three places). Extended texts modeled on the approved Swiss-editorial
 * mockup, generalized from project specifics; per-quote customization goes
 * in the contratto section's `articoli_override`.
 * `{{foro_competente}}` is substituted from quote.settings at render time.
 */
export const DEFAULT_CONTRACT_ARTICLES: string[] = [
  "Art. 1 — Oggetto: Il Cliente conferisce al Fornitore l'incarico per la realizzazione dei servizi descritti nel presente preventivo, secondo il perimetro definito nelle sezioni precedenti del documento. Le funzionalità e le attività non espressamente menzionate si intendono escluse.",
  "Art. 2 — Compenso e modalità di pagamento: Il compenso è definito dall'offerta economica accettata, con le modalità di pagamento indicate nel presente documento. Su ciascuna fattura di importo superiore a € 77,47 è dovuta dal Cliente la marca da bollo di € 2,00, operando il Fornitore in regime forfettario (IVA esente ex art. 1 L. 190/2014).",
  "Art. 3 — Durata del contratto: L'incarico decorre dalla sottoscrizione e si conclude con la consegna di quanto previsto. Per i servizi ricorrenti eventualmente inclusi valgono l'impegno minimo e le modalità di rinnovo indicati nell'offerta economica.",
  "Art. 4 — Specifiche sul pagamento: In caso di ritardo nel pagamento, il Fornitore ha facoltà di sospendere l'erogazione dei servizi fino al saldo. Fino al saldo integrale, il Fornitore può non pubblicare né consegnare i contenuti e i materiali previsti. In caso di esecuzione parziale, il Fornitore ha diritto di trattenere le somme ricevute e al compenso per l'opera già svolta.",
  "Art. 5 — Specifiche sui servizi: Il Fornitore può avvalersi di collaboratori o assistenti sotto la propria responsabilità. La proprietà del sito e dei materiali prodotti è trasferita al Cliente al saldo integrale della relativa quota; fino a tale momento restano del Fornitore. Tutti i diritti non espressamente concessi sono riservati.",
  'Art. 6 — Obblighi del Fornitore: Il Fornitore si impegna a prestare la propria opera con diligenza, a mantenere riservati i fatti e le informazioni relativi all\'incarico e a vigilare affinché eventuali collaboratori osservino il medesimo obbligo di riservatezza.',
  'Art. 7 — Obblighi del Cliente: Il Cliente si impegna a fornire tempestivamente materiali, contenuti e accessi necessari, a collaborare per l\'esecuzione dell\'incarico e a comunicare tempestivamente ogni variazione rilevante. La mancata collaborazione esonera il Fornitore da responsabilità e può comportare lo slittamento delle tempistiche concordate.',
  'Art. 8 — Modifiche e integrazioni: Il presente contratto annulla ogni precedente accordo tra le Parti. Funzionalità o attività non previste nel perimetro sono oggetto di nuova contrattualizzazione con costo ulteriore. Eventuali modifiche devono essere concordate per iscritto.',
  "Art. 9 — Recesso: Le Parti possono recedere per giusta causa; il mancato adempimento degli obblighi ne costituisce giusta causa. L'acconto versato alla firma è a copertura dell'opera di avvio e non è rimborsabile in caso di recesso del Cliente prima della consegna; resta inoltre dovuto il compenso per l'opera eventualmente già svolta e il rimborso delle spese sostenute.",
  "Art. 10 — Clausola risolutiva espressa: Il Fornitore può risolvere il contratto ex art. 1456 c.c. con effetto immediato qualora il Cliente non adempia all'obbligo di pagamento entro il termine di messa in mora, violi gli obblighi contrattuali o sia sottoposto a procedura concorsuale. Resta salvo l'obbligo del Cliente di pagare quanto dovuto fino a quel momento.",
  'Art. 11 — Riservatezza e promozione: Le Parti si impegnano alla riservatezza delle informazioni comunicate. Il Cliente autorizza il Fornitore a utilizzare il materiale realizzato, il nome del Cliente e il relativo marchio per la promozione della propria attività.',
  'Art. 12 — Comunicazioni: Le comunicazioni tra le Parti avvengono per iscritto via posta elettronica. Il Fornitore è contattabile nei giorni lavorativi (lunedì–venerdì, 9:00–18:00). Il Cliente si impegna a rispondere in tempo utile.',
  "Art. 13 — Limitazione di responsabilità: Il Cliente esonera il Fornitore da responsabilità per mancata esecuzione dovuta a forza maggiore o problemi tecnici, per danni indiretti derivanti dall'uso di piattaforme o software di terzi e per il mancato raggiungimento di risultati specifici, trattandosi di obbligazione di mezzi e non di risultato. La richiesta di risarcimento non può eccedere il valore del contratto.",
  "Art. 14 — Trattamento dei dati: I dati personali sono trattati nel rispetto del Regolamento UE 679/2016 (GDPR). Le Parti consentono l'inserimento dei propri dati nelle rispettive banche dati; i dati possono essere comunicati a terzi solo per l'esecuzione del contratto.",
  'Art. 15 — Foro competente: Il presente contratto è disciplinato dalla legge italiana. Per ogni controversia è competente in via esclusiva il {{foro_competente}}.',
];

// Mirrors the mockup's "— vessatoria" markers: artt. 4, 5, 9, 10, 11, 13, 15.
export const DEFAULT_CLAUSOLE_VESSATORIE: number[] = [4, 5, 9, 10, 11, 13, 15];

// ---------------------------------------------------------------------------
// Defensive normalization — sections[].data is admin-authored schemaless
// JSONB: malformed entries must degrade to empty, never throw mid-template.
// ---------------------------------------------------------------------------

function arr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : 0;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Only allow inline raster images (canvas signature exports) — never other URI schemes. */
function safeDataImage(v: unknown): string {
  const s = str(v);
  return /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
}

// ---------------------------------------------------------------------------
// CSS — ported from the approved Swiss editorial mockup
// ---------------------------------------------------------------------------

function buildCss(brand: string, fontFaceCss: string): string {
  return `${fontFaceCss}
:root {
  --bg: #FAFAF7; --bg-elev: #FFFFFF;
  --line: #E6E4DC; --line-strong: #C9C5B7;
  --ink: #111111; --ink-muted: #5C5C58; --ink-subtle: #8C8C86;
  --accent: ${brand};
  --font-display: 'Funnel Display', ui-sans-serif, system-ui, sans-serif;
  --font-sans: 'Funnel Sans', ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  --page-w: 210mm; --page-h: 297mm;
  --m-top: 22mm; --m-bot: 20mm; --m-side: 18mm;
}
@page { size: A4 portrait; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #efece4; }
body {
  color: var(--ink); font-family: var(--font-sans); font-size: 10.5pt; line-height: 1.5;
  padding: 24px 0 64px; hyphens: auto; -webkit-hyphens: auto;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
::selection { background: var(--accent); color: #fff; }
.doc { display: flex; flex-direction: column; align-items: center; gap: 24px; }
.page {
  width: var(--page-w); height: var(--page-h);
  padding: var(--m-top) var(--m-side) var(--m-bot);
  background: var(--bg); position: relative; display: flex; flex-direction: column;
  box-shadow: 0 8px 30px rgba(17,17,17,0.10); overflow: hidden;
}
@media print {
  html, body { background: var(--bg); }
  body { padding: 0; }
  .doc { gap: 0; }
  .page { box-shadow: none; page-break-after: always; break-after: page; margin: 0; }
  .page:last-child { page-break-after: auto; break-after: auto; }
}

/* ---------- Page chrome (page 2 onwards) ---------- */
.page-header {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  height: 14mm; padding-bottom: 5mm; border-bottom: 1px solid var(--accent); flex: 0 0 auto;
}
.page-header .wordmark img { height: 14px; display: block; }
.page-header .wordmark .wm-text { font-family: var(--font-display); font-weight: 600; font-size: 11pt; letter-spacing: -0.01em; }
.page-header .ref { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.1em; color: var(--ink-muted); text-transform: uppercase; }
.page-footer {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  height: 12mm; padding-top: 4mm; border-top: 1px solid var(--line);
  font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.06em;
  color: var(--ink-subtle); text-transform: uppercase; flex: 0 0 auto;
}
.page-footer .l, .page-footer .r { display: flex; flex-direction: column; gap: 2px; }
.page-footer .r { text-align: right; }
.page-content { flex: 1 1 auto; padding: 7mm 0; overflow: hidden; text-align: justify; }

/* ---------- Type primitives ---------- */
h2.section-h2 {
  font-family: var(--font-display); font-weight: 500; font-size: 22pt; line-height: 1.1;
  letter-spacing: -0.025em; color: var(--ink); margin: 0 0 5mm; text-align: left;
}
h2.section-h2 .num {
  font-family: var(--font-mono); font-weight: 400; font-size: 9pt; letter-spacing: 0.18em;
  color: var(--ink-subtle); display: block; text-transform: uppercase; margin-bottom: 4mm;
}
h2.section-h2 .num em { font-style: normal; color: var(--accent); }
h3.block-h3 {
  font-family: var(--font-display); font-weight: 500; font-size: 14pt; line-height: 1.25;
  letter-spacing: -0.018em; color: var(--ink); margin: 0 0 2mm;
  display: flex; align-items: baseline; gap: 4mm; text-align: left;
}
h3.block-h3 .idx { font-family: var(--font-mono); color: var(--ink-subtle); font-weight: 400; font-size: 9pt; letter-spacing: 0.1em; flex-shrink: 0; }
p { margin: 0 0 2mm; }
p:last-child { margin-bottom: 0; }
.lead {
  font-family: var(--font-display); font-weight: 400; font-size: 12.5pt; line-height: 1.4;
  letter-spacing: -0.008em; color: var(--ink); margin-bottom: 5mm; max-width: 165mm; text-align: left;
}
.caption { font-size: 8.5pt; line-height: 1.4; color: var(--ink-muted); }
.caption.italic { font-style: italic; }
.term-note { font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); }
ul.dots, ul.checks { list-style: none; padding: 0; margin: 0 0 2mm; text-align: left; }
ul.dots li, ul.checks li { position: relative; padding-left: 6mm; margin-bottom: 1.5mm; line-height: 1.5; }
ul.dots li::before { content: "·"; position: absolute; left: 1mm; top: -2px; font-size: 16pt; line-height: 1; color: var(--accent); }
ul.checks li::before { content: "✓"; position: absolute; left: 0; top: 1px; font-family: var(--font-mono); font-size: 9pt; font-weight: 700; color: var(--accent); }
ul.crosses li::before { content: "✕"; color: var(--ink-subtle); }

/* ---------- Cover ---------- */
.cover .top { display: flex; align-items: flex-start; justify-content: space-between; }
.cover .top .wordmark img { height: 22px; display: block; }
.cover .top .wordmark .wm-text { font-family: var(--font-display); font-weight: 600; font-size: 15pt; letter-spacing: -0.01em; }
.cover .top .meta { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-subtle); text-align: right; line-height: 1.6; }
.cover .hero { margin-top: auto; padding-top: 30mm; }
.cover h1.preventivo-h1 { font-family: var(--font-display); font-weight: 500; font-size: 64pt; line-height: 0.98; letter-spacing: -0.035em; color: var(--ink); margin: 0; }
.cover .preventivo-h2 { font-family: var(--font-display); font-weight: 500; font-size: 26pt; line-height: 1.15; letter-spacing: -0.022em; color: var(--ink); margin: 6mm 0 16mm; max-width: 165mm; }
.cover .preventivo-h2 .tilde { color: var(--accent); font-style: normal; }
.cover .client-block { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 8mm 0; display: grid; grid-template-columns: 1fr 1fr 1fr; }
.cover .client-block .cell { padding-right: 8mm; }
.cover .client-block .k { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.14em; color: var(--ink-subtle); text-transform: uppercase; margin-bottom: 3mm; }
.cover .client-block .v { font-family: var(--font-display); font-weight: 500; font-size: 12pt; line-height: 1.3; color: var(--ink); letter-spacing: -0.01em; }
.cover .client-block .v small { display: block; font-family: var(--font-sans); font-weight: 400; font-size: 9pt; color: var(--ink-muted); margin-top: 2px; letter-spacing: 0; }
.cover .bottom-band { margin-top: auto; padding-top: 20mm; }
.cover .bottom-band .sig { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.12em; color: var(--ink-muted); text-transform: uppercase; line-height: 1.6; }
.cover .bottom-band .sig b { font-family: var(--font-display); font-weight: 500; font-size: 11pt; letter-spacing: -0.005em; color: var(--ink); text-transform: none; display: block; margin-bottom: 2px; }

/* ---------- TOC ---------- */
.toc { display: flex; flex-direction: column; }
.toc .row { display: grid; grid-template-columns: 28px 1fr 84px; gap: 16px; align-items: baseline; padding: 2.4mm 0; border-bottom: 1px solid var(--line); }
.toc .row .n { font-family: var(--font-mono); font-size: 9pt; color: var(--ink-subtle); letter-spacing: 0.06em; }
.toc .row .t { font-family: var(--font-display); font-weight: 500; font-size: 13pt; letter-spacing: -0.015em; text-align: left; }
.toc .row .t .sub { display: block; font-family: var(--font-sans); font-weight: 400; font-size: 8.5pt; line-height: 1.3; color: var(--ink-muted); letter-spacing: 0; margin-top: 0.5mm; }
.toc .row .p { font-family: var(--font-mono); font-size: 9pt; color: var(--ink-muted); text-align: right; letter-spacing: 0.06em; white-space: nowrap; }

/* ---------- Letter / premessa ---------- */
.letter { max-width: 140mm; font-size: 11pt; line-height: 1.6; }
.letter p { margin-bottom: 4mm; }
.stats-band { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 6mm 0; margin: 8mm 0; }
.stats-band .cell { padding-right: 8mm; }
.stats-band .val { font-family: var(--font-display); font-weight: 500; font-size: 24pt; letter-spacing: -0.02em; color: var(--accent); line-height: 1; }
.stats-band .lbl { font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-subtle); margin-top: 2.5mm; }

/* ---------- Solution blocks / offers ---------- */
.solution-block { padding: 4mm 0; border-top: 1px solid var(--line); }
.solution-block:first-of-type { border-top: none; padding-top: 0; }
.solution-block .head { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; }
.solution-block .price { font-family: var(--font-display); font-weight: 500; font-size: 18pt; letter-spacing: -0.02em; color: var(--ink); white-space: nowrap; }
.solution-block .price .cur { color: var(--accent); font-size: 11pt; vertical-align: 0.18em; margin-right: 2px; font-weight: 400; }
.solution-block p.intro { margin: 1mm 0 2.5mm; max-width: 168mm; }
.solution-block .twocol-bullets { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 2mm; }
.badge-top { font-family: var(--font-mono); font-size: 7.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent); padding: 1mm 2.5mm; border-radius: 1px; white-space: nowrap; }

/* ---------- Boxes ---------- */
.box { position: relative; padding: 6mm 7mm; border: 1px solid var(--line); background: transparent; margin-top: 5mm; text-align: left; }
.box.highlight { border-top: 2px solid var(--accent); }
.box .box-label { font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink-subtle); margin-bottom: 3.5mm; display: flex; align-items: baseline; gap: 8px; }
.box .box-label .lead-num { color: var(--accent); font-weight: 400; }
.box.highlight .box-label { color: var(--ink); }
.box p { font-size: 10pt; }

/* ---------- Gantt ---------- */
.gantt { display: grid; grid-template-columns: 62mm 1fr; border-top: 1px solid var(--line); }
.gantt .row { display: contents; }
.gantt .row > * { padding: 2.8mm 3mm; border-bottom: 1px solid var(--line); }
.gantt .label { font-size: 9.5pt; line-height: 1.35; padding-left: 0; text-align: left; }
.gantt .label .num { font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.06em; color: var(--ink-subtle); display: block; }
.gantt .label b { font-weight: 500; }
.gantt .bar-cell { position: relative; padding: 0; display: flex; align-items: center; }
.gantt .bar-track { position: relative; width: 100%; height: 100%; display: flex; align-items: center; }
.gantt .bar { position: absolute; height: 4mm; background: var(--accent); border-radius: 1px; }
.gantt .weeks-header { display: grid; font-family: var(--font-mono); font-size: 7.5pt; letter-spacing: 0.04em; color: var(--ink-subtle); text-transform: uppercase; padding: 2mm 3mm; border-bottom: 1px solid var(--line-strong); }
.gantt .weeks-header .w { text-align: center; }

/* ---------- Tables ---------- */
.t { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 2mm; }
.t th, .t td { text-align: left; vertical-align: top; padding: 2.8mm 4mm 2.8mm 0; border-bottom: 1px solid var(--line); }
.t th:last-child, .t td:last-child { padding-right: 0; }
.t thead th { color: var(--ink-subtle); font-family: var(--font-mono); font-weight: 400; font-size: 8pt; letter-spacing: 0.18em; text-transform: uppercase; padding: 2mm 4mm 2mm 0; border-bottom: 1px solid var(--line-strong); }
.t td.r, .t th.r { text-align: right; white-space: nowrap; }
.t td.price { font-family: var(--font-display); font-weight: 500; font-size: 12pt; color: var(--ink); letter-spacing: -0.01em; }
.t td.price .cur { color: var(--accent); font-size: 9pt; vertical-align: 0.18em; margin-right: 2px; font-weight: 400; }
.t td.price .per { font-family: var(--font-sans); font-size: 8.5pt; color: var(--ink-muted); font-weight: 400; letter-spacing: 0; }
.t td.label b { font-weight: 500; }
.t td.label .meta { display: block; font-size: 8.5pt; color: var(--ink-muted); margin-top: 0.5mm; line-height: 1.35; max-width: 118mm; }
.t tr.totale td { color: var(--ink); border-top: 1px solid var(--ink); border-bottom: none; padding-top: 5mm; padding-bottom: 0; }
.t tr.totale td.label b { font-family: var(--font-display); font-weight: 500; font-size: 14pt; letter-spacing: -0.012em; }
.t tr.totale td.price { font-size: 20pt; letter-spacing: -0.02em; }
.t tr.totale td.price .cur { font-size: 13pt; }

/* ---------- Payment ---------- */
.rata { margin-top: 6mm; border: 1px solid var(--line); border-top: 2px solid var(--accent); padding: 6mm 7mm; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8mm; }
.rata .k { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-subtle); margin-bottom: 2mm; }
.rata .desc { font-size: 9.5pt; color: var(--ink-muted); line-height: 1.4; max-width: 95mm; text-align: left; }
.rata .amt { font-family: var(--font-display); font-weight: 500; font-size: 30pt; letter-spacing: -0.03em; color: var(--ink); line-height: 1; white-space: nowrap; }
.rata .amt .cur { color: var(--accent); font-size: 16pt; vertical-align: 0.28em; margin-right: 2px; font-weight: 400; }
.ms-grid { display: flex; flex-direction: column; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin-top: 4mm; }
.ms-grid .ms { display: grid; grid-template-columns: 58mm 40mm 1fr; align-items: center; gap: 6mm; padding: 4mm 2mm; border-bottom: 1px solid var(--line); }
.ms-grid .ms:last-child { border-bottom: none; }
.ms-grid .ms .k { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.13em; text-transform: uppercase; color: var(--ink-subtle); }
.ms-grid .ms .amt { font-family: var(--font-display); font-weight: 500; font-size: 20pt; letter-spacing: -0.025em; color: var(--ink); line-height: 1; white-space: nowrap; }
.ms-grid .ms .amt .cur { color: var(--accent); font-size: 12pt; vertical-align: 0.22em; margin-right: 2px; font-weight: 400; }
.ms-grid .ms .lbl { font-size: 10pt; color: var(--ink-muted); line-height: 1.4; text-align: left; }
.iban { margin-top: 6mm; border: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr; }
.iban > div { padding: 5mm; }
.iban > div + div { border-left: 1px solid var(--line); }
.iban .k { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-subtle); margin-bottom: 2mm; }
.iban .v { font-family: var(--font-mono); font-size: 10.5pt; letter-spacing: 0.04em; color: var(--ink); }

/* ---------- Materials ---------- */
.material-list { list-style: none; padding: 0; margin-top: 2mm; text-align: left; }
.material-list li { padding: 3.2mm 0 3.2mm 8mm; position: relative; border-bottom: 1px solid var(--line); font-size: 10pt; }
.material-list li::before { content: "☐"; position: absolute; left: 0; top: 2.4mm; font-size: 11pt; color: var(--ink-subtle); }

/* ---------- Contract articles ---------- */
.arts { display: flex; flex-direction: column; }
.art { padding: 2mm 0; border-top: 1px solid var(--line); }
.art:first-child { border-top: none; padding-top: 0; }
.art .a-h { display: flex; align-items: baseline; gap: 4mm; margin-bottom: 0.7mm; }
.art .a-h .a-n { font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.13em; text-transform: uppercase; color: var(--accent); flex-shrink: 0; }
.art .a-h .a-t { font-family: var(--font-display); font-weight: 500; font-size: 11pt; letter-spacing: -0.012em; color: var(--ink); }
.art .a-h .a-vex { color: var(--ink-subtle); font-family: var(--font-mono); font-size: 7.5pt; letter-spacing: 0.1em; text-transform: uppercase; }
.art p { font-size: 9pt; line-height: 1.35; color: var(--ink); max-width: 172mm; }

/* ---------- Vessatorie + signature ---------- */
.vex .vex-intro { font-size: 9.3pt; line-height: 1.45; max-width: 172mm; }
.vex .vex-list { list-style: none; padding: 0; margin: 2.6mm 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 1.4mm 8mm; }
.vex .vex-list li { position: relative; padding-left: 6mm; font-size: 9pt; line-height: 1.35; }
.vex .vex-list li::before { content: "\\2713"; position: absolute; left: 0; top: 1px; font-family: var(--font-mono); font-size: 9pt; font-weight: 700; color: var(--accent); }
.vex .vex-list li b { font-weight: 500; }
.vex .vex-sign { margin-top: 3.5mm; border-top: 1px solid var(--ink); padding-top: 2mm; font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.08em; color: var(--ink-subtle); text-transform: uppercase; }
.vex .vex-sign.approved { border-top-color: var(--accent); color: var(--accent); letter-spacing: 0.14em; }
.sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14mm; margin-top: 10mm; }
.sig-grid .sig { display: flex; flex-direction: column; text-align: left; }
.sig-grid .sig .role { font-family: var(--font-mono); font-size: 8.5pt; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-subtle); margin-bottom: 3mm; }
.sig-grid .sig .name { font-family: var(--font-display); font-weight: 500; font-size: 14pt; letter-spacing: -0.018em; margin-bottom: 16mm; }
.sig-grid .sig .line { border-top: 1px solid var(--ink); padding-top: 2mm; font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.08em; color: var(--ink-subtle); text-transform: uppercase; }
.sig-grid .sig.auto-signed .name { font-style: italic; font-weight: 500; font-size: 20pt; margin-bottom: 5mm; }
.sig-grid .sig.auto-signed .sig-img { height: 18mm; margin-bottom: 3mm; align-self: flex-start; }
.sig-grid .sig.auto-signed .signed-bar { border-top: 1px solid var(--accent); padding-top: 3mm; font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); display: flex; align-items: baseline; gap: 6px; }
.sig-grid .sig.auto-signed .meta { margin-top: 4mm; font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.06em; color: var(--ink-subtle); text-transform: uppercase; line-height: 1.6; }
`;
}

// ---------------------------------------------------------------------------
// Page building
// ---------------------------------------------------------------------------

interface ContentPage {
  /** TOC entry — pages sharing the same tocKey collapse into one TOC row (Pag. X–Y). */
  tocKey: string;
  tocTitle: string;
  tocSub: string;
  bodyHtml: string;
}

interface NormalizedQuote {
  title: string;
  subtitle: string;
  customerName: string;
  companyName: string;
  total: number;
  bollo: number;
  validUntil: string;
  notes: string;
  createdAt: string;
  signedAt: string;
  signerName: string;
  signatureImage: string;
  vessatorieApprovedAt: string;
  sections: QuoteSectionInput[];
}

function normalizeQuote(input: QuoteTemplateInput, settings: QuoteTemplateSettings): NormalizedQuote {
  const rawSections = input.project_template?.sections;
  let sections: QuoteSectionInput[] = [];
  try {
    sections = typeof rawSections === 'string' ? JSON.parse(rawSections) : arr<QuoteSectionInput>(rawSections);
  } catch { sections = []; }

  const rawItems = input.items;
  let items: Array<Record<string, unknown>> = [];
  try {
    items = typeof rawItems === 'string' ? JSON.parse(rawItems) : arr(rawItems);
  } catch { items = []; }

  // Legacy fallback: no sections → synthesize an offerte section from flat items.
  if (!sections.some((s) => s.type === 'offerte') && items.length) {
    sections = [
      {
        type: 'offerte',
        data: {
          offerte: items.map((i, idx) => ({
            id: `item_${idx}`,
            nome: str(i.description),
            descrizione: '',
            prezzo: num(i.total) || num(i.quantity) * num(i.unit_price),
            consigliata: false,
            include: [],
            esclude: [],
          })),
        },
      },
      ...sections,
    ];
  }

  const total = num(input.total);
  const soglia = settings.soglia_bollo ?? 77.47;
  const bollo = total > soglia ? (settings.importo_bollo ?? 2) : 0;

  return {
    title: str(input.title) || 'Preventivo',
    subtitle: str(input.description) || 'Preventivo e Contratto di Incarico',
    customerName: str(input.customer_name),
    companyName: str(input.company_name),
    total,
    bollo,
    validUntil: str(input.valid_until),
    notes: str(input.notes),
    createdAt: str(input.created_at) || new Date().toISOString(),
    signedAt: str(input.signed_at),
    signerName: str(input.signer_name),
    signatureImage: safeDataImage(input.signature_image),
    vessatorieApprovedAt: str(input.vessatorie_approved_at),
    sections,
  };
}

/**
 * Resolve the effective contract articles for a quote: global settings
 * boilerplate overridden per-article by the contratto section's
 * `articoli_override` (index = article number − 1, null = keep global).
 */
export function resolveContractArticles(
  settings: QuoteTemplateSettings,
  contrattoData?: unknown,
): ContractArticle[] {
  const base = arr<string>(settings.contratto_articoli).length
    ? arr<string>(settings.contratto_articoli)
    : DEFAULT_CONTRACT_ARTICLES;
  const vessatorie = arr<number>(settings.clausole_vessatorie).length
    ? arr<number>(settings.clausole_vessatorie)
    : DEFAULT_CLAUSOLE_VESSATORIE;
  const override = arr<string | null>(rec(contrattoData).articoli_override);
  const foro = str(settings.foro_competente) || 'Foro competente per legge';
  return base.map((raw, i) => {
    let effective = typeof override[i] === 'string' && (override[i] as string).trim() ? (override[i] as string) : raw;
    effective = effective.replace(/\{\{foro_competente\}\}/g, foro);
    return parseContractArticle(effective, i, vessatorie);
  });
}

const ARTICLES_PER_PAGE = 7;
const OFFERS_PER_PAGE = 3;

function sectionLabel(type: string): { title: string; sub: string } {
  switch (type) {
    case 'premessa': return { title: 'Premessa', sub: 'Apertura e contesto della proposta' };
    case 'comparativa': return { title: 'Confronto', sub: 'Situazione attuale e proposta' };
    case 'offerte': return { title: 'Offerta economica', sub: 'Le voci e i prezzi della proposta' };
    case 'problemi': return { title: 'Problemi risolti', sub: 'Cosa sistemiamo e come' };
    case 'clausole': return { title: 'Note e clausole', sub: 'Precisazioni sul perimetro' };
    case 'materiali': return { title: 'Materiali necessari', sub: 'Cosa serve per iniziare' };
    case 'tempistiche': return { title: 'Tempistiche', sub: 'Dalla firma alla consegna' };
    case 'pagamento': return { title: 'Modalità di pagamento', sub: 'Opzioni e coordinate bancarie' };
    case 'contratto': return { title: 'Condizioni contrattuali', sub: 'Contratto di incarico professionale' };
    default: return { title: type, sub: '' };
  }
}

function h2(num: number, title: string): string {
  const nn = String(num).padStart(2, '0');
  return `<h2 class="section-h2"><span class="num"><em>${nn}</em> — ${esc(title)}</span></h2>`;
}

// --- Per-section page renderers -------------------------------------------

function renderPremessa(d: Record<string, unknown>, n: number, q: NormalizedQuote): string {
  const stats = arr<Record<string, unknown>>(d.statistiche).filter((s) => str(s.valore) || str(s.label));
  const paragraphs = str(d.testo).split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
  const salute = q.companyName || q.customerName;
  return `${h2(n, 'Premessa')}
<div class="letter">
  ${salute ? `<p style="margin-bottom:6mm;">Spett.le ${esc(salute)},</p>` : ''}
  ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
</div>
${stats.length ? `<div class="stats-band">${stats.slice(0, 3).map((s) => `<div class="cell"><div class="val">${esc(s.valore)}</div><div class="lbl">${esc(s.label)}</div></div>`).join('')}</div>` : ''}`;
}

function renderComparativa(d: Record<string, unknown>, n: number): string {
  const righe = arr<Record<string, unknown>>(d.righe).filter((r) => str(r.caratteristica));
  return `${h2(n, str(d.titolo) || 'Confronto')}
${str(d.intro) ? `<p class="lead">${esc(d.intro)}</p>` : ''}
<table class="t">
  <thead><tr><th>Caratteristica</th><th>${esc(str(d.intestazione_a) || 'Proposta')}</th><th>${esc(str(d.intestazione_b) || 'Attuale')}</th></tr></thead>
  <tbody>${righe.map((r) => `<tr><td class="label"><b>${esc(r.caratteristica)}</b></td><td>${esc(r.colonna_a)}</td><td>${esc(r.colonna_b)}</td></tr>`).join('')}</tbody>
</table>`;
}

function renderOffertePage(
  offerte: Array<Record<string, unknown>>,
  n: number,
  pageIdx: number,
  pageCount: number,
  totals: { total: number; bollo: number } | null,
): string {
  const title = pageCount > 1 ? `Offerta economica (${pageIdx + 1}/${pageCount})` : 'Offerta economica';
  const blocks = offerte.map((o, i) => {
    const include = arr<string>(o.include).filter(Boolean);
    const esclude = arr<string>(o.esclude).filter(Boolean);
    return `<div class="solution-block">
  <div class="head">
    <h3 class="block-h3"><span class="idx">${String(pageIdx * OFFERS_PER_PAGE + i + 1).padStart(2, '0')}.</span>${esc(o.nome)}${o.consigliata ? ' &nbsp;<span class="badge-top">Consigliata</span>' : ''}</h3>
    <div class="price"><span class="cur">€</span>${esc(formatCurrency(num(o.prezzo)).replace('€ ', ''))}</div>
  </div>
  ${str(o.descrizione) ? `<p class="intro">${esc(o.descrizione)}</p>` : ''}
  ${include.length || esclude.length ? `<div class="twocol-bullets">
    <ul class="checks">${include.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <ul class="checks crosses">${esclude.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  </div>` : ''}
</div>`;
  }).join('');

  const totalsHtml = totals
    ? `<table class="t" style="margin-top:6mm;">
  <tbody>
    <tr><td class="label">Subtotale</td><td class="r price"><span class="cur">€</span>${formatCurrency(totals.total).replace('€ ', '')}</td></tr>
    ${totals.bollo ? `<tr><td class="label">Marca da bollo</td><td class="r price"><span class="cur">€</span>${formatCurrency(totals.bollo).replace('€ ', '')}</td></tr>` : ''}
    <tr class="totale"><td class="label"><b>Totale</b></td><td class="r price"><span class="cur">€</span>${formatCurrency(totals.total + totals.bollo).replace('€ ', '')}</td></tr>
  </tbody>
</table>`
    : '';

  return `${h2(n, title)}${blocks}${totalsHtml}`;
}

function renderProblemi(d: Record<string, unknown>, n: number): string {
  const lista = arr<Record<string, unknown>>(d.lista).filter((p) => str(p.problema) || str(p.soluzione));
  return `${h2(n, 'Problemi risolti')}
<table class="t">
  <thead><tr><th style="width:24px;">#</th><th>Problema</th><th>Soluzione</th></tr></thead>
  <tbody>${lista.map((p, i) => `<tr><td>${i + 1}</td><td class="label"><b>${esc(p.problema)}</b></td><td>${esc(p.soluzione)}</td></tr>`).join('')}</tbody>
</table>`;
}

function renderClausoleBoxes(clausole: Array<Record<string, unknown>>, n: number): string {
  const boxes = clausole.map((c) => {
    const lista = arr<string>(c.lista).filter(Boolean);
    return `<div class="box ${str(c.tipo) === 'warning' ? 'highlight' : ''}">
  <div class="box-label"><span class="lead-num">!</span>${esc(str(c.titolo) || 'Nota')}</div>
  ${str(c.testo) ? `<p>${esc(c.testo)}</p>` : ''}
  ${lista.length ? `<ul class="dots" style="margin-top:2mm;">${lista.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
</div>`;
  }).join('');
  return `${h2(n, 'Note e clausole')}${boxes}`;
}

function renderMateriali(d: Record<string, unknown>, n: number): string {
  const lista = arr<string>(d.lista).filter(Boolean);
  return `${h2(n, 'Materiali necessari')}
<p class="lead">Per partire senza attese, questi sono i materiali da fornire.</p>
<ul class="material-list">${lista.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
<p class="caption italic" style="margin-top:6mm;">Le tempistiche indicate decorrono dalla ricezione completa dei materiali.</p>`;
}

function renderTempistiche(d: Record<string, unknown>, n: number): string {
  const fasi = arr<Record<string, unknown>>(d.fasi).filter((f) => str(f.label));
  const settimane = Math.min(Math.max(Math.round(num(d.settimane)) || 8, 2), 16);
  let body: string;
  if (fasi.length) {
    body = `<div class="gantt" style="margin-top:4mm;">
  <div class="weeks-header"></div>
  <div class="weeks-header" style="grid-template-columns: repeat(${settimane}, 1fr);">${Array.from({ length: settimane }, (_, i) => `<span class="w">S${i + 1}</span>`).join('')}</div>
  ${fasi.map((f, i) => {
    const left = Math.min(Math.max(num(f.start_pct), 0), 100);
    const width = Math.min(Math.max(num(f.width_pct), 1), 100 - left);
    return `<div class="row">
    <div class="label"><span class="num">FASE ${String(i + 1).padStart(2, '0')}</span><b>${esc(f.label)}</b></div>
    <div class="bar-cell"><div class="bar-track"><div class="bar" style="left:${left}%; width:${width}%"></div></div></div>
  </div>`;
  }).join('')}
</div>`;
  } else {
    body = `<div class="box highlight">
  <div class="box-label"><span class="lead-num">→</span>Consegna</div>
  <p>Prima bozza: <b>${esc(str(d.prima_bozza))}</b>${str(d.nota) ? ` — ${esc(d.nota)}` : ''}</p>
</div>`;
  }
  return `${h2(n, 'Tempistiche')}
${str(d.prima_bozza) && fasi.length ? `<p class="lead">Prima bozza: <b>${esc(d.prima_bozza)}</b>${str(d.nota) ? ` — ${esc(d.nota)}` : ''}.</p>` : ''}
${body}`;
}

function renderPagamento(d: Record<string, unknown>, n: number, q: NormalizedQuote, s: QuoteTemplateSettings): string {
  const modalita = arr<Record<string, unknown>>(d.modalita).filter((m) => str(m.nome));
  const totale = q.total + q.bollo;
  const rows = modalita.flatMap((m) => {
    const sconto = num(m.sconto_percentuale);
    const rate = arr<Record<string, unknown>>(m.rate);
    // Each option can carry its own absolute total (`importo`) — real-world
    // options differ by channel cost (e.g. anticipated wire cheaper, BNPL
    // installments with a surcharge). Falls back to sconto% / quote total.
    const explicit = num(m.importo);
    const base = explicit > 0 ? explicit : (sconto ? q.total * (1 - sconto / 100) + q.bollo : totale);
    const metodo = str(m.metodo);
    const nota = str(m.nota);
    const detail = [metodo ? `Via ${metodo}.` : '', nota]
      .filter(Boolean).join(' ');
    if (!rate.length) {
      const fallbackLbl = sconto ? `Sconto ${sconto}% sul totale.` : 'Saldo in un’unica soluzione.';
      return [`<div class="ms">
  <span class="k">${esc(m.nome)}</span>
  <div class="amt"><span class="cur">€</span>${formatCurrency(base).replace('€ ', '')}</div>
  <span class="lbl">${esc(detail || fallbackLbl)}</span>
</div>`];
    }
    return rate.map((r) => {
      const pct = num(r.percentuale);
      return `<div class="ms">
  <span class="k">${esc(m.nome)} · ${pct}%</span>
  <div class="amt"><span class="cur">€</span>${formatCurrency(base * pct / 100).replace('€ ', '')}</div>
  <span class="lbl">${esc([str(r.momento), detail].filter(Boolean).join(' — '))}</span>
</div>`;
    });
  }).join('');

  const iban = str(s.iban);
  const ibanBox = iban ? `<div class="iban">
  <div>
    <div class="k">Intestatario</div><div class="v">${esc(s.legale_rappresentante || s.ragione_sociale || '')}</div>
    <div class="k" style="margin-top:4mm;">P.IVA</div><div class="v">${esc(s.piva || '')}</div>
  </div>
  <div>
    <div class="k">IBAN</div><div class="v">${esc(iban)}</div>
    ${str(s.bic) ? `<div class="k" style="margin-top:4mm;">BIC / SWIFT</div><div class="v">${esc(s.bic)}</div>` : ''}
  </div>
</div>` : '';

  return `${h2(n, 'Modalità di pagamento')}
<div class="ms-grid">${rows}</div>
${ibanBox}
${str(s.marca_bollo_nota) && q.bollo ? `<p class="caption italic" style="margin-top:5mm;">${esc(s.marca_bollo_nota)}</p>` : ''}`;
}

function renderContrattoPage(
  articles: ContractArticle[],
  n: number,
  pageIdx: number,
  pageCount: number,
  servizi: string[],
): string {
  const title = pageCount > 1 ? `Condizioni contrattuali (${pageIdx + 1}/${pageCount})` : 'Condizioni contrattuali';
  const perimetro = pageIdx === 0 && servizi.length
    ? `<div class="box" style="margin-bottom:4mm; margin-top:0;">
  <div class="box-label"><span class="lead-num">§</span>Perimetro dei servizi</div>
  <ul class="dots">${servizi.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</div>`
    : '';
  return `${h2(n, title)}${perimetro}
<div class="arts">${articles.map((a) => `<div class="art">
  <div class="a-h"><span class="a-n">Art. ${String(a.numero).padStart(2, '0')}</span><span class="a-t">${esc(a.titolo)}${a.vessatoria ? ' <span class="a-vex">— vessatoria</span>' : ''}</span></div>
  <p>${esc(a.testo)}</p>
</div>`).join('')}</div>`;
}

function renderClosingPage(
  n: number,
  q: NormalizedQuote,
  s: QuoteTemplateSettings,
  vessatorie: ContractArticle[],
): string {
  const scadenza = q.validUntil ? formatQuoteDate(q.validUntil) : '';
  const vexBox = vessatorie.length ? `<div class="box highlight vex" style="margin-top:5mm;">
  <div class="box-label"><span class="lead-num">!</span>Clausole vessatorie — artt. 1341–1342 c.c.</div>
  <p class="vex-intro">Ai sensi degli artt. 1341 e 1342 c.c., il Cliente dichiara di aver letto, compreso e di approvare specificamente le seguenti clausole:</p>
  <ul class="vex-list">${vessatorie.map((a) => `<li><b>Art. ${a.numero}</b> — ${esc(a.titolo)}</li>`).join('')}</ul>
  ${q.vessatorieApprovedAt
    ? `<div class="vex-sign approved">✓ Approvate specificamente con firma digitale il ${formatQuoteDate(q.vessatorieApprovedAt)}</div>`
    : '<div class="vex-sign">Il Cliente — firma per specifica approvazione &nbsp;·&nbsp; ______________________________</div>'}
</div>` : '';

  const clientSig = q.signedAt
    ? `<div class="sig auto-signed">
  <span class="role">Per il cliente — Per accettazione</span>
  ${q.signatureImage ? `<img class="sig-img" src="${q.signatureImage}" alt="Firma">` : `<span class="name">${esc(q.signerName || q.companyName || q.customerName)}</span>`}
  <div class="signed-bar">✓ Firmato digitalmente (FEA) il ${formatQuoteDate(q.signedAt)}</div>
  <div class="meta">${esc(q.signerName || '')}</div>
</div>`
    : `<div class="sig">
  <span class="role">Per il cliente — Per accettazione</span>
  <span class="name">${esc(q.companyName || q.customerName || '')}</span>
  <span class="line">Data, luogo, firma e timbro</span>
</div>`;

  return `${h2(n, 'Accettazione e firma')}
${q.notes ? `<p class="lead">${esc(q.notes)}</p>` : ''}
${scadenza ? `<p><span class="term-note">Validità</span> &nbsp; Preventivo valido fino al <b>${scadenza}</b>.</p>` : ''}
${str(s.nota_iva) ? `<p class="caption" style="margin-top:3mm;">${esc(s.nota_iva)}</p>` : ''}
${vexBox}
<div class="sig-grid">
  ${clientSig}
  <div class="sig auto-signed">
    <span class="role">Documento emesso e sottoscritto da</span>
    <span class="name">${esc(s.legale_rappresentante || s.ragione_sociale || '')}</span>
    <div class="signed-bar">✓ Firmato in originale dal fornitore</div>
    <div class="meta">${esc(s.ragione_sociale || '')}${str(s.piva) ? ` · P.IVA ${esc(s.piva)}` : ''}<br>${formatQuoteDate(q.createdAt)}</div>
  </div>
</div>`;
}

// --- Assembly ---------------------------------------------------------------

/**
 * Build the ordered content pages (everything after cover + TOC).
 * Exposed for testing; renderQuoteHtml is the main entry point.
 */
export function buildQuotePages(
  input: QuoteTemplateInput,
  settings: QuoteTemplateSettings = {},
): ContentPage[] {
  const q = normalizeQuote(input, settings);
  const pages: ContentPage[] = [];
  let sectionNum = 0;

  // Merge consecutive `clausole` sections onto a single page.
  type Grouped = { type: string; entries: Array<Record<string, unknown>> };
  const grouped: Grouped[] = [];
  for (const s of q.sections) {
    const data = rec(s.data);
    const last = grouped[grouped.length - 1];
    if (s.type === 'clausole' && last?.type === 'clausole') last.entries.push(data);
    else grouped.push({ type: s.type, entries: [data] });
  }

  const contrattoData = q.sections.find((s) => s.type === 'contratto')?.data;

  for (const g of grouped) {
    const d = g.entries[0];
    const label = sectionLabel(g.type);

    switch (g.type) {
      case 'premessa': {
        if (!str(d.testo)) break;
        sectionNum++;
        pages.push({ tocKey: `premessa-${sectionNum}`, tocTitle: label.title, tocSub: label.sub, bodyHtml: renderPremessa(d, sectionNum, q) });
        break;
      }
      case 'comparativa': {
        if (!arr(d.righe).length) break;
        sectionNum++;
        pages.push({ tocKey: `comparativa-${sectionNum}`, tocTitle: str(d.titolo) || label.title, tocSub: label.sub, bodyHtml: renderComparativa(d, sectionNum) });
        break;
      }
      case 'offerte': {
        const offerte = g.entries.flatMap((e) => arr<Record<string, unknown>>(e.offerte)).filter((o) => str(o.nome));
        if (!offerte.length) break;
        sectionNum++;
        const groups = chunk(offerte, OFFERS_PER_PAGE);
        groups.forEach((group, i) => {
          const isLast = i === groups.length - 1;
          pages.push({
            tocKey: `offerte-${sectionNum}`,
            tocTitle: label.title,
            tocSub: label.sub,
            bodyHtml: renderOffertePage(group, sectionNum, i, groups.length, isLast ? { total: q.total, bollo: q.bollo } : null),
          });
        });
        break;
      }
      case 'problemi': {
        if (!arr(d.lista).length) break;
        sectionNum++;
        pages.push({ tocKey: `problemi-${sectionNum}`, tocTitle: label.title, tocSub: label.sub, bodyHtml: renderProblemi(d, sectionNum) });
        break;
      }
      case 'clausole': {
        const valid = g.entries.filter((e) => str(e.titolo) || str(e.testo));
        if (!valid.length) break;
        sectionNum++;
        pages.push({ tocKey: `clausole-${sectionNum}`, tocTitle: label.title, tocSub: label.sub, bodyHtml: renderClausoleBoxes(valid, sectionNum) });
        break;
      }
      case 'materiali': {
        if (!arr<string>(d.lista).filter(Boolean).length) break;
        sectionNum++;
        pages.push({ tocKey: `materiali-${sectionNum}`, tocTitle: label.title, tocSub: label.sub, bodyHtml: renderMateriali(d, sectionNum) });
        break;
      }
      case 'tempistiche': {
        if (!str(d.prima_bozza) && !arr(d.fasi).length) break;
        sectionNum++;
        pages.push({ tocKey: `tempistiche-${sectionNum}`, tocTitle: label.title, tocSub: label.sub, bodyHtml: renderTempistiche(d, sectionNum) });
        break;
      }
      case 'pagamento': {
        if (!arr(d.modalita).length) break;
        sectionNum++;
        pages.push({ tocKey: `pagamento-${sectionNum}`, tocTitle: label.title, tocSub: label.sub, bodyHtml: renderPagamento(d, sectionNum, q, settings) });
        break;
      }
      case 'contratto': {
        const articles = resolveContractArticles(settings, d);
        if (!articles.length) break;
        sectionNum++;
        const servizi = arr<string>(d.servizi).filter(Boolean);
        const groups = chunk(articles, ARTICLES_PER_PAGE);
        groups.forEach((group, i) => {
          pages.push({
            tocKey: `contratto-${sectionNum}`,
            tocTitle: label.title,
            tocSub: label.sub,
            bodyHtml: renderContrattoPage(group, sectionNum, i, groups.length, servizi),
          });
        });
        break;
      }
      default:
        break;
    }
  }

  // Closing page: acceptance + signature (+ vessatorie recap when a contract is present).
  const vessatorie = contrattoData !== undefined
    ? resolveContractArticles(settings, contrattoData).filter((a) => a.vessatoria)
    : [];
  sectionNum++;
  pages.push({
    tocKey: 'firma',
    tocTitle: 'Accettazione e firma',
    tocSub: vessatorie.length ? 'Validità, clausole vessatorie e firme' : 'Validità e firme',
    bodyHtml: renderClosingPage(sectionNum, q, settings, vessatorie),
  });

  return pages;
}

export function renderQuoteHtml(
  input: QuoteTemplateInput,
  settings: QuoteTemplateSettings = {},
  opts: QuoteTemplateOptions = {},
): string {
  const q = normalizeQuote(input, settings);
  const brand = str(settings.colore_primario) || '#F57F44';
  const contentPages = buildQuotePages(input, settings);
  const totalPages = contentPages.length + 2; // + cover + TOC
  const numero = opts.draft ? 'BOZZA' : (opts.numero || '');
  const dataEmissione = formatQuoteDate(q.createdAt);
  const clientDisplay = q.companyName || q.customerName;

  const wordmark = str(settings.logo_url)
    ? `<img src="${esc(settings.logo_url)}" alt="${esc(settings.ragione_sociale || '')}">`
    : `<span class="wm-text">${esc(settings.ragione_sociale || 'Preventivo')}</span>`;

  const headerRef = `Preventivo ${esc(clientDisplay)}${numero ? ` · ${esc(numero)}` : ''}`;
  const footerLeft = `${esc(settings.ragione_sociale || '')}${str(settings.piva) ? ` · P.IVA ${esc(settings.piva)}` : ''}<br>${esc(settings.sito_web || settings.email_fornitore || '')}`;

  const pageChrome = (pageNum: number, body: string): string => `<section class="page">
  <header class="page-header"><div class="wordmark">${wordmark}</div><div class="ref">${headerRef}</div></header>
  <div class="page-content">${body}</div>
  <footer class="page-footer">
    <div class="l">${footerLeft}</div>
    <div class="r">Pag. ${pageNum} di ${totalPages}<br>${esc(dataEmissione)}</div>
  </footer>
</section>`;

  // Cover (page 1) — no header/footer chrome.
  const validitaGiorni = q.validUntil
    ? Math.max(1, Math.round((new Date(q.validUntil).getTime() - new Date(q.createdAt).getTime()) / 86400000))
    : null;
  const cover = `<section class="page cover">
  <div class="top">
    <div class="wordmark">${wordmark}</div>
    <div class="meta">${esc(dataEmissione)}${numero ? `<br>${esc(numero)}` : ''}</div>
  </div>
  <div class="hero">
    <h1 class="preventivo-h1">Preventivo</h1>
    <div class="preventivo-h2"><span class="tilde">~</span>&nbsp;${esc(q.title)}</div>
    <div class="client-block">
      <div class="cell"><div class="k">Cliente</div><div class="v">${esc(clientDisplay)}${q.companyName && q.customerName ? `<small>${esc(q.customerName)}</small>` : '<small>&nbsp;</small>'}</div></div>
      <div class="cell"><div class="k">Data</div><div class="v">${esc(dataEmissione)}${validitaGiorni ? `<small>Validità ${validitaGiorni} giorni</small>` : '<small>&nbsp;</small>'}</div></div>
      <div class="cell"><div class="k">Riferimento</div><div class="v">${esc(numero || '—')}<small>${esc(q.subtitle)}</small></div></div>
    </div>
  </div>
  <div class="bottom-band">
    <div class="sig">
      <b>${esc(settings.ragione_sociale || '')}</b>
      ${esc(settings.legale_rappresentante || '')}${str(settings.piva) ? ` · P.IVA ${esc(settings.piva)}` : ''}${str(settings.indirizzo) ? ` · ${esc(settings.indirizzo)}` : ''}<br>
      ${esc(settings.email_fornitore || '')}${str(settings.sito_web) ? ` · ${esc(settings.sito_web)}` : ''}
    </div>
  </div>
</section>`;

  // TOC (page 2) — collapse pages sharing a tocKey into "Pag. X–Y" ranges.
  const tocRows: string[] = [];
  let rowNum = 0;
  for (let i = 0; i < contentPages.length; i++) {
    const p = contentPages[i];
    if (i > 0 && contentPages[i - 1].tocKey === p.tocKey) continue;
    let end = i;
    while (end + 1 < contentPages.length && contentPages[end + 1].tocKey === p.tocKey) end++;
    rowNum++;
    const startPage = i + 3;
    const endPage = end + 3;
    tocRows.push(`<div class="row"><span class="n">${String(rowNum).padStart(2, '0')}</span><span class="t">${esc(p.tocTitle)}<span class="sub">${esc(p.tocSub)}</span></span><span class="p">${startPage === endPage ? `Pag. ${startPage}` : `Pag. ${startPage}–${endPage}`}</span></div>`);
  }
  const toc = pageChrome(2, `${h2(0, 'Indice')}<div class="toc">${tocRows.join('')}</div>`);

  const contentHtml = contentPages.map((p, i) => pageChrome(i + 3, p.bodyHtml)).join('\n');

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<title>Preventivo ${esc(clientDisplay)}${numero ? ` — ${esc(numero)}` : ''}</title>
<style>${buildCss(brand, opts.fontFaceCss || '')}</style>
</head><body>
<div class="doc">
${cover}
${toc}
${contentHtml}
</div>
</body></html>`;
}
