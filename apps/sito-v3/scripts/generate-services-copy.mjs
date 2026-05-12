#!/usr/bin/env node
/**
 * Genera 8 entry ServiceDetail per le pagine `/servizi/[slug]`:
 *
 *   Matrix (4 update):  web-design, e-commerce, sviluppo-web, seo
 *   Standalone (4):     branding, manutenzione-siti (NEW),
 *                       assistenza-wordpress (NEW), wordpress-migrazione (NEW)
 *
 * Output: 1 file per servizio in src/data/services-content/<slug>.ts.
 * Il barrel `services-detail.ts` verrà aggiornato manualmente per importarli.
 *
 * Concorrenza: 4 chiamate parallele (default).
 *
 * Usage:
 *   node scripts/generate-services-copy.mjs                    # tutti gli 8
 *   node scripts/generate-services-copy.mjs --only web-design  # singolo
 *   DRY_RUN=1 node scripts/generate-services-copy.mjs          # log brief
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'src/data/services-content');
const COMPANION = 'C:/Users/calicchiadesign/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? '4');
const DRY_RUN = process.env.DRY_RUN === '1';

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

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
  /\bpreventivo\b/i,
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

// ─── 8 SERVIZI ─────────────────────────────────────────────────────
const SERVICES = [
  {
    slug: 'web-design',
    title: 'Web Design',
    icon: 'ph-globe',
    isMatrix: true,
    scope: 'Realizzazione siti web vetrina, istituzionali, portfolio. WordPress o sviluppo custom (Astro, Next.js). SEO tecnica base, GDPR, Google Business, Search Console. Un anno di assistenza inclusa.',
    deliverables: [
      'Design su misura (no template)',
      'Sviluppo responsive mobile-first',
      'SEO tecnica base (sitemap, robots, schema)',
      'Privacy/cookie GDPR',
      'Setup Google Analytics + Search Console',
      'Un anno di assistenza tecnica',
    ],
    pains: [
      'Sito vecchio fatto anni fa che non porta nemmeno un contatto',
      'Template generico identico al concorrente',
      'Agenzia che ti ha mollato dopo il lancio, nessuno risponde più',
    ],
    keywords: ['Web Design', 'UX/UI', 'Responsive', 'SEO tecnica', 'Performance', 'Accessibilità'],
  },
  {
    slug: 'e-commerce',
    title: 'E-Commerce',
    icon: 'ph-shopping-cart',
    isMatrix: true,
    scope: 'Negozi online (WooCommerce o headless). Catalogo, varianti, gateway pagamento (Stripe/PayPal/bonifico/contrassegno), spedizioni configurate, email transazionali, recovery carrello.',
    deliverables: [
      'WooCommerce / piattaforma scelta sul caso',
      'Catalogo prodotti + varianti + magazzino',
      'Gateway pagamento configurati',
      'Spedizioni multi-corriere',
      'Email transazionali + recovery carrello',
      'Schema Product / Offer per Google Shopping',
    ],
    pains: [
      'Negozio fisico aperto 8 ore vs concorrenti online aperti 24/7',
      'Marketplace generici (Amazon) prendono i tuoi clienti per assenza',
      'Vendi solo a chi entra dalla porta — mercato limitato dal raggio fisico',
    ],
    keywords: ['E-Commerce', 'WooCommerce', 'Pagamenti', 'Catalogo', 'Checkout', 'Conversioni'],
  },
  {
    slug: 'sviluppo-web',
    title: 'Sviluppo Web',
    icon: 'ph-code',
    isMatrix: true,
    scope: 'Web app custom, gestionali, dashboard, area clienti, integrazioni CRM/ERP/API, automazioni, chatbot AI. Codice pulito, scalabile, performance da SaaS moderno.',
    deliverables: [
      'Applicazioni web custom su misura',
      'API REST/GraphQL + integrazioni terze parti',
      'Aree riservate con login/ruoli/permessi',
      'Dashboard operative con dati real-time',
      'Automazioni e chatbot AI',
      'Architettura scalabile (Next.js, Node, Postgres)',
    ],
    pains: [
      'Processi gestiti tra Excel, email e WhatsApp — impossibile scalare',
      'Pagamenti software-as-a-service generici (Calendly + Mailchimp + …) costano caro e non parlano tra loro',
      'Cliente chiama per stato pratiche/ordini invece di vederli in dashboard',
    ],
    keywords: ['Web App', 'Dashboard', 'API', 'Integrazioni', 'Automazioni', 'Custom'],
  },
  {
    slug: 'seo',
    title: 'SEO & Visibilità',
    icon: 'ph-magnifying-glass',
    isMatrix: true,
    scope: 'SEO tecnica + content + local. Audit Core Web Vitals, crawlability, indexing, schema markup, content plan settoriale, Google Business profile, citation, recensioni, monitoring mensile (rank tracking, GSC, GA4).',
    deliverables: [
      'Audit tecnico completo (CWV, crawl, index)',
      'Strategia keyword + content plan settoriale',
      'SEO locale (Google Business, citation NAP)',
      'Ottimizzazione on-page + schema markup',
      'Link building white-hat',
      'Monitoring mensile + report leggibili',
    ],
    pains: [
      'Sito esiste ma non porta una visita organica al mese',
      'Agenzia SEO che promette "prima pagina garantita" e fattura ogni mese senza dimostrare',
      'Google Business ignorato, recensioni ferme, NAP incoerente tra directory',
    ],
    keywords: ['SEO', 'Local SEO', 'Core Web Vitals', 'Schema Markup', 'Link Building', 'Search Console'],
  },
  {
    slug: 'branding',
    title: 'Branding',
    icon: 'ph-palette',
    isMatrix: false,
    scope: 'Brand identity completa: naming, positioning, logo, sistema visivo (palette, type, layout grid), tone of voice, brand book. Restyling logo o brand identity da zero.',
    deliverables: [
      'Naming & positioning',
      'Logo + sistema visivo coordinato',
      'Palette colore + scala tipografica',
      'Tono di voce + linee editoriali',
      'Brand book PDF (manuale d\'uso)',
      'Asset esportati (vettoriali + raster)',
    ],
    pains: [
      'Logo amatoriale fatto su Word/Canva da chi non ha competenza',
      'Palette e font che cambiano tra sito, social, firma email e template',
      'Brand percepito come "uno dei tanti" perché manca un sistema visivo coerente',
    ],
    keywords: ['Brand Identity', 'Logo Design', 'Sistema Visivo', 'Tono di Voce', 'Brand Book', 'Restyling'],
  },
  {
    slug: 'manutenzione-siti',
    title: 'Manutenzione siti',
    icon: 'ph-wrench',
    isMatrix: false,
    scope: 'Canone mensile/annuale per la gestione tecnica del sito: backup automatici, monitoring uptime, update CMS/plugin/dipendenze, fix urgenti entro 24h, security patch, rinnovi dominio/SSL.',
    deliverables: [
      'Backup automatici giornalieri + ripristino on-demand',
      'Monitoring uptime 24/7 con alert',
      'Update CMS, plugin, dipendenze',
      'Fix urgenti entro 24h lavorative',
      'Security patch + WAF base',
      'Report mensile leggibile',
    ],
    pains: [
      'Sito offline scoperto solo dai clienti che chiamano arrabbiati',
      'Plugin WordPress non aggiornati con vulnerabilità note',
      'Nessuno risponde quando il sito si rompe e bisogna ripristinare backup',
    ],
    keywords: ['Manutenzione', 'Backup', 'Monitoring', 'Update', 'Security', 'Uptime'],
  },
  {
    slug: 'assistenza-wordpress',
    title: 'Assistenza WordPress',
    icon: 'ph-shield-check',
    isMatrix: false,
    scope: 'Interventi specifici su WordPress: pulizia malware/recovery, security hardening (firewall, 2FA, hardening file system), risoluzione conflitti plugin, performance tuning (cache, query optimization, database cleanup), audit di sicurezza.',
    deliverables: [
      'Pulizia malware + ripristino completo',
      'Security hardening (firewall, 2FA, file permissions)',
      'Risoluzione conflitti plugin/temi',
      'Performance tuning (cache, query, DB)',
      'Audit di sicurezza con report',
      'Migrazione SSL/HTTPS',
    ],
    pains: [
      'Sito hackerato che mostra contenuti sospetti o redirect malevoli',
      'Plugin in conflitto che fanno crashare l\'admin o il front-end',
      'WordPress lento (TTFB > 3s, page load > 5s) per query non ottimizzate',
    ],
    keywords: ['WordPress', 'Security', 'Malware', 'Performance', 'Plugin', 'Hardening'],
  },
  {
    slug: 'wordpress-migrazione',
    title: 'Migrazione & Hosting WordPress',
    icon: 'ph-cloud-arrow-up',
    isMatrix: false,
    scope: 'Migrazione WordPress senza downtime, setup nuovo hosting performante (WP Engine, SiteGround, hosting tuned), cambio DNS e certificati SSL, configurazione CDN e cache, ottimizzazione post-migrazione.',
    deliverables: [
      'Migrazione zero-downtime (con staging)',
      'Setup hosting tuned per WP',
      'CDN + cache configurati (Cloudflare, WP Rocket)',
      'Migrazione DNS + certificati SSL',
      'Test post-migrazione (link, redirect, speed)',
      'Documentazione hosting/credenziali',
    ],
    pains: [
      'Hosting condiviso lento che fa caricare il sito in 8-10 secondi',
      'Cambio host che ha rotto link, immagini o redirect — SEO bruciata',
      'Nessuno gestisce DNS/SSL e quando scadono il sito va offline',
    ],
    keywords: ['WordPress', 'Migrazione', 'Hosting', 'DNS', 'SSL', 'CDN'],
  },
];

function buildPrompt(svc) {
  return `TASK: genera UN blocco JSON con il content completo per la pagina /servizi/${svc.slug}. Restituisci SOLO il JSON, niente prefazioni, niente markdown, niente spiegazioni. Iniziando con \`{\` e finendo con \`}\`.

VOICE: copywriter B2B IT, voice freelance anti-agenzia, anti-marketing.
DIVIETO ASSOLUTO parole: "soluzioni", "valore aggiunto", "esperienza utente", "leadership", "passione", "dedizione", "cose che funzionano", "sinergia", "eccellenza", "preventivo", "tariffa", "a partire da".
TONO: aggressivo verso il PROBLEMA (catena di fornitori, agenzie a 6 mani, hosting condiviso, plugin random), MAI verso il lettore. Chiusure tipo "Punto.", "Fine della storia.", "Decidi tu."

SERVIZIO: ${svc.title}
SLUG: ${svc.slug}
SCOPE: ${svc.scope}

DELIVERABLES TIPICI:
${svc.deliverables.map((d) => `  - ${d}`).join('\n')}

PAIN POINTS NOTI:
${svc.pains.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

OUTPUT JSON (singolo oggetto, no array, no wrapper, no markdown fences):
{
  "title": "${svc.title}",
  "icon": "${svc.icon}",
  "description": "<descrizione breve 1-2 frasi, hook concreto, ≤140 caratteri>",
  "longDescription": "<descrizione lunga 80-150 parole, racconta il problema → l'approccio → cosa cambia. Concreto, voice-aligned.>",
  "features": [
    {"title":"<3-6 parole>","description":"<25-50 parole concrete>"},
    {"title":"<3-6 parole>","description":"<25-50 parole concrete>"},
    {"title":"<3-6 parole>","description":"<25-50 parole concrete>"},
    {"title":"<3-6 parole>","description":"<25-50 parole concrete>"},
    {"title":"<3-6 parole>","description":"<25-50 parole concrete>"},
    {"title":"<3-6 parole>","description":"<25-50 parole concrete>"}
  ],
  "benefits": [
    "<frase concreta 8-15 parole, beneficio cliente>",
    "<frase concreta 8-15 parole>",
    "<frase concreta 8-15 parole>",
    "<frase concreta 8-15 parole>",
    "<frase concreta 8-15 parole>"
  ],
  "process": [
    {"step":1,"title":"<2-3 parole>","description":"<20-40 parole>"},
    {"step":2,"title":"<2-3 parole>","description":"<20-40 parole>"},
    {"step":3,"title":"<2-3 parole>","description":"<20-40 parole>"},
    {"step":4,"title":"<2-3 parole>","description":"<20-40 parole>"},
    {"step":5,"title":"<2-3 parole>","description":"<20-40 parole>"}
  ],
  "faqs": [
    {"question":"<domanda reale>","answer":"<40-80 parole, mai vendere, mai prezzi numerici, sempre risposta utile>"},
    {"question":"<domanda reale>","answer":"<40-80 parole>"},
    {"question":"<domanda reale>","answer":"<40-80 parole>"},
    {"question":"<domanda reale>","answer":"<40-80 parole>"},
    {"question":"<domanda reale>","answer":"<40-80 parole>"},
    {"question":"<domanda reale>","answer":"<40-80 parole>"}
  ],
  "awareness": {
    "title": "<headline 6-12 parole, settoriale>",
    "subtitle": "<sottotitolo 12-25 parole>",
    "problems": [
      {"icon":"ph-XXX","title":"<3-5 parole>","desc":"<25-50 parole>"},
      {"icon":"ph-XXX","title":"<3-5 parole>","desc":"<25-50 parole>"},
      {"icon":"ph-XXX","title":"<3-5 parole>","desc":"<25-50 parole>"}
    ]
  },
  "marqueeKeywords": ${JSON.stringify(svc.keywords)},
  "expandedScope": {
    "eyebrow": "<2-3 parole maiuscole>",
    "title": "<headline 6-12 parole>",
    "body": "<paragrafo 100-180 parole sul post-launch / scope esteso / cosa succede dopo. Voice aggressiva sui passaggi di mano e fornitori.>"
  }
}

VINCOLI:
- icon Phosphor: ph-globe, ph-shopping-cart, ph-code, ph-magnifying-glass, ph-palette, ph-wrench, ph-shield-check, ph-cloud-arrow-up, ph-prohibit, ph-warning-circle, ph-clock, ph-chart-line-down, ph-instagram-logo, ph-camera, ph-storefront, ph-database, ph-gear, ph-lock, ph-credit-card, ph-truck.
- Niente prezzi, niente €, niente "a partire da", niente "preventivo" come hook commerciale.
- I faq.answer NON devono mai parlare di prezzi/preventivi numerici.
- Tutti i testi voice-aligned (anti-agenzia, anti-marketing, "Punto.", "Fine della storia.").
- expandedScope.body deve essere SETTORIALE al servizio, non generico.
- Preserva accenti italiani correttamente (è, é, à, ò, ù, ’).`;
}

function extractJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON braces');
  }
  const slice = stdout.slice(start, end + 1);
  return JSON.parse(slice);
}

function validateShape(obj, svc) {
  const errs = [];
  if (typeof obj.title !== 'string') errs.push('title missing');
  if (typeof obj.icon !== 'string') errs.push('icon missing');
  if (typeof obj.description !== 'string' || obj.description.length < 20) errs.push('description short');
  if (typeof obj.longDescription !== 'string' || obj.longDescription.length < 100) errs.push('longDescription short');
  if (!Array.isArray(obj.features) || obj.features.length < 5) errs.push('features < 5');
  if (!Array.isArray(obj.benefits) || obj.benefits.length < 4) errs.push('benefits < 4');
  if (!Array.isArray(obj.process) || obj.process.length < 4) errs.push('process < 4');
  if (!Array.isArray(obj.faqs) || obj.faqs.length < 5) errs.push('faqs < 5');
  if (!obj.awareness || !Array.isArray(obj.awareness.problems) || obj.awareness.problems.length !== 3) errs.push('awareness.problems != 3');
  if (!Array.isArray(obj.marqueeKeywords)) errs.push('marqueeKeywords missing');
  if (!obj.expandedScope || typeof obj.expandedScope.body !== 'string') errs.push('expandedScope.body missing');
  return errs;
}

function runCodex(prompt) {
  return new Promise((res, rej) => {
    const child = spawn('node', [COMPANION, 'task', prompt], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGTERM'); rej(new Error('Codex timeout')); }, 360_000);
    child.on('close', (c) => {
      clearTimeout(t);
      if (c !== 0) rej(new Error(`Codex exit ${c}: ${stderr.slice(0, 500)}`));
      else res(stdout);
    });
  });
}

async function generateService(svc) {
  const prompt = buildPrompt(svc);
  const tag = svc.slug;

  if (DRY_RUN) {
    console.log(`[dry] ${tag} — prompt ${prompt.length} chars`);
    return { svc, content: null, ok: true };
  }

  console.log(`[run] ${tag} — sending to codex…`);
  const t0 = Date.now();
  let stdout;
  try {
    stdout = await runCodex(prompt);
  } catch (e) {
    console.error(`[FAIL] ${tag} — ${e.message}`);
    return { svc, content: null, ok: false, error: e.message };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  let content;
  try { content = extractJson(stdout); }
  catch (e) {
    console.error(`[FAIL] ${tag} — JSON: ${e.message}`);
    return { svc, content: null, ok: false, error: e.message };
  }

  const shapeErrs = validateShape(content, svc);
  if (shapeErrs.length) {
    console.error(`[FAIL] ${tag} — shape: ${shapeErrs.join(', ')}`);
    return { svc, content: null, ok: false, error: shapeErrs.join('; ') };
  }

  const lintHits = voiceLint(JSON.stringify(content));
  if (lintHits.length) console.warn(`[warn] ${tag} — voice lint: ${lintHits.join(', ')}`);

  console.log(`[ok]   ${tag} — ${elapsed}s, lint:${lintHits.length}`);
  return { svc, content, ok: true, lintHits };
}

async function pool(items, worker, concurrency) {
  const results = [];
  let next = 0;
  async function slot() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, slot));
  return results;
}

async function writeServiceFile(svc, content) {
  const filepath = resolve(OUT_DIR, `${svc.slug}.ts`);
  // Add slug back into content (codex doesn't include it, we know it).
  const final = { slug: svc.slug, ...content };
  const constName = svc.slug.toUpperCase().replace(/-/g, '_') + '_SERVICE';
  const out = `// AUTO-GENERATED by scripts/generate-services-copy.mjs — refactor 2026-05.
// Do not edit by hand; regenerate via the script for full coherence.

import type { ServiceDetail } from '../services-detail';

export const ${constName}: ServiceDetail = ${JSON.stringify(final, null, 2)};
`;
  await writeFile(filepath, out, 'utf8');
  console.log(`[wrote] ${filepath}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const targets = SERVICES.filter((s) => !ONLY || s.slug === ONLY);
  console.log(`Plan: ${targets.length} services, concurrency=${CONCURRENCY}, dryRun=${DRY_RUN}`);

  const t0 = Date.now();
  const results = await pool(targets, generateService, CONCURRENCY);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  for (const r of results) {
    if (r && r.ok && r.content) await writeServiceFile(r.svc, r.content);
  }

  const okCount = results.filter((r) => r && r.ok).length;
  const failCount = results.filter((r) => r && !r.ok).length;
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${targets.length}`);
  console.log(`OK: ${okCount}  |  FAIL: ${failCount}`);
  console.log(`Wall time: ${elapsed}s`);
  if (failCount > 0) {
    console.log(`\nFailed:`);
    for (const r of results.filter((x) => x && !x.ok)) {
      console.log(`  - ${r.svc.slug}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
