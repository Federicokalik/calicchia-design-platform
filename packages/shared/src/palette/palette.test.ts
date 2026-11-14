/**
 * Test del motore palette: `pnpm --filter @calicchia/shared test`.
 * node:test eseguito da tsx, nessun database né rete.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PaletteColor,
  type PhotoInput,
  brandPaletteSchema,
  contrast,
  contrastGrade,
  createRng,
  decodeSharedPalette,
  deltaE,
  deriveRoles,
  encodeSharedPalette,
  exportPalette,
  extractFromPixels,
  fallbackMood,
  hexToLab,
  labToHex,
  normalizeHex,
  normalizeQuery,
  pickSubset,
  selectPalette,
  suggestPreset,
} from './index';

/** Immagine sintetica w×h: metà sinistra colore a, metà destra colore b. */
function twoTone(a: [number, number, number], b: [number, number, number], w = 64, h = 48): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = x < w / 2 ? a : b;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Foto simulate dai colori di un mood: ogni foto = tre colori del mood con pesi diversi. */
function photosFromMood(mood: string[]): PhotoInput[] {
  return mood.map((_, i) => ({
    id: `p${i}`,
    weight: 1,
    clusters: [0, 1, 2].map((k) => {
      const hex = mood[(i + k) % mood.length];
      return { hex, lab: hexToLab(hex), w: [0.5, 0.3, 0.2][k] };
    }),
  }));
}

describe('colore', () => {
  it('hex → OKLab → hex è stabile', () => {
    for (const hex of ['#000000', '#FFFFFF', '#F57F44', '#1F6F73', '#C63D2B', '#EFE5D2', '#7CC4B4']) {
      assert.equal(labToHex(hexToLab(hex)), hex);
    }
  });

  it('contrasti WCAG noti', () => {
    assert.ok(Math.abs(contrast('#000000', '#FFFFFF') - 21) < 1e-9);
    const onWhite = contrast('#F57F44', '#FFFFFF');
    const onInk = contrast('#F57F44', '#111111');
    assert.ok(onWhite > 2.5 && onWhite < 2.7, `bianco su accento: ${onWhite}`);
    assert.ok(onInk > 7.0 && onInk < 7.4, `#111 su accento: ${onInk}`);
    assert.equal(contrastGrade(onWhite, 'text').pass, false);
    assert.equal(contrastGrade(onInk, 'text').grade, 'AAA');
    assert.equal(contrastGrade(3.2, 'ui').pass, true);
  });

  it('normalizeHex accetta forme comuni e rifiuta il resto', () => {
    assert.equal(normalizeHex('f57f44'), '#F57F44');
    assert.equal(normalizeHex(' #a1b2c3 '), '#A1B2C3');
    assert.equal(normalizeHex('#FFF'), null);
    assert.equal(normalizeHex('red'), null);
  });
});

describe('estrazione', () => {
  it('trova i due colori di un\'immagine bicolore', () => {
    const px = twoTone([198, 61, 43], [31, 111, 115]);
    const clusters = extractFromPixels(px, createRng(42));
    assert.equal(clusters.length, 2);
    const red = hexToLab('#C63D2B');
    const teal = hexToLab('#1F6F73');
    assert.ok(clusters.some((c) => deltaE(c.lab, red) < 0.03));
    assert.ok(clusters.some((c) => deltaE(c.lab, teal) < 0.03));
    assert.ok(Math.abs(clusters[0].w + clusters[1].w - 1) < 1e-9);
  });

  it('è deterministica a parità di seed', () => {
    const px = new Uint8Array(64 * 48 * 4);
    const rand = createRng(7);
    for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : Math.floor(rand() * 256);
    const a = extractFromPixels(px, createRng(123));
    const b = extractFromPixels(px, createRng(123));
    assert.deepEqual(a, b);
  });

  it('ignora i pixel trasparenti', () => {
    const px = twoTone([198, 61, 43], [31, 111, 115]);
    for (let i = 0; i < px.length; i += 4) if ((i / 4) % 64 >= 32) px[i + 3] = 0;
    const clusters = extractFromPixels(px, createRng(1));
    assert.equal(clusters.length, 1);
  });
});

describe('palette e ruoli', () => {
  const moods = ['pizzeria', 'studio dentistico', 'officina', 'fioraio', 'agenzia funebre', 'gelateria'].map(fallbackMood);

  it('sceglie 5 colori distinti, dal più chiaro al più scuro', () => {
    for (const mood of moods) {
      const pal = selectPalette({ photos: photosFromMood(mood) });
      assert.equal(pal.length, 5);
      assert.equal(new Set(pal.map((p) => p.hex)).size, 5);
      for (let i = 1; i < pal.length; i++) assert.ok(pal[i - 1].lab[0] >= pal[i].lab[0]);
    }
  });

  it('con autofix testo del bottone e accento passano 4,5:1', () => {
    for (const mood of moods) {
      const pal = selectPalette({ photos: photosFromMood(mood) });
      const r = deriveRoles(pal);
      assert.ok(contrast(r.onPrimary, r.primaryUsed) >= 4.5, `bottone ${r.onPrimary} su ${r.primaryUsed}`);
      assert.ok(contrast(r.accentText, r.bg) >= 4.5, `accento ${r.accentText} su ${r.bg}`);
      assert.ok(contrast(r.text, r.bg) >= 7, `testo ${r.text} su ${r.bg}`);
    }
  });

  it('senza autofix lascia i colori estratti', () => {
    const pal = selectPalette({ photos: photosFromMood(moods[0]) });
    const r = deriveRoles(pal, { autofix: false });
    assert.equal(r.primaryUsed, r.primary);
    assert.equal(r.accentText, r.accent);
    assert.equal(r.fixes.length, 0);
  });

  it('i colori del logo entrano per primi e restano fissi', () => {
    const logo = [{ hex: '#0055A4', lab: hexToLab('#0055A4'), w: 1 }];
    const pal = selectPalette({ photos: photosFromMood(moods[1]), logoColors: logo });
    const fromLogo = pal.find((p) => p.fromLogo);
    assert.ok(fromLogo && fromLogo.locked && fromLogo.hex === '#0055A4');
    assert.equal(deriveRoles(pal).primary, '#0055A4');
  });

  it('rispetta il primario scelto dall\'utente', () => {
    const pal = selectPalette({ photos: photosFromMood(moods[2]) });
    const pick = pal[pal.length - 1].hex;
    assert.equal(deriveRoles(pal, { primaryHex: pick }).primary, pick);
  });

  it('suggerisce lo stile del settore o lo deduce dai colori', () => {
    const pal: PaletteColor[] = ['#EEEEEE', '#BBBBBB', '#888888', '#555555', '#222222'].map((hex) => ({
      hex,
      lab: hexToLab(hex),
      locked: false,
    }));
    assert.equal(suggestPreset(pal, 'tecnico').key, 'tecnico');
    const s = suggestPreset(pal, null);
    assert.equal(s.key, 'editoriale');
    assert.equal(s.saturation, 'muted');
    assert.equal(s.fromSector, false);
  });
});

describe('esportazione', () => {
  const pal = selectPalette({ photos: photosFromMood(fallbackMood('pizzeria')) });
  const roles = deriveRoles(pal);

  it('ogni formato contiene i colori della palette', () => {
    for (const format of ['css', 'tailwind', 'json', 'canva'] as const) {
      const out = exportPalette(format, { label: 'Pizzerie', palette: pal, roles, preset: 'morbido', locale: 'it' });
      for (const c of pal) assert.ok(out.includes(c.hex), `${format} senza ${c.hex}`);
    }
  });

  it('il JSON è valido e in formato DTCG', () => {
    const out = exportPalette('json', { label: 'Pizzerie', palette: pal, roles, preset: 'tecnico', locale: 'en' });
    const json = JSON.parse(out);
    assert.equal(json.color.primary.$type, 'color');
    assert.equal(json.color.primary.$value, roles.primaryUsed);
    assert.ok(json.shadow.card.$value.offsetX);
  });
});

describe('link condiviso', () => {
  const base = { v: 1 as const, sector: 'pizzerie', preset: 'morbido' as const, colors: ['#C63D2B', '#EFE5D2', '#3F7A3A'], primary: 0 };

  it('encode → decode restituisce la stessa palette', () => {
    const qs = encodeSharedPalette(base);
    assert.equal(qs, 'v=1&k=pizzerie&c=C63D2B%2CEFE5D2%2C3F7A3A&s=morbido&p=0');
    assert.deepEqual(decodeSharedPalette(new URLSearchParams(qs)), base);
  });

  it('accetta anche un oggetto searchParams di Next', () => {
    const decoded = decodeSharedPalette({ v: '1', c: 'c63d2b,efe5d2', s: 'netto', p: '1' });
    assert.deepEqual(decoded, { v: 1, sector: undefined, preset: 'netto', colors: ['#C63D2B', '#EFE5D2'], primary: 1 });
  });

  it('scarta un settore sconosciuto ma tiene i colori', () => {
    const decoded = decodeSharedPalette(new URLSearchParams(encodeSharedPalette(base)), (s) => s === 'dentisti');
    assert.equal(decoded?.sector, undefined);
    assert.equal(decoded?.colors.length, 3);
  });

  it('rifiuta input malformati', () => {
    const bad = [
      { v: '2', c: 'C63D2B,EFE5D2', s: 'morbido', p: '0' },
      { v: '1', c: 'C63D2B', s: 'morbido', p: '0' },
      { v: '1', c: 'C63D2B,nothex', s: 'morbido', p: '0' },
      { v: '1', c: 'C63D2B,EFE5D2', s: 'comic-sans', p: '0' },
      { v: '1', c: 'C63D2B,EFE5D2', s: 'morbido', p: '5' },
      { v: '1', c: 'C63D2B,EFE5D2', s: 'morbido', p: '0', k: '<script>' },
      { v: '1', c: Array(9).fill('C63D2B').join(','), s: 'morbido', p: '0' },
    ];
    for (const params of bad) {
      const decoded = decodeSharedPalette(params);
      // Lo slug non valido fa fallire lo schema: niente testo libero nel link.
      assert.equal(decoded, null, JSON.stringify(params));
    }
  });

  it('brandPaletteSchema richiede la lingua', () => {
    assert.equal(brandPaletteSchema.safeParse(base).success, false);
    assert.equal(brandPaletteSchema.safeParse({ ...base, locale: 'it' }).success, true);
  });
});

describe('utilità', () => {
  it('pickSubset è deterministico e mantiene l\'ordine', () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const a = pickSubset(ids, 6, 99);
    assert.deepEqual(a, pickSubset(ids, 6, 99));
    assert.equal(a.length, 6);
    assert.deepEqual(a, [...a].sort((x, y) => x - y));
    assert.notDeepEqual(a, pickSubset(ids, 6, 100));
  });

  it('normalizeQuery toglie accenti e spazi', () => {
    assert.equal(normalizeQuery('  Caffè   Pasticceria '), 'caffe pasticceria');
  });
});
