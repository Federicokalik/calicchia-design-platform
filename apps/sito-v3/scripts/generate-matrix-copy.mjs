#!/usr/bin/env node
/**
 * Genera 32 celle di copy per la matrice servizi×professioni di apps/sito-v3.
 *
 *   8 categorie × 4 servizi matrice = 32 celle
 *
 * Per ogni cella invoca `codex companion task` con un brief strutturato
 * (voice rules + contesto categoria + scope servizio + pain points).
 * Estrae JSON dall'output, valida shape, esegue voice linter.
 * Accumula i risultati in 4 file:
 *   src/data/seo-content/{web-design,e-commerce,sviluppo-web,seo}.ts
 *
 * Concorrenza: 4 chiamate parallele alla volta (default), tunabile via env.
 *
 * Usage:
 *   node scripts/generate-matrix-copy.mjs                    # run completo
 *   node scripts/generate-matrix-copy.mjs --only beauty-wellness  # singola cat
 *   node scripts/generate-matrix-copy.mjs --service seo      # singolo servizio
 *   CONCURRENCY=2 node scripts/generate-matrix-copy.mjs      # rallenta
 *   DRY_RUN=1 node scripts/generate-matrix-copy.mjs          # log brief, no codex
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'src/data/seo-content');
const COMPANION = 'C:/Users/calicchiadesign/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? '4');
const DRY_RUN = process.env.DRY_RUN === '1';

// ─── CLI args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const ONLY_CATEGORY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const ONLY_SERVICE = args.includes('--service') ? args[args.indexOf('--service') + 1] : null;

// ─── BANNED WORDS (voice linter) ──────────────────────────────────
const BANNED = [
  /\bsoluzion[ei]\b/i,
  /valore aggiunto/i,
  /esperienza utente/i,
  /\bleadership\b/i,
  /\bpassione\b/i,
  /\bdedizione\b/i,
  /cose che funzionano/i,
  /\bsinergia\b/i,
  /\beccellenza\b/i,
  /\bpreventivo\b/i,        // CTA NO preventivo
  /\btariffa\b/i,
  /a partire da/i,
  /€\s*\d/,
  /\bEUR\b/,
];

function voiceLint(text) {
  const hits = [];
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

// ─── CATEGORIES (estratto da seo-professions.ts) ──────────────────
const CATEGORIES = {
  'beauty-wellness': {
    label: 'Beauty & Wellness',
    description: 'Bellezza e benessere: parrucchieri, estetiste, palestre, centri estetici, scuole danza. Pubblico che si gioca prima impressione tra Instagram e Google.',
    sample: ['parrucchieri', 'barbieri', 'estetiste', 'centri-estetici', 'palestre'],
  },
  'sanita-salute': {
    label: 'Sanità e Salute',
    description: 'Professionisti sanitari (dentisti, medici, fisioterapisti, psicologi, veterinari). Conformità deontologica + ricerca paziente che cerca fiducia online.',
    sample: ['dentisti', 'psicologi', 'fisioterapisti', 'veterinari', 'medici'],
  },
  'studi-professionali': {
    label: 'Studi Professionali',
    description: 'Avvocati, commercialisti, architetti, agenzie immobiliari, notai. B2B/B2C in cui passaparola + Google = crescita; ricerca cliente "professionista a [città]".',
    sample: ['avvocati', 'commercialisti', 'architetti', 'agenzie-immobiliari', 'notai'],
  },
  'casa-edilizia': {
    label: 'Casa, Impianti e Edilizia',
    description: 'Artigiani edili (idraulici, elettricisti, imprese edili, serramentisti, fabbri). Ricerche urgenti tipo "idraulico urgente [città]"; portfolio lavori = prova.',
    sample: ['idraulici', 'elettricisti', 'imprese-edili', 'fabbri', 'serramentisti'],
  },
  'auto-mobilita': {
    label: 'Auto e Mobilità',
    description: 'Officine, carrozzieri, gommisti, autoscuole, concessionarie. Cliente cerca su Google quando l\'auto si rompe; recensioni e prossimità contano molto.',
    sample: ['officine-meccaniche', 'carrozzieri', 'gommisti', 'autoscuole', 'concessionarie-auto'],
  },
  'food-hospitality': {
    label: 'Food, Hospitality e Turismo',
    description: 'Ristoranti, bar, hotel, B&B, agriturismi, pasticcerie. Decisione su smartphone (menu/foto/prenotazione); dipendenza da TripAdvisor/Booking se manca sito proprio.',
    sample: ['ristoranti', 'hotel', 'b-b', 'pizzerie', 'agriturismi'],
  },
  'retail-negozi': {
    label: 'Retail e Negozi',
    description: 'Negozi fisici (abbigliamento, gioiellerie, fiorai, ferramenta, librerie). Online = visibilità + vetrina, non sostituzione del fisico.',
    sample: ['negozi-di-abbigliamento', 'arredamenti', 'gioiellerie', 'fiorai', 'librerie'],
  },
  'creativita-eventi': {
    label: 'Creatività, Digitale e Eventi',
    description: 'Fotografi, videomaker, wedding planner, organizzatori eventi, scuole formazione. Lavoro visivo/emozionale; portfolio frammentato tra IG/Behance/Drive.',
    sample: ['fotografi', 'videomaker', 'wedding-planner', 'organizzatori-eventi', 'agenzie-viaggi'],
  },
};

// ─── SERVIZI MATRICE ──────────────────────────────────────────────
const SERVICES = {
  'sito-web': {
    label: 'Web Design',
    deliverables: [
      'Sito vetrina cucito su misura (no template)',
      'Galleria lavori, pagine servizi, SEO tecnica base',
      'Google Business profile + integrazione mappe',
      'Privacy/cookie GDPR a posto',
      'Form contatto / WhatsApp button',
    ],
    fileKey: 'web-design',
  },
  'e-commerce': {
    label: 'E-Commerce',
    deliverables: [
      'WooCommerce / piattaforma custom',
      'Catalogo prodotti, varianti, magazzino',
      'Pagamenti (Stripe/PayPal/bonifico) + spedizioni',
      'Email transazionali, recovery carrello',
      'Schema Product/Offer per Google Shopping',
    ],
    fileKey: 'e-commerce',
  },
  'sviluppo-web': {
    label: 'Sviluppo Web',
    deliverables: [
      'Web app custom (gestionali, dashboard, area clienti)',
      'API e integrazioni terze parti (CRM, ERP, gestionali esistenti)',
      'Portali con login/ruoli/permessi',
      'Automazioni e chatbot AI',
      'Performance da SaaS moderno',
    ],
    fileKey: 'sviluppo-web',
  },
  'seo': {
    label: 'SEO & Visibilità',
    deliverables: [
      'Audit tecnico (Core Web Vitals, crawlability, indexing)',
      'Strategia keyword + content plan settoriale',
      'SEO locale (Google Business, citation, recensioni)',
      'Ottimizzazione on-page + schema markup',
      'Monitoring mensile (rank tracking, GSC, GA4)',
    ],
    fileKey: 'seo',
  },
};

// ─── PAIN POINTS settoriali per servizio (estratti da memoria audit) ──
// (cat, svc) → 3 pain points specifici. Se mancano, fallback su pain generici.
const PAINS = {
  // beauty x ALL
  'beauty-wellness:sito-web': [
    'Sito generico identico al concorrente (template comprato 50€)',
    'Foto solo da Instagram, nessuna identità del brand sul sito',
    'Sito esiste ma non porta prenotazioni, invisibile su Google',
  ],
  'beauty-wellness:e-commerce': [
    'Vendi solo a chi entra in salone (prodotti pro, gift card non monetizzati)',
    'Niente buoni regalo digitali — perdi vendite stagione regali',
    'Fatturato solo legato al passaggio fisico',
  ],
  'beauty-wellness:sviluppo-web': [
    'Prenotazioni gestite a mano tra telefono, WhatsApp e quaderno',
    'Software gestionale del salone non parla con sito né social',
    'Calendario condiviso tra 4 persone con conflitti continui',
  ],
  'beauty-wellness:seo': [
    'Compari solo su Instagram, mai per "parrucchiere a [città]"',
    'Google Business non ottimizzato (orari sbagliati, foto vecchie)',
    'Recensioni Google ferme da mesi, nessun nuovo trigger',
  ],
  // sanita x ALL
  'sanita-salute:sito-web': [
    'Sito vecchio o assente trasmette poca professionalità',
    'I pazienti non possono prenotare appuntamento online',
    'Pagine trattamenti scritte in gergo medico illeggibile',
  ],
  'sanita-salute:e-commerce': [
    'Prodotti parafarmaceutici / integratori venduti solo in studio',
    'Pazienti chiedono prodotti consigliati ma li comprano altrove',
    'Carrello deontologicamente conforme richiede attenzione',
  ],
  'sanita-salute:sviluppo-web': [
    'Agenda gestita su carta o Excel; doppi appuntamenti frequenti',
    'Cartelle cliniche elettroniche separate dal sito',
    'Pazienti chiamano per orari/disponibilità invece di vederli online',
  ],
  'sanita-salute:seo': [
    'Pazienti cercano "dentista [città]" e trovano i colleghi',
    'Pagine senza schema MedicalOrganization / Physician',
    'Nessuna strategia content su sintomi/patologie',
  ],
  // studi-professionali x ALL
  'studi-professionali:sito-web': [
    'Sito anni 2000 con testi legalese illeggibili',
    'Chi sei/cosa fai nascosto in pagina "About" terziaria',
    'Nessun lead magnet o richiesta consulenza strutturata',
  ],
  'studi-professionali:e-commerce': [
    'Vendita di servizi forfettari (consulenze tipo, pacchetti) non automatizzata',
    'Documenti scaricabili (template, modelli) gestiti via email',
    'Nessuna area "compra ora" per pratiche standard',
  ],
  'studi-professionali:sviluppo-web': [
    'Pratiche e documenti scambiati via email senza tracking',
    'Clienti chiamano in continuazione per stato pratiche',
    'Nessuna area riservata client-side per upload/download documenti',
  ],
  'studi-professionali:seo': [
    'Chi cerca "avvocato divorzista [città]" non ti trova',
    'Blog mai aggiornato o contenuti generici copiati',
    'Schema LegalService / AccountingService assenti',
  ],
  // casa-edilizia x ALL
  'casa-edilizia:sito-web': [
    'Solo passaparola, nessuna presenza online strutturata',
    'Niente prova fotografica dei lavori (portfolio)',
    'Nessun bottone "Chiama ora" mobile-first',
  ],
  'casa-edilizia:e-commerce': [
    'Vendi materiali/utensili specializzati ma solo offline',
    'I clienti chiamano per disponibilità invece di vederla online',
    'Nessun listino prodotti consultabile',
  ],
  'casa-edilizia:sviluppo-web': [
    'Preventivi gestiti su Word, mai uniformi',
    'Squadra in cantiere senza area di riferimento per ordini/pratiche',
    'Cliente chiama per stato lavori invece di vederlo in dashboard',
  ],
  'casa-edilizia:seo': [
    'Ricerche urgenti "idraulico [città] subito" non ti trovano',
    'Google Business profile incompleto (zone servite, foto)',
    'Nessuna pagina servizio per emergenze (turno notte/festivo)',
  ],
  // auto-mobilita x ALL
  'auto-mobilita:sito-web': [
    'Niente listino servizi, il cliente deve chiamare per sapere il prezzo',
    'Foto di repertorio, nessuna prova visiva di lavori reali',
    'Sito non risponde quando il telefono è occupato',
  ],
  'auto-mobilita:e-commerce': [
    'Ricambi e accessori venduti solo al banco',
    'Nessun catalogo online consultabile prima della visita',
    'Concorrenza online (Norauto, AutoZone) prende fascia digitale',
  ],
  'auto-mobilita:sviluppo-web': [
    'Appuntamenti officina su carta, doppie prenotazioni continue',
    'Nessun follow-up automatico post-tagliando',
    'Storico interventi per cliente non centralizzato',
  ],
  'auto-mobilita:seo': [
    'Cerco "officina [città] aperta sabato" e trovo competitor',
    'Recensioni Google poche e mai sollecitate',
    'Nessuna strategia local + ricambi per modello',
  ],
  // food-hospitality x ALL
  'food-hospitality:sito-web': [
    'Cliente arriva, non trova menu sul sito o è una foto del PDF',
    'Nessuna prenotazione integrata (telefono che squilla a servizio)',
    'Foto solo da smartphone scure, nessuna identità visiva',
  ],
  'food-hospitality:e-commerce': [
    'Asporto/delivery dipende solo da Glovo/Deliveroo (commissioni 30%)',
    'Cesti regalo, prodotti tipici, gift voucher non venduti online',
    'Nessuna prenotazione tavolo prepagata',
  ],
  'food-hospitality:sviluppo-web': [
    'Gestionale prenotazioni separato dal sito, double booking frequenti',
    'POS + magazzino + sito non comunicano',
    'Prenotazioni camere via email scollegate dal CRM',
  ],
  'food-hospitality:seo': [
    'Cerco "ristorante [città] menu" e Google mostra concorrenti',
    'Google Business profile senza menu link, foto piatti, orari aggiornati',
    'Recensioni Google ferme, nessuna strategia di sollecito',
  ],
  // retail-negozi x ALL
  'retail-negozi:sito-web': [
    'Nessuna vetrina online dei prodotti — il cliente non sa cosa hai',
    'Orari e indirizzo difficili da trovare',
    'WhatsApp/contatto diretto sepolto in pagina contatti',
  ],
  'retail-negozi:e-commerce': [
    'Vendi solo in orario apertura — concorrenza online vende h24',
    'Nessuna integrazione magazzino — vendi prodotti fuori stock',
    'Marketplace generici (Amazon) prendono i tuoi clienti',
  ],
  'retail-negozi:sviluppo-web': [
    'Programma fedeltà cartaceo, nessun tracking digitale',
    'Magazzino gestito su Excel disallineato dal POS',
    'Cliente non vede disponibilità prima di entrare',
  ],
  'retail-negozi:seo': [
    'Cerco "[prodotto] [quartiere]" e trovo la catena, non te',
    'Schede prodotto con descrizioni copiate dal fornitore',
    'Google Business profile senza foto interno e prodotti',
  ],
  // creativita-eventi x ALL
  'creativita-eventi:sito-web': [
    'Portfolio frammentato tra Instagram, Behance, Drive — nessun catalog',
    'Niente spiegazione del processo / pacchetti — solo "info via DM"',
    'Sito lento, immagini non ottimizzate per mobile',
  ],
  'creativita-eventi:e-commerce': [
    'Stampe, libri foto, pacchetti pre-confezionati venduti via DM',
    'Nessun listino chiaro / configuratore pacchetti',
    'Caparra non automatizzata (gestita via bonifico manuale)',
  ],
  'creativita-eventi:sviluppo-web': [
    'Calendario disponibilità sparso tra mail e Google Calendar',
    'Brief cliente raccolto via mail, mai strutturato',
    'Galleria privata cliente condivisa via Drive (non personalizzata)',
  ],
  'creativita-eventi:seo': [
    'Cerco "fotografo matrimonio [città]" e trovo i wedding planner',
    'Niente landing per nicchia (engagement, lifestyle, eventi corporate)',
    'Schema CreativeWork / Service mancante',
  ],
};

function buildPrompt(catId, svcSlug) {
  const cat = CATEGORIES[catId];
  const svc = SERVICES[svcSlug];
  const painsKey = `${catId}:${svcSlug}`;
  const pains = PAINS[painsKey] ?? [
    `Pain settoriale 1 per ${cat.label} × ${svc.label}`,
    `Pain settoriale 2 per ${cat.label} × ${svc.label}`,
    `Pain settoriale 3 per ${cat.label} × ${svc.label}`,
  ];

  return `TASK: genera UN blocco JSON di copy SEO per la combinazione (categoria=${catId}, servizio=${svcSlug}). Restituisci SOLO il JSON, niente prefazioni, niente markdown, niente spiegazioni. Iniziando con \`{\` e finendo con \`}\`.

VOICE: copywriter B2B IT, voice freelance anti-agenzia, anti-marketing.
DIVIETO ASSOLUTO parole: "soluzioni", "valore aggiunto", "esperienza utente", "leadership", "passione", "dedizione", "cose che funzionano", "sinergia", "eccellenza", "preventivo", "tariffa", "a partire da".
TONO: aggressivo verso il PROBLEMA (catena di fornitori, agenzie a 6 mani, template generici, plug-in random), MAI verso il lettore. Chiusure tipo "Punto.", "Fine della storia.", "Decidi tu."

CATEGORIA: ${cat.label}
DESCRIZIONE: ${cat.description}
PROFESSIONI ESEMPIO (usa per esempi concreti, NON elencarle tutte): ${cat.sample.join(', ')}

SERVIZIO: ${svc.label}
DELIVERABLES TIPICI:
${svc.deliverables.map((d) => `  - ${d}`).join('\n')}

PAIN POINTS NOTI di QUESTA combinazione:
${pains.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

OUTPUT JSON (singolo oggetto, no array, no wrapper, no markdown fences):
{
  "description": "<descrizione settoriale del problema/scope, 30-60 parole, settoriale e concreta>",
  "solutionTitle": "<≤80 caratteri, pungente, parla di QUESTA categoria specificamente>",
  "problems": [
    {"icon":"ph-XXX","title":"<3-5 parole>","desc":"<25-50 parole concrete>"},
    {"icon":"ph-XXX","title":"<3-5 parole>","desc":"<25-50 parole concrete>"},
    {"icon":"ph-XXX","title":"<3-5 parole>","desc":"<25-50 parole concrete>"}
  ],
  "features": [
    {"title":"<3-6 parole>","description":"<20-40 parole>"},
    {"title":"<3-6 parole>","description":"<20-40 parole>"},
    {"title":"<3-6 parole>","description":"<20-40 parole>"},
    {"title":"<3-6 parole>","description":"<20-40 parole>"},
    {"title":"<3-6 parole>","description":"<20-40 parole>"}
  ],
  "faqs": [
    {"question":"<domanda reale del cliente del settore>","answer":"<30-70 parole, mai vendere, sempre dare risposta utile>"},
    {"question":"<domanda reale>","answer":"<30-70 parole>"},
    {"question":"<domanda reale>","answer":"<30-70 parole>"},
    {"question":"<domanda reale>","answer":"<30-70 parole>"},
    {"question":"<domanda reale>","answer":"<30-70 parole>"}
  ],
  "ctaText": "<≤60 caratteri, NO 'preventivo', sì 'Sentiamoci'/'Scrivimi'/'Parliamone'/'Sentiamoci e mettiamo ordine'>",
  "searchExamplePrefix": "<2-4 parole tipo 'parrucchiere a' o 'comprare online' — quello che il cliente del settore Google sull'argomento del servizio>"
}

VINCOLI:
- icon Phosphor: usa nomi tipo ph-storefront, ph-camera, ph-magnifying-glass, ph-clock, ph-warning-circle, ph-instagram-logo, ph-calendar-blank, ph-chart-line-down, ph-prohibit, ph-sparkle, ph-shield-check, ph-shopping-bag, ph-credit-card, ph-truck, ph-receipt, ph-database, ph-gear, ph-lock, ph-graph, ph-trending-up, ph-globe, ph-code, ph-robot, ph-brain.
- Niente prezzi, niente €, niente "a partire da".
- Le faq.answer NON devono mai parlare di prezzi/preventivi numerici.
- Tutti i testi devono essere SETTORIALI (es. parla di "salone" o "cliente" o "appuntamento" per beauty, non genericamente di "azienda").
- Preserva accenti italiani correttamente (è, é, à, ò, ù).`;
}

// ─── Helpers ──────────────────────────────────────────────────────
function extractJson(stdout) {
  // Codex companion stampa righe `[codex] ...` + l'assistant message finale.
  // Cerca il primo `{` e l'ultimo `}` e prova a parsare.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON braces found in output');
  }
  const slice = stdout.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}`);
  }
}

function validateShape(obj) {
  const errs = [];
  if (typeof obj.description !== 'string' || obj.description.length < 30) errs.push('description short');
  if (typeof obj.solutionTitle !== 'string' || obj.solutionTitle.length < 10) errs.push('solutionTitle short');
  if (!Array.isArray(obj.problems) || obj.problems.length !== 3) errs.push('problems not 3');
  if (!Array.isArray(obj.features) || obj.features.length !== 5) errs.push('features not 5');
  if (!Array.isArray(obj.faqs) || obj.faqs.length !== 5) errs.push('faqs not 5');
  if (typeof obj.ctaText !== 'string' || obj.ctaText.length === 0) errs.push('ctaText missing');
  if (typeof obj.searchExamplePrefix !== 'string') errs.push('searchExamplePrefix missing');
  return errs;
}

function runCodex(prompt) {
  return new Promise((resolveProm, rejectProm) => {
    const child = spawn('node', [COMPANION, 'task', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectProm(new Error('Codex timeout (300s)'));
    }, 300_000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectProm(new Error(`Codex exit ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolveProm(stdout);
      }
    });
  });
}

async function generateCell(catId, svcSlug) {
  const prompt = buildPrompt(catId, svcSlug);
  const tag = `${catId}×${svcSlug}`;

  if (DRY_RUN) {
    console.log(`[dry] ${tag} — prompt ${prompt.length} chars`);
    return { catId, svcSlug, content: null, ok: true };
  }

  console.log(`[run] ${tag} — sending to codex…`);
  const t0 = Date.now();
  let stdout;
  try {
    stdout = await runCodex(prompt);
  } catch (e) {
    console.error(`[FAIL] ${tag} — ${e.message}`);
    return { catId, svcSlug, content: null, ok: false, error: e.message };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  let content;
  try {
    content = extractJson(stdout);
  } catch (e) {
    console.error(`[FAIL] ${tag} — JSON extract: ${e.message}`);
    return { catId, svcSlug, content: null, ok: false, error: e.message };
  }

  const shapeErrs = validateShape(content);
  if (shapeErrs.length) {
    console.error(`[FAIL] ${tag} — shape: ${shapeErrs.join(', ')}`);
    return { catId, svcSlug, content: null, ok: false, error: shapeErrs.join('; ') };
  }

  const flatText = JSON.stringify(content);
  const lintHits = voiceLint(flatText);
  if (lintHits.length) {
    console.warn(`[warn] ${tag} — voice lint hits: ${lintHits.join(', ')} (kept anyway)`);
  }

  console.log(`[ok]   ${tag} — ${elapsed}s, lint:${lintHits.length}`);
  return { catId, svcSlug, content, ok: true, lintHits };
}

// ─── Concurrency pool ─────────────────────────────────────────────
async function pool(items, worker, concurrency) {
  const results = [];
  let next = 0;
  async function runSlot() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runSlot));
  return results;
}

// ─── Output writer ────────────────────────────────────────────────
function tsString(value) {
  // JSON.stringify safe for TS: escape backticks not needed, just standard JSON.
  return JSON.stringify(value, null, 2);
}

async function writeServiceFile(svcSlug, cellsByCategory) {
  const svc = SERVICES[svcSlug];
  const filename = `${svc.fileKey}.ts`;
  const filepath = resolve(OUT_DIR, filename);

  const entries = Object.entries(cellsByCategory)
    .filter(([, content]) => content !== null)
    .map(([catId, content]) => `  '${catId}': ${tsString(content)}`)
    .join(',\n');

  const constName = svc.fileKey
    .toUpperCase()
    .replace(/-/g, '_') + '_CONTENT';

  const out = `// AUTO-GENERATED by scripts/generate-matrix-copy.mjs — refactor 2026-05.
// Do not edit by hand; regenerate the relevant cell instead.
// Servizio: ${svc.label}
// Categorie: ${Object.keys(cellsByCategory).filter((c) => cellsByCategory[c]).join(', ')}

import type { ServiceCategoryContent } from '../seo-service-content';

export const ${constName}: Record<string, ServiceCategoryContent> = {
${entries}
};
`;

  await writeFile(filepath, out, 'utf8');
  console.log(`[wrote] ${filepath}`);
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const cells = [];
  for (const catId of Object.keys(CATEGORIES)) {
    if (ONLY_CATEGORY && catId !== ONLY_CATEGORY) continue;
    for (const svcSlug of Object.keys(SERVICES)) {
      if (ONLY_SERVICE && svcSlug !== ONLY_SERVICE) continue;
      cells.push({ catId, svcSlug });
    }
  }

  console.log(`Plan: ${cells.length} cells, concurrency=${CONCURRENCY}, dryRun=${DRY_RUN}`);
  const t0 = Date.now();
  const results = await pool(cells, ({ catId, svcSlug }) => generateCell(catId, svcSlug), CONCURRENCY);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Group by service
  const bySvc = {};
  for (const svcSlug of Object.keys(SERVICES)) {
    bySvc[svcSlug] = {};
    for (const catId of Object.keys(CATEGORIES)) {
      bySvc[svcSlug][catId] = null;
    }
  }
  for (const r of results) {
    if (r && r.ok && r.content) {
      bySvc[r.svcSlug][r.catId] = r.content;
    }
  }

  // Write 1 file per service (only services we processed)
  for (const svcSlug of Object.keys(SERVICES)) {
    if (ONLY_SERVICE && svcSlug !== ONLY_SERVICE) continue;
    const cellsByCategory = bySvc[svcSlug];
    const hasAny = Object.values(cellsByCategory).some((v) => v !== null);
    if (!hasAny) continue;
    await writeServiceFile(svcSlug, cellsByCategory);
  }

  // Final report
  const okCount = results.filter((r) => r && r.ok).length;
  const failCount = results.filter((r) => r && !r.ok).length;
  console.log(`\n=== Summary ===`);
  console.log(`Total cells: ${cells.length}`);
  console.log(`OK: ${okCount}  |  FAIL: ${failCount}`);
  console.log(`Wall time: ${elapsed}s`);
  if (failCount > 0) {
    console.log(`\nFailed cells:`);
    for (const r of results.filter((x) => x && !x.ok)) {
      console.log(`  - ${r.catId}×${r.svcSlug}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
