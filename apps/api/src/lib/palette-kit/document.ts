/**
 * HTML del brand kit in PDF (5 pagine A4) per Chromium/Puppeteer.
 *
 *  1. Copertina: settore, stile, fasce colore.
 *  2. Colori e codici: HEX, RGB, CMYK indicativo, OKLCH.
 *  3. Ruoli e contrasti: ruoli derivati come nel tool (deriveRoles, autofix
 *     attivo) e tabella WCAG.
 *  4. Tipografia e home di esempio.
 *  5. Supporti: biglietto da visita, insegna, post social.
 *
 * Funzione pura: niente file né rete (i font arrivano già come CSS). I testi
 * delle anteprime sono generici: l'API non ha i testi dei settori del sito.
 */

import {
  contrast,
  contrastGrade,
  deriveRoles,
  FONT_FAMILIES,
  fontStack,
  hexToLab,
  hexToRgb,
  labToLch,
  normalizeHex,
  PRESETS,
  type ContrastGrade,
  type ContrastKind,
  type PaletteColor,
  type PaletteRoles,
  type SharedPalette,
} from '@calicchia/shared/palette';

export type KitLocale = 'it' | 'en';

export interface BrandKitInput {
  palette: SharedPalette;
  locale: KitLocale;
  /** Etichetta del settore come la mostra il sito, se la palette viene da un settore. */
  sectorLabel: string | null;
  /** Link "condividi" del tool con la stessa palette. */
  shareUrl: string;
  date: Date;
  /** @font-face già pronti (brandKitFontCss). */
  fontCss: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const COPY = {
  it: {
    lang: 'it',
    kit: 'Brand kit',
    tool: 'Palette di settore',
    titleFor: (sector: string) => `La palette per ${sector}`,
    titleGeneric: 'La tua palette',
    style: 'Stile',
    made: 'Creato il',
    openTool: 'Riapri la palette nel tool',
    colorsTitle: 'Colori e codici',
    colorsIntro: 'I colori della palette dal più chiaro al più scuro. Usa l’HEX per il web e i programmi di grafica, l’RGB per gli schermi.',
    cmykNote: 'Il CMYK è calcolato dai valori RGB: per la stampa chiedi sempre una prova colore alla tipografia.',
    primaryTag: 'Primario',
    rolesTitle: 'Ruoli e contrasti',
    rolesIntro: 'Come distribuire i colori su un sito: i neutri derivano dal colore più chiaro e dal più scuro, primario e accento dalla palette.',
    roles: {
      bg: ['Sfondo', 'Il fondo delle pagine.'],
      surface: ['Superficie', 'Card, moduli e riquadri.'],
      text: ['Testo', 'Titoli e paragrafi.'],
      muted: ['Testo secondario', 'Didascalie, date, note.'],
      border: ['Bordi', 'Linee e separatori.'],
      primary: ['Primario', 'Bottoni e azioni principali.'],
      accent: ['Accento', 'Link e dettagli da far notare.'],
    },
    fixPrimary: (from: string, to: string, ratio: string) =>
      `Il primario ${from} è stato corretto in ${to} per arrivare a ${ratio}:1 con il testo del bottone.`,
    fixAccent: (from: string, to: string, ratio: string) =>
      `Come testo l’accento ${from} diventa ${to} per arrivare a ${ratio}:1 sullo sfondo.`,
    contrastTitle: 'Contrasti (WCAG 2.2)',
    pair: 'Coppia',
    sample: 'Esempio',
    ratio: 'Rapporto',
    result: 'Esito',
    pairs: {
      textBg: 'Testo su sfondo',
      mutedBg: 'Testo secondario su sfondo',
      textSurface: 'Testo su superficie',
      onPrimary: 'Testo del bottone su primario',
      accentBg: 'Accento (testo) su sfondo',
    },
    grades: { AAA: 'AAA', AA: 'AA', 'large-only': 'Solo testo grande', 'ui-pass': 'OK per elementi grafici', fail: 'Non sufficiente' } as Record<ContrastGrade, string>,
    contrastNote: 'Testo normale: almeno 4,5:1 (AA), 7:1 per AAA. Testo grande ed elementi grafici: almeno 3:1.',
    typeTitle: 'Tipografia',
    typeIntro: (style: string) => `Lo stile ${style} abbina questi caratteri. Sono gratuiti su Google Fonts con licenza Open Font License.`,
    headingFont: 'Titoli',
    bodyFont: 'Testi',
    accentFont: 'Dettagli',
    specimenHeading: 'Un titolo che si legge da lontano',
    specimenBody: 'Il testo dei paragrafi deve essere comodo da leggere anche sul telefono: righe non troppo lunghe, interlinea generosa e colori con contrasto sufficiente.',
    homeTitle: 'Home di esempio',
    mock: {
      name: 'La tua attività',
      nav: 'Contatti',
      eyebrow: 'Dal 1998 in centro',
      h1: 'Un titolo chiaro per la tua home.',
      lead: 'Due righe su cosa fai e per chi. I colori della palette fanno il resto.',
      btn1: 'Prenota',
      btn2: 'Scopri di più',
      cards: [
        ['Servizi', 'Cosa offri, in poche parole.', 'Da 30 €'],
        ['Orari', 'Aperti dal martedì al sabato.', '9:00 – 19:00'],
        ['Dove siamo', 'Indirizzo e parcheggio vicino.', 'Mappa'],
      ],
      banner: 'Novità: ora prenoti anche online',
    },
    mediaTitle: 'Supporti',
    mediaIntro: 'La stessa palette su biglietto da visita, insegna e post. Sono bozze per farti un’idea: per la stampa servono i file definitivi.',
    card: { front: 'Fronte', back: 'Retro', person: 'Nome Cognome', role: 'Titolare', phone: '+39 000 000 0000', mail: 'info@tuosito.it', site: 'tuosito.it' },
    sign: 'Insegna',
    post: 'Post social',
    postText: 'Novità di stagione',
    postSub: 'Scopri cosa cambia questo mese',
    footer: 'calicchia.design · Palette di settore',
  },
  en: {
    lang: 'en',
    kit: 'Brand kit',
    tool: 'Industry colour palette',
    titleFor: (sector: string) => `The palette for ${sector}`,
    titleGeneric: 'Your palette',
    style: 'Style',
    made: 'Created on',
    openTool: 'Reopen the palette in the tool',
    colorsTitle: 'Colours and codes',
    colorsIntro: 'The palette colours from lightest to darkest. Use HEX for the web and design software, RGB for screens.',
    cmykNote: 'CMYK is calculated from the RGB values: for print, always ask your printer for a colour proof.',
    primaryTag: 'Primary',
    rolesTitle: 'Roles and contrast',
    rolesIntro: 'How to spread the colours across a website: neutrals come from the lightest and darkest colour, primary and accent from the palette.',
    roles: {
      bg: ['Background', 'The page background.'],
      surface: ['Surface', 'Cards, forms and panels.'],
      text: ['Text', 'Headings and paragraphs.'],
      muted: ['Secondary text', 'Captions, dates, notes.'],
      border: ['Borders', 'Lines and dividers.'],
      primary: ['Primary', 'Buttons and main actions.'],
      accent: ['Accent', 'Links and details worth noticing.'],
    },
    fixPrimary: (from: string, to: string, ratio: string) =>
      `The primary ${from} was adjusted to ${to} to reach ${ratio}:1 with the button text.`,
    fixAccent: (from: string, to: string, ratio: string) =>
      `As text, the accent ${from} becomes ${to} to reach ${ratio}:1 on the background.`,
    contrastTitle: 'Contrast (WCAG 2.2)',
    pair: 'Pair',
    sample: 'Sample',
    ratio: 'Ratio',
    result: 'Result',
    pairs: {
      textBg: 'Text on background',
      mutedBg: 'Secondary text on background',
      textSurface: 'Text on surface',
      onPrimary: 'Button text on primary',
      accentBg: 'Accent (text) on background',
    },
    grades: { AAA: 'AAA', AA: 'AA', 'large-only': 'Large text only', 'ui-pass': 'OK for graphics', fail: 'Not enough' } as Record<ContrastGrade, string>,
    contrastNote: 'Body text: at least 4.5:1 (AA), 7:1 for AAA. Large text and graphics: at least 3:1.',
    typeTitle: 'Typography',
    typeIntro: (style: string) => `The ${style} style pairs these typefaces. They are free on Google Fonts under the Open Font License.`,
    headingFont: 'Headings',
    bodyFont: 'Body',
    accentFont: 'Details',
    specimenHeading: 'A headline you can read from afar',
    specimenBody: 'Paragraph text should be comfortable to read on a phone too: lines that are not too long, generous line spacing and colours with enough contrast.',
    homeTitle: 'Sample home page',
    mock: {
      name: 'Your business',
      nav: 'Contact',
      eyebrow: 'In town since 1998',
      h1: 'A clear headline for your home page.',
      lead: 'Two lines on what you do and who it is for. The palette colours do the rest.',
      btn1: 'Book now',
      btn2: 'Learn more',
      cards: [
        ['Services', 'What you offer, in a few words.', 'From €30'],
        ['Opening hours', 'Open Tuesday to Saturday.', '9am – 7pm'],
        ['Find us', 'Address and nearby parking.', 'Map'],
      ],
      banner: 'New: you can now book online',
    },
    mediaTitle: 'Applications',
    mediaIntro: 'The same palette on a business card, a shop sign and a post. These are drafts to give you an idea: print needs final artwork.',
    card: { front: 'Front', back: 'Back', person: 'First Last', role: 'Owner', phone: '+44 0000 000000', mail: 'hello@yoursite.com', site: 'yoursite.com' },
    sign: 'Shop sign',
    post: 'Social post',
    postText: 'New this season',
    postSub: 'See what changes this month',
    footer: 'calicchia.design · Industry colour palette',
  },
} as const;

type Copy = (typeof COPY)[KitLocale];

const fmtRatio = (r: number, locale: KitLocale): string =>
  (Math.floor(r * 10) / 10).toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function cmyk(hex: string): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 100];
  const f = (x: number) => Math.round(((1 - x - k) / (1 - k)) * 100);
  return [f(r), f(g), f(b), Math.round(k * 100)];
}

function oklchLabel(hex: string): string {
  const [L, C, h] = labToLch(hexToLab(hex));
  return `${(L * 100).toFixed(1)}% ${C.toFixed(3)} ${C < 0.005 ? '—' : `${Math.round(h)}°`}`;
}

/** Colore leggibile sopra `bg`: il più contrastato tra testo scuro e bianco. */
function inkOn(bg: string, dark: string): string {
  return contrast(bg, '#FFFFFF') >= contrast(bg, dark) ? '#FFFFFF' : dark;
}

interface Model {
  colors: string[];
  primaryHex: string;
  roles: PaletteRoles;
}

function buildModel(palette: SharedPalette): Model {
  const colors = palette.colors.map((c) => normalizeHex(c) ?? '#000000');
  const primaryHex = colors[Math.min(palette.primary, colors.length - 1)];
  const list: PaletteColor[] = colors.map((hex) => ({ hex, lab: hexToLab(hex), locked: false }));
  const roles = deriveRoles(list, { primaryHex });
  const sorted = [...colors].sort((a, b) => hexToLab(b)[0] - hexToLab(a)[0]);
  return { colors: sorted, primaryHex, roles };
}

function page(inner: string, n: number, t: Copy, extraClass = ''): string {
  return `<section class="page ${extraClass}">${inner}<footer class="foot"><span>${esc(t.footer)}</span><span>${n} / 5</span></footer></section>`;
}

function coverPage(input: BrandKitInput, m: Model, t: Copy): string {
  const p = PRESETS[input.palette.preset];
  // "La palette per dentisti": in una frase l'etichetta va in minuscolo.
  const title = input.sectorLabel ? t.titleFor(input.sectorLabel.toLocaleLowerCase(input.locale)) : t.titleGeneric;
  const date = input.date.toLocaleDateString(input.locale === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const bands = m.colors
    .map((hex) => `<div class="band" style="background:${hex};color:${inkOn(hex, m.roles.text)}"><span>${hex}</span></div>`)
    .join('');
  return page(
    `<div class="cover-top">
      <p class="eyebrow">${esc(t.kit)} · ${esc(t.tool)}</p>
      <h1 class="cover-title">${esc(title)}</h1>
      <dl class="cover-meta">
        <div><dt>${esc(t.style)}</dt><dd>${esc(p.name[input.locale])}</dd></div>
        <div><dt>${esc(t.made)}</dt><dd>${esc(date)}</dd></div>
      </dl>
      <p class="cover-link"><a href="${esc(input.shareUrl)}">${esc(t.openTool)} →</a></p>
    </div>
    <div class="bands">${bands}</div>`,
    1,
    t,
    'cover',
  );
}

function colorsPage(input: BrandKitInput, m: Model, t: Copy): string {
  const rows = m.colors
    .map((hex) => {
      const [r, g, b] = hexToRgb(hex);
      const [c, mm, y, k] = cmyk(hex);
      const isPrimary = hex === m.primaryHex;
      return `<article class="swatch">
        <div class="chip" style="background:${hex}"></div>
        <div class="codes">
          <p class="hex">${hex}${isPrimary ? ` <span class="tag">${esc(t.primaryTag)}</span>` : ''}</p>
          <dl>
            <div><dt>RGB</dt><dd>${r} ${g} ${b}</dd></div>
            <div><dt>CMYK</dt><dd>${c} ${mm} ${y} ${k}</dd></div>
            <div><dt>OKLCH</dt><dd>${oklchLabel(hex)}</dd></div>
          </dl>
        </div>
      </article>`;
    })
    .join('');
  return page(
    `<header class="head"><p class="eyebrow">02</p><h2>${esc(t.colorsTitle)}</h2><p class="intro">${esc(t.colorsIntro)}</p></header>
    <div class="swatches">${rows}</div>
    <p class="note">${esc(t.cmykNote)}</p>`,
    2,
    t,
  );
}

function rolesPage(input: BrandKitInput, m: Model, t: Copy): string {
  const r = m.roles;
  const role = (key: keyof Copy['roles'], hex: string, ink?: string) =>
    `<div class="role"><div class="role-chip" style="background:${hex};color:${ink ?? inkOn(hex, r.text)}">${ink ? 'Aa' : ''}</div><div><p class="role-name">${esc(t.roles[key][0])}</p><p class="role-hex">${hex}</p><p class="role-use">${esc(t.roles[key][1])}</p></div></div>`;
  const fixes = r.fixes
    .map((f) =>
      f.kind === 'primary'
        ? t.fixPrimary(f.from, f.to, fmtRatio(f.ratio, input.locale))
        : t.fixAccent(f.from, f.to, fmtRatio(f.ratio, input.locale)),
    )
    .map((s) => `<li>${esc(s)}</li>`)
    .join('');

  const pairs: Array<{ label: string; fg: string; bg: string; kind: ContrastKind }> = [
    { label: t.pairs.textBg, fg: r.text, bg: r.bg, kind: 'text' },
    { label: t.pairs.mutedBg, fg: r.muted, bg: r.bg, kind: 'text' },
    { label: t.pairs.textSurface, fg: r.text, bg: r.surface, kind: 'text' },
    { label: t.pairs.onPrimary, fg: r.onPrimary, bg: r.primaryUsed, kind: 'text' },
    { label: t.pairs.accentBg, fg: r.accentText, bg: r.bg, kind: 'text' },
  ];
  const table = pairs
    .map((p) => {
      const ratio = contrast(p.fg, p.bg);
      const { grade, pass } = contrastGrade(ratio, p.kind);
      return `<tr><td>${esc(p.label)}<span class="pair-hex">${p.fg} / ${p.bg}</span></td><td><span class="aa" style="background:${p.bg};color:${p.fg}${p.kind === 'ui' ? `;border:2px solid ${p.fg}` : ''}">Aa</span></td><td class="num">${fmtRatio(ratio, input.locale)}:1</td><td class="${pass ? 'ok' : 'ko'}">${esc(t.grades[grade])}</td></tr>`;
    })
    .join('');

  return page(
    `<header class="head"><p class="eyebrow">03</p><h2>${esc(t.rolesTitle)}</h2><p class="intro">${esc(t.rolesIntro)}</p></header>
    <div class="roles">
      ${role('bg', r.bg)}${role('surface', r.surface)}${role('text', r.text)}${role('muted', r.muted)}
      ${role('border', r.border)}${role('primary', r.primaryUsed, r.onPrimary)}${role('accent', r.accentText)}
    </div>
    ${fixes ? `<ul class="fixes">${fixes}</ul>` : ''}
    <h3 class="sub">${esc(t.contrastTitle)}</h3>
    <table class="contrast"><thead><tr><th>${esc(t.pair)}</th><th>${esc(t.sample)}</th><th class="num">${esc(t.ratio)}</th><th>${esc(t.result)}</th></tr></thead><tbody>${table}</tbody></table>
    <p class="note">${esc(t.contrastNote)}</p>`,
    3,
    t,
  );
}

/** Variabili CSS dell'anteprima: ruoli + stile, come nel tool. */
function previewVars(input: BrandKitInput, r: PaletteRoles): string {
  const p = PRESETS[input.palette.preset];
  return [
    `--p-bg:${r.bg}`,
    `--p-surface:${r.surface}`,
    `--p-text:${r.text}`,
    `--p-muted:${r.muted}`,
    `--p-border:${r.border}`,
    `--p-primary:${r.primaryUsed}`,
    `--p-on-primary:${r.onPrimary}`,
    `--p-accent:${r.accentText}`,
    `--p-font-h:${fontStack(p.fontHeading)}`,
    `--p-font-b:${fontStack(p.fontBody)}`,
    `--p-font-a:${fontStack(p.fontAccent ?? p.fontBody)}`,
    `--p-h-weight:${p.headingWeight}`,
    `--p-h-tracking:${p.headingTracking}`,
    `--p-h-transform:${p.headingTransform}`,
    `--p-radius:${p.radius}`,
    `--p-btn-radius:${p.buttonRadius}`,
    `--p-border-w:${p.borderWidth}`,
    `--p-shadow:${p.shadow(r.text)}`,
  ].join(';');
}

function typePage(input: BrandKitInput, m: Model, t: Copy): string {
  const p = PRESETS[input.palette.preset];
  const fonts: Array<[string, string]> = [
    [t.headingFont, FONT_FAMILIES[p.fontHeading].family],
    [t.bodyFont, FONT_FAMILIES[p.fontBody].family],
    ...(p.fontAccent ? ([[t.accentFont, FONT_FAMILIES[p.fontAccent].family]] as Array<[string, string]>) : []),
  ];
  const mk = t.mock;
  const cards = mk.cards
    .map(([title, body, meta]) => `<div class="mk-card"><p class="mk-card-t">${esc(title)}</p><p>${esc(body)}</p><p class="mk-meta">${esc(meta)}</p></div>`)
    .join('');
  return page(
    `<header class="head"><p class="eyebrow">04</p><h2>${esc(t.typeTitle)}</h2><p class="intro">${esc(t.typeIntro(p.name[input.locale]))}</p></header>
    <div class="pv" style="${previewVars(input, m.roles)}">
      <dl class="fonts">${fonts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <div class="specimen">
        <p class="spec-aa">Aa</p>
        <div><p class="spec-h">${esc(t.specimenHeading)}</p><p class="spec-b">${esc(t.specimenBody)}</p></div>
      </div>
    </div>
    <h3 class="sub">${esc(t.homeTitle)}</h3>
    <div class="pv mock" style="${previewVars(input, m.roles)}">
      <div class="mk-banner">${esc(mk.banner)}</div>
      <div class="mk-nav"><span class="mk-name">${esc(mk.name)}</span><span class="mk-btn sm">${esc(mk.nav)}</span></div>
      <div class="mk-hero">
        <p class="mk-eyebrow">${esc(input.sectorLabel ?? mk.eyebrow)}</p>
        <p class="mk-h1">${esc(mk.h1)}</p>
        <p class="mk-lead">${esc(mk.lead)}</p>
        <p class="mk-btns"><span class="mk-btn">${esc(mk.btn1)}</span><span class="mk-link">${esc(mk.btn2)} →</span></p>
      </div>
      <div class="mk-cards">${cards}</div>
    </div>`,
    4,
    t,
  );
}

function mediaPage(input: BrandKitInput, m: Model, t: Copy): string {
  const c = t.card;
  const vars = previewVars(input, m.roles);
  return page(
    `<header class="head"><p class="eyebrow">05</p><h2>${esc(t.mediaTitle)}</h2><p class="intro">${esc(t.mediaIntro)}</p></header>
    <div class="pv media" style="${vars}">
      <figure><div class="bc bc-front"><p class="bc-name">${esc(t.mock.name)}</p><p class="bc-site">${esc(c.site)}</p></div><figcaption>${esc(c.front)}</figcaption></figure>
      <figure><div class="bc bc-back"><div><p class="bc-person">${esc(c.person)}</p><p class="bc-role">${esc(c.role)}</p></div><div class="bc-lines"><p>${esc(c.phone)}</p><p>${esc(c.mail)}</p></div></div><figcaption>${esc(c.back)}</figcaption></figure>
      <figure class="wide"><div class="sign"><span class="sign-mark"></span><span class="sign-name">${esc(t.mock.name)}</span></div><figcaption>${esc(t.sign)}</figcaption></figure>
      <figure><div class="post"><p class="post-k">${esc(input.sectorLabel ?? t.mock.name)}</p><p class="post-t">${esc(t.postText)}</p><p class="post-s">${esc(t.postSub)}</p><span class="post-dot"></span></div><figcaption>${esc(t.post)}</figcaption></figure>
    </div>`,
    5,
    t,
  );
}

const CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Funnel Sans', 'Helvetica Neue', Arial, sans-serif; color: #111111; font-size: 10.5pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
p { margin: 0; }
a { color: inherit; }
.page { width: 210mm; height: 297mm; padding: 18mm 18mm 16mm; position: relative; overflow: hidden; page-break-after: always; display: flex; flex-direction: column; gap: 7mm; background: #FAFAF7; }
.page:last-child { page-break-after: auto; }
.foot { position: absolute; left: 18mm; right: 18mm; bottom: 9mm; display: flex; justify-content: space-between; font-size: 8pt; color: #6B6B66; letter-spacing: 0.04em; }
.eyebrow { font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; color: #6B6B66; }
h1, h2, h3 { font-family: 'Funnel Display', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 24pt; line-height: 1.1; margin-top: 2mm; }
.head { display: grid; gap: 1mm; }
.intro { max-width: 140mm; color: #45453F; margin-top: 2mm; }
.sub { font-size: 13pt; margin-top: 2mm; }
.note { font-size: 8.5pt; color: #6B6B66; max-width: 150mm; }

.cover { padding: 0; gap: 0; }
.cover-top { padding: 22mm 18mm 12mm; display: grid; gap: 6mm; }
.cover-title { font-size: 40pt; line-height: 1.02; max-width: 160mm; }
.cover-meta { display: flex; gap: 12mm; margin: 0; }
.cover-meta dt { font-size: 8pt; letter-spacing: 0.12em; text-transform: uppercase; color: #6B6B66; }
.cover-meta dd { margin: 1mm 0 0; font-size: 12pt; }
.cover-link { font-size: 10pt; }
.bands { flex: 1; display: flex; flex-direction: column; margin-bottom: 22mm; }
.band { flex: 1; display: flex; align-items: flex-end; padding: 0 18mm 3mm; font-size: 9pt; letter-spacing: 0.06em; }
.cover .foot { bottom: 9mm; }

.swatches { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm 8mm; }
.swatch { display: grid; grid-template-columns: 30mm 1fr; gap: 5mm; align-items: start; break-inside: avoid; }
.chip { height: 30mm; border-radius: 2mm; border: 0.3mm solid rgba(0,0,0,0.08); }
.hex { font-family: 'Funnel Display', sans-serif; font-size: 15pt; font-weight: 600; }
.tag { font-family: 'Funnel Sans', sans-serif; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; background: #111111; color: #FFFFFF; padding: 0.6mm 1.6mm; border-radius: 1mm; vertical-align: middle; }
.codes dl { margin: 2mm 0 0; display: grid; gap: 0.8mm; }
.codes dl div { display: flex; gap: 3mm; font-size: 9.5pt; }
.codes dt { width: 13mm; color: #6B6B66; font-size: 8pt; letter-spacing: 0.08em; padding-top: 0.4mm; }
.codes dd { margin: 0; font-variant-numeric: tabular-nums; }

.roles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4mm 8mm; }
.role { display: grid; grid-template-columns: 14mm 1fr; gap: 4mm; align-items: center; }
.role-chip { height: 14mm; border-radius: 1.5mm; border: 0.3mm solid rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: center; font-weight: 600; }
.role-name { font-weight: 600; }
.role-hex { font-size: 9pt; font-variant-numeric: tabular-nums; }
.role-use { font-size: 8.5pt; color: #6B6B66; }
.fixes { margin: 0; padding-left: 4mm; font-size: 8.5pt; color: #45453F; }
.contrast { width: 100%; border-collapse: collapse; font-size: 9pt; }
.contrast th { text-align: left; font-size: 7.5pt; letter-spacing: 0.1em; text-transform: uppercase; color: #6B6B66; font-weight: 500; padding: 0 2mm 1.5mm 0; border-bottom: 0.3mm solid #111111; }
.contrast td { padding: 2mm 2mm 2mm 0; border-bottom: 0.2mm solid #E2E1DC; vertical-align: middle; }
.pair-hex { display: block; font-size: 7.5pt; color: #6B6B66; }
.aa { display: inline-block; padding: 1mm 3mm; border-radius: 1mm; font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.ok { color: #1F6B45; font-weight: 600; }
.ko { color: #A3361B; font-weight: 600; }

.pv { font-family: var(--p-font-b); }
.fonts { display: flex; gap: 10mm; margin: 0; }
.fonts dt { font-size: 8pt; letter-spacing: 0.12em; text-transform: uppercase; color: #6B6B66; font-family: 'Funnel Sans', sans-serif; }
.fonts dd { margin: 1mm 0 0; font-size: 12pt; font-family: 'Funnel Sans', sans-serif; font-weight: 600; }
.specimen { display: grid; grid-template-columns: 32mm 1fr; gap: 6mm; margin-top: 5mm; align-items: start; }
.spec-aa { font-family: var(--p-font-h); font-weight: var(--p-h-weight); font-size: 58pt; line-height: 0.9; color: var(--p-primary); }
.spec-h { font-family: var(--p-font-h); font-weight: var(--p-h-weight); letter-spacing: var(--p-h-tracking); text-transform: var(--p-h-transform); font-size: 18pt; line-height: 1.15; }
.spec-b { margin-top: 2mm; font-size: 10.5pt; color: #45453F; max-width: 120mm; }

.mock { background: var(--p-bg); color: var(--p-text); border: 0.3mm solid var(--p-border); border-radius: var(--p-radius); overflow: hidden; }
.mk-banner { background: var(--p-text); color: var(--p-bg); font-size: 8pt; text-align: center; padding: 1.6mm; }
.mk-nav { display: flex; justify-content: space-between; align-items: center; padding: 4mm 7mm; border-bottom: var(--p-border-w) solid var(--p-border); }
.mk-name { font-family: var(--p-font-h); font-weight: var(--p-h-weight); text-transform: var(--p-h-transform); letter-spacing: var(--p-h-tracking); font-size: 11pt; }
.mk-hero { padding: 9mm 7mm 7mm; display: grid; gap: 3mm; }
.mk-eyebrow { font-family: var(--p-font-a); font-size: 8pt; letter-spacing: 0.12em; text-transform: uppercase; color: var(--p-accent); }
.mk-h1 { font-family: var(--p-font-h); font-weight: var(--p-h-weight); text-transform: var(--p-h-transform); letter-spacing: var(--p-h-tracking); font-size: 22pt; line-height: 1.08; max-width: 130mm; }
.mk-lead { color: var(--p-muted); max-width: 120mm; }
.mk-btns { display: flex; gap: 5mm; align-items: center; margin-top: 2mm; }
.mk-btn { display: inline-block; background: var(--p-primary); color: var(--p-on-primary); border-radius: var(--p-btn-radius); padding: 2.4mm 5mm; font-weight: 600; font-size: 9.5pt; }
.mk-btn.sm { padding: 1.4mm 3.5mm; font-size: 8.5pt; }
.mk-link { color: var(--p-accent); font-weight: 600; font-size: 9.5pt; }
.mk-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; padding: 0 7mm 7mm; }
.mk-card { background: var(--p-surface); border: var(--p-border-w) solid var(--p-border); border-radius: var(--p-radius); box-shadow: var(--p-shadow); padding: 4mm; display: grid; gap: 1mm; font-size: 8.5pt; }
.mk-card-t { font-family: var(--p-font-h); font-weight: var(--p-h-weight); text-transform: var(--p-h-transform); font-size: 10.5pt; }
.mk-meta { color: var(--p-accent); font-weight: 600; font-family: var(--p-font-a); }

.media { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.media figure { margin: 0; display: grid; gap: 2mm; }
.media figure.wide { grid-column: 1 / -1; }
.media figcaption { font-family: 'Funnel Sans', sans-serif; font-size: 8pt; letter-spacing: 0.12em; text-transform: uppercase; color: #6B6B66; }
.bc { aspect-ratio: 85 / 55; border-radius: 2mm; padding: 6mm; display: flex; flex-direction: column; justify-content: space-between; border: 0.3mm solid var(--p-border); }
.bc-front { background: var(--p-primary); color: var(--p-on-primary); }
.bc-name { font-family: var(--p-font-h); font-weight: var(--p-h-weight); text-transform: var(--p-h-transform); letter-spacing: var(--p-h-tracking); font-size: 16pt; line-height: 1.05; }
.bc-site { font-size: 8.5pt; opacity: 0.85; }
.bc-back { background: var(--p-surface); color: var(--p-text); }
.bc-person { font-family: var(--p-font-h); font-weight: var(--p-h-weight); font-size: 12pt; }
.bc-role { color: var(--p-accent); font-size: 8.5pt; font-weight: 600; }
.bc-lines { font-size: 8.5pt; color: var(--p-muted); display: grid; gap: 0.6mm; }
.sign { height: 34mm; background: var(--p-text); color: var(--p-bg); border-radius: var(--p-radius); display: flex; align-items: center; gap: 7mm; padding: 0 10mm; }
.sign-mark { width: 16mm; height: 16mm; border-radius: 50%; background: var(--p-primary); flex: none; }
.sign-name { font-family: var(--p-font-h); font-weight: var(--p-h-weight); text-transform: var(--p-h-transform); letter-spacing: var(--p-h-tracking); font-size: 28pt; line-height: 1; }
.post { aspect-ratio: 1; background: var(--p-bg); border: 0.3mm solid var(--p-border); border-radius: var(--p-radius); padding: 7mm; display: flex; flex-direction: column; justify-content: flex-end; gap: 2mm; position: relative; overflow: hidden; }
.post-k { font-family: var(--p-font-a); font-size: 8pt; letter-spacing: 0.12em; text-transform: uppercase; color: var(--p-accent); }
.post-t { font-family: var(--p-font-h); font-weight: var(--p-h-weight); text-transform: var(--p-h-transform); letter-spacing: var(--p-h-tracking); font-size: 20pt; line-height: 1.05; color: var(--p-text); }
.post-s { color: var(--p-muted); font-size: 9pt; }
.post-dot { position: absolute; top: -14mm; right: -14mm; width: 46mm; height: 46mm; border-radius: 50%; background: var(--p-primary); }
`;

export function renderBrandKitHtml(input: BrandKitInput): string {
  const t = COPY[input.locale];
  const m = buildModel(input.palette);
  return `<!DOCTYPE html><html lang="${t.lang}"><head><meta charset="utf-8"><title>${esc(t.kit)}</title><style>${input.fontCss}\n${CSS}</style></head><body>
${coverPage(input, m, t)}
${colorsPage(input, m, t)}
${rolesPage(input, m, t)}
${typePage(input, m, t)}
${mediaPage(input, m, t)}
</body></html>`;
}
