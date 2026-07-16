/**
 * verify-quote-template.ts — renders a fixture quote covering EVERY section
 * type through the shared Swiss-editorial template and generates the PDF via
 * Puppeteer, without touching the DB.
 *
 * Run: pnpm --filter @calicchia/api exec tsx scripts/verify-quote-template.ts
 * Output: scripts/out/verify-quote-template.{html,pdf}
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { renderQuoteHtml } from '../src/lib/quote-renderer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'out');

const sections = [
  {
    id: 's1', type: 'premessa',
    data: {
      testo: 'A seguito del nostro confronto, riportiamo la proposta tecnica ed economica per la vostra presenza digitale: un nuovo sito ottimizzato, il presidio delle mappe e una produzione continuativa di contenuti video.\n\nIl documento descrive strategia, piano esecutivo, tempistiche e investimento, con due proposte economiche alternative.',
      statistiche: [
        { valore: '15', label: 'Pagine ottimizzate' },
        { valore: '4', label: 'Video al mese' },
        { valore: '~6', label: 'Settimane al go-live' },
      ],
    },
  },
  {
    id: 's2', type: 'comparativa',
    data: {
      titolo: 'Confronto con la situazione attuale',
      intro: 'Cosa cambia rispetto al sito esistente.',
      intestazione_a: 'Proposta', intestazione_b: 'Attuale',
      righe: [
        { caratteristica: 'SEO on-page', colonna_a: 'Completa, schema.org', colonna_b: 'Assente' },
        { caratteristica: 'Catalogo prodotti', colonna_a: 'WooCommerce filtrabile', colonna_b: 'Pagine statiche' },
        { caratteristica: 'Schede locali', colonna_a: 'Google + Bing presidiate', colonna_b: 'Non verificate' },
      ],
    },
  },
  {
    id: 's3', type: 'offerte',
    data: {
      offerte: [
        { id: 'o1', nome: 'Sito web — catalogo e SEO on-page', descrizione: 'Redesign completo su WordPress/WooCommerce in modalità catalogo.', prezzo: 1499, consigliata: true, include: ['Catalogo per marca e categoria', 'SEO on-page completa', 'Import 35 annunci'], esclude: ['Calcolatore finanziamento dinamico', 'Campagne ADV'] },
        { id: 'o2', nome: 'Google Business + Bing Places', descrizione: 'Setup e ottimizzazione delle schede locali.', prezzo: 199, consigliata: false, include: ['Verifica scheda', '10-15 foto'], esclude: ['Manutenzione continuativa'] },
        { id: 'o3', nome: 'Gestione social', descrizione: '4 contenuti video pubblicati al mese.', prezzo: 350, consigliata: false, include: ['Calendario editoriale', 'Montaggio e copy'], esclude: [] },
        { id: 'o4', nome: 'Manutenzione schede locali', descrizione: 'Post mensili e risposta recensioni.', prezzo: 29, consigliata: false, include: ['2 post/mese', 'Risposta recensioni 48h'], esclude: [] },
      ],
    },
  },
  {
    id: 's4', type: 'problemi',
    data: {
      lista: [
        { problema: 'Sito non indicizzato sulle ricerche locali', soluzione: 'Sistema a matrici servizi × città con contenuti differenziati' },
        { problema: 'Nessuna presenza su Maps', soluzione: 'Setup e verifica Google Business Profile + Bing Places' },
      ],
    },
  },
  {
    id: 's5', type: 'clausole',
    data: { tipo: 'warning', titolo: 'Cosa NON è incluso', testo: 'Per chiarezza sul perimetro, il preventivo non comprende:', lista: ['Hosting e dominio (restano a gestione diretta del cliente)', 'Budget pubblicitario campagne ADV', 'Riscrittura contenuti dopo l\'approvazione'] },
  },
  {
    id: 's6', type: 'clausole',
    data: { tipo: 'info', titolo: 'Verifica tecnica hosting', testo: 'Prima di avviare lo sviluppo verifichiamo che il piano hosting regga il nuovo sito. Se non fosse adeguato, lo segnaleremo prima di iniziare.', lista: [] },
  },
  {
    id: 's7', type: 'materiali',
    data: { lista: ['Logo (vettoriale)', 'Testi / Copy', 'Foto / Immagini', 'Accessi (hosting, dominio)', 'Elenco annunci esistenti'] },
  },
  {
    id: 's8', type: 'tempistiche',
    data: {
      prima_bozza: '~6 settimane dalla firma',
      nota: 'dalla ricezione dei materiali',
      settimane: 8,
      fasi: [
        { label: 'Discovery & raccolta materiali', start_pct: 0, width_pct: 12.5 },
        { label: 'Verifica tecnica hosting', start_pct: 6, width_pct: 9 },
        { label: 'Setup Google Business & Bing', start_pct: 12.5, width_pct: 25 },
        { label: 'Sviluppo sito & catalogo', start_pct: 12.5, width_pct: 50 },
        { label: 'Avvio social — primi contenuti', start_pct: 6, width_pct: 94 },
        { label: 'Collaudo & go-live', start_pct: 62.5, width_pct: 12.5 },
      ],
    },
  },
  {
    id: 's9', type: 'pagamento',
    data: {
      modalita: [
        { id: 'm1', nome: 'Saldo unico', sconto_percentuale: 10, rate: [] },
        { id: 'm2', nome: '3 rate', sconto_percentuale: 0, rate: [{ percentuale: 33, momento: 'alla firma' }, { percentuale: 33, momento: 'a metà lavoro' }, { percentuale: 34, momento: 'alla consegna' }] },
      ],
    },
  },
  {
    id: 's10', type: 'contratto',
    data: {
      auto: true,
      servizi: ['Redesign sito WordPress/WooCommerce', 'Setup schede locali Google + Bing', 'Gestione social con contenuti video'],
      clausole: [],
      articoli_override: [
        'Art. 1 — OGGETTO: Il Fornitore realizza per il Cliente la presenza digitale descritta nelle sezioni precedenti: (a) redesign del sito su WordPress/WooCommerce; (b) setup schede locali; (c) gestione social continuativa.',
      ],
    },
  },
];

const quote = {
  id: '0a1b2c3d-0000-0000-0000-000000000000',
  title: 'Presenza digitale multicanale — sito, local SEO e video social',
  description: 'Preventivo e Contratto di Incarico',
  customer_name: 'Mario Rossi',
  company_name: 'Passione Moto S.r.l.',
  items: sections[2].data.offerte!.map((o: any) => ({ description: o.nome, quantity: 1, unit_price: o.prezzo, total: o.prezzo })),
  total: 2077,
  valid_until: '2026-08-15',
  notes: 'L\'accettazione avviene con la firma negli appositi spazi e con il pagamento della prima tranche entro 15 giorni dalla firma.',
  created_at: '2026-07-16T10:00:00Z',
  signed_at: null,
  signer_name: null,
  signature_image: null,
  vessatorie_approved_at: null,
  project_template: { sections },
} as any;

const settings = {
  colore_primario: '#F57F44',
  ragione_sociale: 'Calicchia Design',
  legale_rappresentante: 'Federico Calicchia',
  indirizzo: 'Ceccano (FR), Lazio',
  piva: '03160480608',
  email_fornitore: 'federico@calicchia.design',
  sito_web: 'calicchia.design',
  banca: 'Banca Esempio',
  iban: 'IT79 Z036 6901 6009 8955 1082 080',
  bic: 'CHASDEFX',
  nota_iva: "Regime forfettario ai sensi dell'art. 1, commi 54-89, L. 190/2014. Operazione senza applicazione IVA.",
  marca_bollo_nota: 'Su importi superiori a € 77,47 viene applicata marca da bollo da € 2,00.',
  soglia_bollo: 77.47,
  importo_bollo: 2,
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const html = renderQuoteHtml(quote, settings);
  const pageCount = (html.match(/<section class="page/g) || []).length;
  const htmlPath = resolve(OUT_DIR, 'verify-quote-template.html');
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`HTML: ${htmlPath} (${(html.length / 1024).toFixed(0)} KB, ${pageCount} pagine)`);

  // Sanity assertions: every section type must leave a trace in the output.
  const checks: Array<[string, boolean]> = [
    ['cover', html.includes('preventivo-h1')],
    ['toc', html.includes('class="toc"')],
    ['premessa + stats', html.includes('stats-band')],
    ['comparativa', html.includes('Confronto con la situazione attuale')],
    ['offerte', html.includes('Sito web — catalogo e SEO on-page')],
    ['problemi', html.includes('Problemi risolti')],
    ['clausole merged', html.includes('Cosa NON è incluso') && html.includes('Verifica tecnica hosting')],
    ['materiali', html.includes('material-list')],
    ['gantt', html.includes('class="gantt"')],
    ['pagamento + iban', html.includes('ms-grid') && html.includes('IT79 Z036')],
    ['contratto override', html.includes('WordPress/WooCommerce; (b)')],
    ['vessatorie', html.includes('Clausole vessatorie')],
    ['firma', html.includes('sig-grid')],
    ['fonts data-uri', html.includes('data:font/woff2;base64,')],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed++;
  }
  if (failed) {
    console.error(`${failed} check falliti`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(process.platform === 'win32' ? {
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
    });
    const pdfPath = resolve(OUT_DIR, 'verify-quote-template.pdf');
    writeFileSync(pdfPath, pdf);
    console.log(`PDF: ${pdfPath} (${(pdf.length / 1024).toFixed(0)} KB)`);
  } finally {
    await browser.close();
  }
  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
