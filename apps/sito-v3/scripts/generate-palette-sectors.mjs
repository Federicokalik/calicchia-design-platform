#!/usr/bin/env node
/**
 * Genera i testi dei settori del tool "Palette di settore" (IT + EN).
 *
 *   un settore = una professione di src/data/seo-professions.ts
 *   un file per categoria: src/data/risorse/palette/sectors/{categoryId}.ts
 *
 * Per ogni settore invoca `codex companion task` con un brief strutturato
 * (voice rules + contesto del settore + un settore già scritto come esempio),
 * estrae il JSON dall'output, valida la forma ed esegue il linter della voce.
 * I file di categoria vengono riscritti in forma canonica (JSON indentato).
 *
 * Regole di scrittura:
 *  - le voci con `reviewed: true` non vengono mai riscritte, nemmeno con --force;
 *  - le voci presenti ma non riviste si rigenerano solo con --force;
 *  - di default si generano solo i settori che mancano.
 * I file si possono modificare a mano (anche in sintassi TS): il generatore li
 * rilegge con il compilatore TypeScript. Vanno tenuti senza import runtime
 * (solo `import type`), perché li legge anche lo script di pre-calcolo dell'API.
 * I commenti dentro l'array non si conservano alla riscrittura.
 *
 * Usage (da apps/sito-v3):
 *   node scripts/generate-palette-sectors.mjs                        # settori mancanti, tutte le categorie
 *   node scripts/generate-palette-sectors.mjs --only beauty-wellness # una categoria
 *   node scripts/generate-palette-sectors.mjs --slug barbieri        # un settore (ripetibile)
 *   node scripts/generate-palette-sectors.mjs --force                # rigenera anche i presenti non rivisti
 *   node scripts/generate-palette-sectors.mjs --lint                 # valida e linta i settori presenti, niente codex
 *   node scripts/generate-palette-sectors.mjs --format               # riscrive i file in forma canonica, niente codex
 *   CONCURRENCY=2 node scripts/generate-palette-sectors.mjs          # rallenta
 *   DRY_RUN=1 node scripts/generate-palette-sectors.mjs --slug x     # piano e brief, niente codex né scritture
 */

import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'src/data');
const OUT_DIR = resolve(DATA_DIR, 'risorse/palette/sectors');
const COMPANION = 'C:/Users/calicchiadesign/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? '3');
const DRY_RUN = process.env.DRY_RUN === '1';

// ─── CLI args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValues(flag) {
  const out = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]);
  });
  return out;
}
const ONLY_CATEGORY = argValues('--only')[0] ?? null;
const ONLY_SLUGS = argValues('--slug');
const FORCE = args.includes('--force');
const LINT_ONLY = args.includes('--lint');
const FORMAT_ONLY = args.includes('--format');

// ─── Categorie (stesso ordine di PROFESSION_CATEGORIES) ───────────
const CATEGORIES = {
  'beauty-wellness': {
    it: 'Beauty & Wellness',
    en: 'Beauty & Wellness',
    description: 'Bellezza, sport e benessere: saloni, palestre, centri estetici, discipline. Il cliente sceglie con gli occhi, tra Instagram e Google.',
  },
  'sanita-salute': {
    it: 'Sanità e Salute',
    en: 'Healthcare',
    description: 'Professionisti sanitari. Il paziente cerca fiducia, ordine e calma; deontologia e sobrietà contano.',
  },
  'studi-professionali': {
    it: 'Studi Professionali',
    en: 'Professional Services',
    description: 'Avvocati, commercialisti, tecnici, consulenti. Si vende competenza e affidabilità; molto passa dalla carta stampata.',
  },
  'casa-edilizia': {
    it: 'Casa, Impianti e Edilizia',
    en: 'Home, Trades & Construction',
    description: 'Artigiani e imprese di casa e cantiere. Ricerche spesso urgenti; furgoni, divise e cartelli di cantiere portano i colori in strada.',
  },
  'auto-mobilita': {
    it: 'Auto e Mobilità',
    en: 'Auto & Mobility',
    description: 'Officine, carrozzerie, autoscuole, noleggi. Il cliente vuole chiarezza su tempi e costi; insegna e tute sono il primo biglietto da visita.',
  },
  'food-hospitality': {
    it: 'Food, Hospitality e Turismo',
    en: 'Food, Hospitality & Tourism',
    description: 'Ristorazione e ospitalità. La scelta si fa sul telefono guardando foto, menu e orari; i colori finiscono su menu, insegne, packaging.',
  },
  'retail-negozi': {
    it: 'Retail e Negozi',
    en: 'Retail & Shops',
    description: 'Negozi fisici. Il sito fa da vetrina e porta in negozio; i colori stanno su insegna, shopper, cartellini.',
  },
  'creativita-eventi': {
    it: 'Creatività, Digitale e Eventi',
    en: 'Creative & Events',
    description: 'Fotografi, eventi, formazione, servizi alla persona. Lavoro visivo o di fiducia; il portfolio o il tono contano più del listino.',
  },
};

// Come PRESET_KEYS in packages/shared/src/palette/presets.ts.
const PRESETS = {
  morbido: 'angoli tondi, ombre leggere, sans arrotondato. Per attività calde e informali (food casual, beauty, negozi).',
  netto: 'angoli appena smussati, bordi sottili, grotesk pulito. Per servizi di fiducia e ordine (sanità, consulenza, servizi tecnici puliti).',
  editoriale: 'spigoli vivi, filetti sottili, serif nei titoli. Per studi, ospitalità curata, creativi, artigianato di pregio.',
  tecnico: 'bordi spessi, ombre piene, titoli condensati. Per officine, sport, impianti, mestieri tecnici.',
};

// Lunghezze massime dei campi del copy (caratteri).
const LIMITS = {
  name: 34,
  nav: 18,
  eyebrow: 44,
  h1: 64,
  lead: 160,
  btn1: 30,
  btn2: 30,
  title: 26,
  description: 80,
  meta: 24,
  banner: 64,
};
const COPY_FIELDS = ['name', 'nav', 'eyebrow', 'h1', 'lead', 'btn1', 'btn2'];
const INTRO_WORDS = { min: 110, max: 300 };

// ─── Voice linter ─────────────────────────────────────────────────
// Parole vietate ovunque (IT).
const BANNED_IT = [
  /\bsoluzion[ei]\b/i,
  /valore aggiunto/i,
  /esperienza utente/i,
  /\bleadership\b/i,
  /\bpassione\b/i,
  /\bdedizione\b/i,
  /\bsinergi[ae]\b/i,
  /\beccellenz[ae]\b/i,
  /a 360 gradi/i,
  /\bil migliore\b/i,
  /\bstraordinari[oae]?\b/i,
  /\bincredibil[ei]\b/i,
];
// Solo nell'intro (la voce del sito): niente prezzi né preventivi.
const BANNED_IT_INTRO = [/\bpreventiv[oi]\b/i, /\btariff[ae]\b/i, /a partire da/i, /€\s*\d|\d\s*€/, /\bEUR\b/];
const BANNED_EN = [
  /\bsolutions?\b/i,
  /value[- ]added/i,
  /cutting[- ]edge/i,
  /\bseamless(ly)?\b/i,
  /\belevate\b/i,
  /\bunlock\b/i,
  /\bpassion(ate)?\b/i,
  /\bexcellence\b/i,
  /world[- ]class/i,
  /best[- ]in[- ]class/i,
  /\bleverage\b/i,
  /\bsynerg/i,
  /game[- ]changer/i,
  /\bstunning\b/i,
];
// Niente statistiche né fonti inventate nell'intro.
const NO_STATS = [
  /\d+([.,]\d+)?\s?%/,
  /\bper ?cento\b/i,
  /\bpercent\b/i,
  /\b(studi|ricerche|sondaggi)\b.{0,20}\b(dimostrano|mostrano|indicano|dicono|rivelano)\b/i,
  /\bsecondo (uno studio|una ricerca|un sondaggio|i dati)\b/i,
  /\b(studies|research|surveys?)\b.{0,20}\b(show|shows|suggest|suggests|found|reveal)\b/i,
  /\baccording to\b/i,
];
// Inglese britannico: segnala le grafie americane più comuni.
const US_SPELLING = [
  /\bcolor(s|ed|ful|ing)?\b/i,
  /\bfavor(ite|s)?\b/i,
  /\bcenter(s|ed)?\b/i,
  /\bgray\b/i,
  /\b(organiz|personaliz|customiz|optimiz|realiz|recogniz|prioritiz|minimiz|apologiz)/i,
  /\bjewelry\b/i,
  /\btires?\b/i,
  /\bcheckup\b/i,
  /\bcatalog\b/i,
];

function hits(text, patterns) {
  const out = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) out.push(m[0]);
  }
  return out;
}

function flatCopy(copy) {
  if (!copy) return '';
  return [
    ...COPY_FIELDS.map((f) => copy[f]),
    ...(copy.cards ?? []).flatMap((c) => [c.title, c.description, c.meta]),
    copy.banner,
  ].join(' \n ');
}

function voiceLint(sector) {
  const out = [];
  const itAll = `${flatCopy(sector.copy?.it)}\n${sector.intro?.it ?? ''}`;
  const enAll = `${flatCopy(sector.copy?.en)}\n${sector.intro?.en ?? ''}`;
  for (const h of hits(itAll, BANNED_IT)) out.push(`it: "${h}"`);
  for (const h of hits(sector.intro?.it ?? '', BANNED_IT_INTRO)) out.push(`intro it: "${h}"`);
  for (const h of hits(enAll, BANNED_EN)) out.push(`en: "${h}"`);
  for (const h of hits(`${sector.intro?.it ?? ''}\n${sector.intro?.en ?? ''}`, NO_STATS)) out.push(`statistica/fonte: "${h}"`);
  for (const h of hits(enAll, US_SPELLING)) out.push(`grafia US: "${h}"`);
  if (/\[[^\]]*\]|lorem|ipsum|\bTODO\b/i.test(`${itAll}\n${enAll}`)) out.push('segnaposto nel testo');
  return out;
}

// ─── Validazione della forma ──────────────────────────────────────
const ALIAS_RE = /^[a-z0-9&]{2,24}$/;
const QUERY_RE = /^[a-z0-9 '&-]{3,60}$/i;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const words = (s) => s.split(/\s+/).filter(Boolean).length;

function validateCopy(copy, loc, errs) {
  if (!copy || typeof copy !== 'object') {
    errs.push(`copy.${loc} mancante`);
    return;
  }
  for (const f of [...COPY_FIELDS, 'banner']) {
    if (!isStr(copy[f])) errs.push(`copy.${loc}.${f} vuoto`);
    else if (copy[f].length > LIMITS[f]) errs.push(`copy.${loc}.${f} > ${LIMITS[f]} caratteri`);
  }
  if (!Array.isArray(copy.cards) || copy.cards.length !== 3) {
    errs.push(`copy.${loc}.cards non sono 3`);
    return;
  }
  copy.cards.forEach((c, i) => {
    for (const f of ['title', 'description', 'meta']) {
      if (!isStr(c?.[f])) errs.push(`copy.${loc}.cards[${i}].${f} vuoto`);
      else if (c[f].length > LIMITS[f]) errs.push(`copy.${loc}.cards[${i}].${f} > ${LIMITS[f]} caratteri`);
    }
  });
}

function validateSector(s, slug) {
  const errs = [];
  if (!s || typeof s !== 'object') return ['non è un oggetto'];
  if (slug && s.slug !== slug) errs.push(`slug "${s.slug}" diverso da "${slug}"`);
  if (!Object.hasOwn(PRESETS, s.preset)) errs.push(`preset "${s.preset}" non valido`);
  if (!Array.isArray(s.queriesEn) || s.queriesEn.length !== 3) errs.push('queriesEn non sono 3');
  else
    s.queriesEn.forEach((q, i) => {
      if (!isStr(q) || !QUERY_RE.test(q)) errs.push(`queriesEn[${i}] non valida`);
    });
  for (const loc of ['it', 'en']) {
    const list = s.aliases?.[loc];
    if (!Array.isArray(list) || list.length < 2 || list.length > 10) errs.push(`aliases.${loc}: servono 2-10 radici`);
    else {
      const bad = list.filter((a) => typeof a !== 'string' || !ALIAS_RE.test(a));
      if (bad.length) errs.push(`aliases.${loc} non normalizzate: ${bad.join(', ')}`);
      if (new Set(list).size !== list.length) errs.push(`aliases.${loc} duplicate`);
    }
    validateCopy(s.copy?.[loc], loc, errs);
    const intro = s.intro?.[loc];
    if (!isStr(intro)) errs.push(`intro.${loc} vuota`);
    else {
      const paras = intro.split(/\n\s*\n/).filter((p) => p.trim());
      if (paras.length < 2 || paras.length > 3) errs.push(`intro.${loc}: ${paras.length} paragrafi (servono 2-3)`);
      const n = words(intro);
      if (n < INTRO_WORDS.min || n > INTRO_WORDS.max) errs.push(`intro.${loc}: ${n} parole (${INTRO_WORDS.min}-${INTRO_WORDS.max})`);
    }
  }
  if (typeof s.reviewed !== 'boolean') errs.push('reviewed non booleano');
  return errs;
}

/** Radici condivise con altri settori (il matching del testo libero diventa ambiguo). */
function aliasCollisions(sectors) {
  const owners = new Map();
  for (const s of sectors) {
    for (const loc of ['it', 'en']) {
      for (const a of s.aliases?.[loc] ?? []) {
        const key = `${loc}:${a}`;
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(s.slug);
      }
    }
  }
  const out = new Map();
  for (const [key, slugs] of owners) {
    if (slugs.size < 2) continue;
    for (const slug of slugs) {
      if (!out.has(slug)) out.set(slug, []);
      out.get(slug).push(`${key} (anche ${[...slugs].filter((x) => x !== slug).join(', ')})`);
    }
  }
  return out;
}

// ─── Forma canonica ───────────────────────────────────────────────
function canonicalCopy(c) {
  return {
    name: c.name,
    nav: c.nav,
    eyebrow: c.eyebrow,
    h1: c.h1,
    lead: c.lead,
    btn1: c.btn1,
    btn2: c.btn2,
    cards: c.cards.map((k) => ({ title: k.title, description: k.description, meta: k.meta })),
    banner: c.banner,
  };
}

function canonical(s) {
  return {
    slug: s.slug,
    preset: s.preset,
    queriesEn: [...s.queriesEn],
    aliases: { it: [...s.aliases.it], en: [...s.aliases.en] },
    copy: { it: canonicalCopy(s.copy.it), en: canonicalCopy(s.copy.en) },
    intro: { it: s.intro.it.trim(), en: s.intro.en.trim() },
    reviewed: s.reviewed === true,
  };
}

// ─── Dati di contesto (letti dai sorgenti TS) ─────────────────────
async function loadProfessions() {
  const src = await readFile(resolve(DATA_DIR, 'seo-professions.ts'), 'utf8');
  const start = src.indexOf('export const SEO_PROFESSIONS');
  const end = src.indexOf('];', start);
  if (start === -1 || end === -1) throw new Error('SEO_PROFESSIONS non trovato in seo-professions.ts');
  const re = /\{\s*slug:\s*'([a-z0-9-]+)',\s*label:\s*'((?:[^'\\]|\\.)*)',\s*categoryId:\s*'([a-z-]+)',\s*tier:\s*([123])\s*\}/g;
  const list = [...src.slice(start, end).matchAll(re)].map((m) => ({
    slug: m[1],
    label: m[2].replace(/\\'/g, "'"),
    categoryId: m[3],
    tier: Number(m[4]),
  }));
  if (list.length < 100) throw new Error(`seo-professions.ts: lette solo ${list.length} professioni, formato cambiato?`);
  for (const p of list) {
    if (!CATEGORIES[p.categoryId]) throw new Error(`categoria sconosciuta "${p.categoryId}" per ${p.slug}`);
  }
  return list;
}

async function loadLabelsEn() {
  const src = await readFile(resolve(DATA_DIR, 'seo-professions-labels-en.ts'), 'utf8');
  const re = /^\s*(?:'([a-z0-9-]+)'|([a-z0-9]+)):\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3,?\s*$/gm;
  const out = {};
  for (const m of src.matchAll(re)) out[m[1] ?? m[2]] = m[4].replace(/\\(['"])/g, '$1');
  return out;
}

const constName = (catId) => `${catId.toUpperCase().replace(/-/g, '_')}_SECTORS`;
const categoryFile = (catId) => resolve(OUT_DIR, `${catId}.ts`);

/** Legge un file di categoria (anche modificato a mano) passando dal compilatore TS. */
async function loadCategory(catId) {
  const file = categoryFile(catId);
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  let mod;
  try {
    mod = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  } catch (e) {
    throw new Error(`${catId}.ts non leggibile (solo import type ammessi in sectors/): ${e.message}`);
  }
  const list = mod[constName(catId)];
  if (!Array.isArray(list)) throw new Error(`${catId}.ts: manca l'export ${constName(catId)}`);
  return list;
}

function renderCategory(catId, sectors) {
  const cat = CATEGORIES[catId];
  return `// Generato da scripts/generate-palette-sectors.mjs, poi rivisto a mano.
// Categoria: ${cat.it} (${catId}).
// Le voci con "reviewed": true il generatore non le riscrive mai. Si può
// modificare a mano; \`--format\` riporta il file alla forma canonica.

import type { PaletteSectorContent } from '../types';

export const ${constName(catId)}: PaletteSectorContent[] = ${JSON.stringify(sectors, null, 2)};
`;
}

/** Scrive il file solo se cambia. Ritorna true se ha scritto. */
async function writeCategory(catId, sectors) {
  const file = categoryFile(catId);
  const next = renderCategory(catId, sectors);
  // Il checkout su Windows può avere CRLF: si confronta il contenuto, non i fine riga.
  const prev = await readFile(file, 'utf8').catch(() => null);
  if (prev?.replace(/\r\n/g, '\n') === next) return false;
  await writeFile(file, next, 'utf8');
  return true;
}

function sortByProfession(sectors, order) {
  return [...sectors].sort((a, b) => (order.get(a.slug) ?? 1e9) - (order.get(b.slug) ?? 1e9));
}

// ─── Brief ────────────────────────────────────────────────────────
function buildPrompt(prof, labelEn, example, siblings, takenAliases) {
  const cat = CATEGORIES[prof.categoryId];
  const presets = Object.entries(PRESETS)
    .map(([k, d]) => `  - ${k}: ${d}`)
    .join('\n');
  const exampleJson = JSON.stringify({ ...example, reviewed: undefined }, null, 2);

  return `TASK: genera UN oggetto JSON con i testi del settore "${prof.label}" (slug ${prof.slug}, EN "${labelEn}") per lo strumento gratuito "Palette di settore" di un web designer freelance italiano. Restituisci SOLO il JSON, niente prefazioni, niente markdown, niente spiegazioni. Inizia con \`{\` e finisci con \`}\`.

COS'È LO STRUMENTO: chi ha un'attività scrive il suo settore; lo strumento estrae i colori dominanti da foto Unsplash del settore e mostra l'anteprima della home page di un'attività inventata, più biglietto da visita, insegna e post. "copy" sono i testi di quell'anteprima (parla l'attività ai suoi clienti). "intro" è l'introduzione della pagina del settore (parla il web designer al titolare): come scegliere i colori per QUESTO settore.

CATEGORIA: ${cat.it} — ${cat.description}
ALTRE PROFESSIONI DELLA CATEGORIA (hanno una pagina loro, non invadere il loro campo): ${siblings.join(', ')}

VOCE (vale per tutti i testi, IT ed EN):
- tu diretto, frasi brevi, concreto. Niente iperboli, superlativi, punti esclamativi, gergo da agenzia.
- VIETATE: "soluzioni", "valore aggiunto", "esperienza utente", "leadership", "passione", "dedizione", "sinergia", "eccellenza", "a 360 gradi", "il migliore", "straordinario", "incredibile". EN: "solutions", "value-added", "cutting-edge", "seamless", "elevate", "unlock", "passion", "excellence", "world-class", "best-in-class", "leverage", "stunning".
- Niente statistiche, percentuali, studi, sondaggi o fonti ("secondo una ricerca", "studies show"): non inventarne. Niente nomi di aziende o marchi reali.
- EN in inglese britannico (colour, favourite, centre, organise, personalised, programme, tyre, jewellery), scritto in modo naturale, non tradotto parola per parola.

CAMPI:
- preset: uno fra
${presets}
- queriesEn: 3 ricerche Unsplash in inglese, 2-5 parole, concrete e visive (luoghi, oggetti, materiali, luce tipici del settore). Niente parole astratte ("success", "professional", "business").
- aliases.it / aliases.en: 3-8 radici per riconoscere il settore nel testo libero del visitatore. Una parola sola ciascuna, minuscolo, senza accenti né spazi (solo a-z, 0-9, &). Una parola del visitatore combacia se è uguale alla radice o, con radici di 4+ caratteri, se inizia con essa: evita radici che siano l'inizio di parole di altri settori (es. "foto" prende anche "fotovoltaico"). Solo radici di QUESTA professione.${takenAliases.length ? `\n  Radici già usate da altri settori, da non ripetere: ${takenAliases.join(', ')}` : ''}
- copy.it / copy.en: attività inventata ma plausibile in Italia, senza nominare città o quartieri reali (l'anteprima la vede chiunque); orari, numeri e prezzi realistici. Prezzi IT "7,50 €", "Da 45 €"; EN "€7.50", "From €45". Orari IT "19:00"; EN "7pm", "11.30pm". Il nome dell'attività può restare uguale o adattarsi in EN.
  Lunghezze massime: name ${LIMITS.name}, nav ${LIMITS.nav} (voce del bottone in navigazione), eyebrow ${LIMITS.eyebrow}, h1 ${LIMITS.h1}, lead ${LIMITS.lead}, btn1/btn2 ${LIMITS.btn1}, cards[].title ${LIMITS.title}, cards[].description ${LIMITS.description}, cards[].meta ${LIMITS.meta} (prezzo, orario o nota breve), banner ${LIMITS.banner}. Esattamente 3 cards.
- intro.it / intro.en: 2-3 paragrafi separati da una riga vuota ("\\n\\n"), ${INTRO_WORDS.min}-${INTRO_WORDS.max} parole per lingua. Cosa cerca il cliente di questo settore, quali toni funzionano e perché, cosa evitare, dove finiscono i colori fuori dallo schermo (insegna, stampa, divise, packaging...), un consiglio pratico sul contrasto. Niente prezzi, niente "preventivo".

ESEMPIO di un altro settore già scritto (per tono, forma e lunghezze; non copiarne le frasi):
${exampleJson}

OUTPUT: un singolo oggetto JSON con esattamente queste chiavi: "slug" ("${prof.slug}"), "preset", "queriesEn", "aliases" {it, en}, "copy" {it, en}, "intro" {it, en}. Preserva gli accenti italiani (è, é, à, ò, ù, ì).`;
}

// ─── Codex ────────────────────────────────────────────────────────
/** Primo oggetto JSON valido nell'output del companion (che stampa anche righe di log). */
function extractJson(stdout) {
  const end = stdout.lastIndexOf('}');
  if (end === -1) throw new Error('nessuna graffa nell\'output');
  for (let i = stdout.indexOf('{'); i !== -1 && i < end; i = stdout.indexOf('{', i + 1)) {
    try {
      const obj = JSON.parse(stdout.slice(i, end + 1));
      if (obj && typeof obj === 'object' && obj.copy) return obj;
    } catch {
      // prova dalla graffa successiva
    }
  }
  throw new Error('nessun JSON valido nell\'output');
}

async function runCodex(prompt) {
  const dir = await mkdtemp(join(tmpdir(), 'palette-sector-'));
  const promptFile = join(dir, 'prompt.txt');
  await writeFile(promptFile, prompt, 'utf8');
  try {
    return await new Promise((resolveProm, rejectProm) => {
      const child = spawn('node', [COMPANION, 'task', '--cwd', ROOT, '--prompt-file', promptFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        rejectProm(new Error('Codex timeout (300s)'));
      }, 300_000);
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) rejectProm(new Error(`Codex exit ${code}: ${stderr.slice(0, 500)}`));
        else resolveProm(stdout);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function generateSector(job) {
  const { prof, prompt } = job;
  const tag = `${prof.categoryId}/${prof.slug}`;

  if (DRY_RUN) {
    console.log(`[dry] ${tag} — brief ${prompt.length} caratteri`);
    return { prof, ok: true, content: null };
  }

  console.log(`[run] ${tag} — invio a codex…`);
  const t0 = Date.now();
  let content;
  try {
    const raw = extractJson(await runCodex(prompt));
    const candidate = { ...raw, slug: raw.slug ?? prof.slug, reviewed: false };
    const errs = validateSector(candidate, prof.slug);
    if (errs.length) throw new Error(`forma: ${errs.join('; ')}`);
    content = canonical(candidate);
  } catch (e) {
    console.error(`[FAIL] ${tag} — ${e.message}`);
    return { prof, ok: false, error: e.message };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const lintHits = voiceLint(content);
  if (lintHits.length) console.warn(`[warn] ${tag} — linter: ${lintHits.join(', ')} (tenuto comunque)`);
  console.log(`[ok]   ${tag} — ${elapsed}s, lint:${lintHits.length}`);
  return { prof, ok: true, content, lintHits };
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
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, runSlot));
  return results;
}

// ─── Modalità senza codex ─────────────────────────────────────────
function lintAll(byCategory, order) {
  const all = Object.values(byCategory).flat();
  const collisions = aliasCollisions(all);
  let errors = 0;
  for (const s of all) {
    const errs = validateSector(s, null);
    if (!order.has(s.slug)) errs.push('slug non presente in seo-professions.ts');
    const warns = [...voiceLint(s), ...(collisions.get(s.slug) ?? []).map((c) => `radice condivisa ${c}`)];
    if (errs.length) {
      errors++;
      console.error(`[FAIL] ${s.slug} — ${errs.join('; ')}`);
    }
    if (warns.length) console.warn(`[warn] ${s.slug} — ${warns.join(', ')}`);
    if (!errs.length && !warns.length) console.log(`[ok]   ${s.slug}${s.reviewed ? ' (rivisto)' : ''}`);
  }
  console.log(`\n${all.length} settori, ${errors} con errori di forma.`);
  if (errors) process.exitCode = 1;
}

async function formatAll(byCategory, order) {
  for (const [catId, list] of Object.entries(byCategory)) {
    const wrote = await writeCategory(catId, sortByProfession(list.map(canonical), order));
    console.log(`${wrote ? '[wrote]' : '[same] '} ${catId}.ts (${list.length})`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  if (ONLY_CATEGORY && !CATEGORIES[ONLY_CATEGORY]) throw new Error(`categoria sconosciuta: ${ONLY_CATEGORY}`);

  const professions = await loadProfessions();
  const labelsEn = await loadLabelsEn();
  const order = new Map(professions.map((p, i) => [p.slug, i]));
  const bySlug = new Map(professions.map((p) => [p.slug, p]));
  for (const slug of ONLY_SLUGS) {
    if (!bySlug.has(slug)) throw new Error(`slug sconosciuto: ${slug}`);
  }

  const byCategory = {};
  for (const catId of Object.keys(CATEGORIES)) byCategory[catId] = await loadCategory(catId);

  if (LINT_ONLY) return lintAll(byCategory, order);
  if (FORMAT_ONLY) return formatAll(byCategory, order);

  // Piano: cosa generare e cosa saltare.
  const existing = new Map(Object.values(byCategory).flat().map((s) => [s.slug, s]));
  const targets = [];
  for (const prof of professions) {
    if (ONLY_CATEGORY && prof.categoryId !== ONLY_CATEGORY) continue;
    if (ONLY_SLUGS.length && !ONLY_SLUGS.includes(prof.slug)) continue;
    const cur = existing.get(prof.slug);
    if (cur?.reviewed === true) {
      console.log(`[skip] ${prof.slug} — rivisto, non lo tocco`);
      continue;
    }
    if (cur && !FORCE) {
      console.log(`[skip] ${prof.slug} — già presente (--force per rigenerarlo)`);
      continue;
    }
    targets.push(prof);
  }

  const allSectors = [...existing.values()];
  const jobs = targets.map((prof) => {
    const sameCat = byCategory[prof.categoryId].filter((s) => s.slug !== prof.slug);
    const example = sameCat.find((s) => s.reviewed) ?? sameCat[0] ?? allSectors.find((s) => s.slug !== prof.slug);
    if (!example) throw new Error('serve almeno un settore già scritto da usare come esempio');
    const siblings = professions
      .filter((p) => p.categoryId === prof.categoryId && p.slug !== prof.slug)
      .map((p) => p.label);
    const taken = [
      ...new Set(
        allSectors
          .filter((s) => s.slug !== prof.slug)
          .flatMap((s) => [...(s.aliases?.it ?? []), ...(s.aliases?.en ?? [])]),
      ),
    ].sort();
    const labelEn = labelsEn[prof.slug] ?? prof.label;
    return { prof, prompt: buildPrompt(prof, labelEn, example, siblings, taken) };
  });

  console.log(`Plan: ${jobs.length} settori, concurrency=${CONCURRENCY}, dryRun=${DRY_RUN}, force=${FORCE}`);
  if (DRY_RUN && jobs.length === 1) console.log(`\n--- brief ${jobs[0].prof.slug} ---\n${jobs[0].prompt}\n--- fine brief ---\n`);
  if (!jobs.length) return;

  const t0 = Date.now();
  const results = await pool(jobs, generateSector, CONCURRENCY);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!DRY_RUN) {
    // Rilegge i file subito prima di scrivere: una revisione fatta durante il run vince.
    const generated = results.filter((r) => r.ok && r.content);
    const touched = new Set(generated.map((r) => r.prof.categoryId));
    for (const catId of touched) {
      const fresh = await loadCategory(catId);
      const merged = new Map(fresh.map((s) => [s.slug, s]));
      for (const r of generated.filter((x) => x.prof.categoryId === catId)) {
        if (merged.get(r.prof.slug)?.reviewed === true) {
          console.warn(`[skip] ${r.prof.slug} — rivisto durante il run, non lo sovrascrivo`);
          continue;
        }
        merged.set(r.prof.slug, r.content);
      }
      const list = sortByProfession([...merged.values()].map(canonical), order);
      if (await writeCategory(catId, list)) console.log(`[wrote] ${categoryFile(catId)}`);
    }

    const collisions = aliasCollisions([...existing.values(), ...generated.map((r) => r.content)]);
    for (const r of generated) {
      const c = collisions.get(r.prof.slug);
      if (c) console.warn(`[warn] ${r.prof.slug} — radici condivise: ${c.join(', ')}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Summary ===`);
  console.log(`Settori: ${jobs.length}  |  OK: ${okCount}  |  FAIL: ${failed.length}`);
  console.log(`Wall time: ${elapsed}s`);
  if (failed.length) {
    console.log(`\nFalliti:`);
    for (const r of failed) console.log(`  - ${r.prof.slug}: ${r.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
