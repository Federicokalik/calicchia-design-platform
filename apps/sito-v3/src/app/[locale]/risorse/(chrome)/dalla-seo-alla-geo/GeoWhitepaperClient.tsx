'use client';

import { useEffect } from 'react';
import type { GeoWpLocale } from '@/data/risorse/geo-whitepaper';

/**
 * Re-attaches the 4 interactive demos of the GEO white paper. The markup lives
 * in the page (injected via dangerouslySetInnerHTML); this component renders
 * nothing and wires the same element ids the original inline <script> used.
 * Locale-aware so the EN render gets English labels/verdicts.
 *
 * Ported 1:1 from geo-whitepaper-swiss.html (demos 01-04). Demos 01-03 are
 * didactic client-side simulations; demo 04 uses the exact Schulte 2026 data.
 */

type Strings = {
  dsWin: string;
  dsLose: string;
  spWin: string;
  spLose: string;
  chunk: { fixed: string; recursive: string; semantic: string; unit: (n: number, avg: number, note: string) => string };
  fan: {
    literal: string;
    criteria: string;
    compare: string;
    contextual: string;
    price: string;
    reviews: string;
    definition: string;
    deepen: string;
    alternatives: string;
    fresh: string;
    synthesisLbl: string;
    synthesis: (n: number) => string;
  };
  se: { bad: (lo: number, hi: number) => string; warn: (lo: number, hi: number) => string; ok: string; errLabel: string; ciLabel: (hw: string) => string };
};

const STR: Record<GeoWpLocale, Strings> = {
  it: {
    dsWin: 'Vince: query concettuale, il significato conta più delle parole.',
    dsLose: 'In svantaggio: senza match concettuale il vettore "medio" è ambiguo.',
    spWin: 'Vince: codici/nomi propri, il match lessicale esatto è decisivo.',
    spLose: 'In svantaggio: nessun token esatto distintivo da agganciare.',
    chunk: {
      fixed: 'Taglio fisso: veloce ma rompe le frasi → chunk ambigui.',
      recursive: 'Rispetta i confini di frase: chunk coerenti (default robusto).',
      semantic: 'Raggruppa per significato ma frammenta troppo (media ~43 tok nel Vecta Benchmark).',
      unit: (n, avg, note) => `${n} chunk · media ${avg} token — ${note}`,
    },
    fan: {
      literal: 'query letterale',
      criteria: 'criteri di scelta',
      compare: 'confronto',
      contextual: 'sotto-domanda contestuale',
      price: 'fascia di prezzo',
      reviews: 'recensioni',
      definition: 'definizione',
      deepen: 'approfondimento',
      alternatives: 'alternative',
      fresh: 'fonte fresca',
      synthesisLbl: 'sintesi',
      synthesis: (n) =>
        `${n} ricerche parallele, ognuna recupera fonti diverse: ${n}× le occasioni di essere citato — o di non esserlo.`,
    },
    se: {
      bad: (lo, hi) => `Inutile: il tasso reale 50% può apparire tra ${lo}% e ${hi}%. Indistinguibile dal rumore.`,
      warn: (lo, hi) => `Ancora rumoroso: distingui solo differenze grandi. Range ${lo}%–${hi}%.`,
      ok: 'Affidabile: SE sotto 0,10. Soglia minima difendibile (7+ run).',
      errLabel: 'errore standard',
      ciLabel: (hw) => `intervallo 95%: ±${hw}`,
    },
  },
  en: {
    dsWin: 'Wins: conceptual query, meaning matters more than the exact words.',
    dsLose: 'At a disadvantage: with no conceptual match the "average" vector is ambiguous.',
    spWin: 'Wins: codes/proper nouns, exact lexical match is decisive.',
    spLose: 'At a disadvantage: no distinctive exact token to latch onto.',
    chunk: {
      fixed: 'Fixed cut: fast but breaks sentences → ambiguous chunks.',
      recursive: 'Respects sentence boundaries: coherent chunks (robust default).',
      semantic: 'Groups by meaning but over-fragments (avg ~43 tok in the Vecta Benchmark).',
      unit: (n, avg, note) => `${n} chunks · avg ${avg} tokens — ${note}`,
    },
    fan: {
      literal: 'literal query',
      criteria: 'selection criteria',
      compare: 'comparison',
      contextual: 'contextual sub-question',
      price: 'price range',
      reviews: 'reviews',
      definition: 'definition',
      deepen: 'deep dive',
      alternatives: 'alternatives',
      fresh: 'fresh source',
      synthesisLbl: 'synthesis',
      synthesis: (n) =>
        `${n} parallel searches, each retrieving different sources: ${n}× the chances to be cited — or not to be.`,
    },
    se: {
      bad: (lo, hi) => `Useless: the true 50% rate can show up between ${lo}% and ${hi}%. Indistinguishable from noise.`,
      warn: (lo, hi) => `Still noisy: you only tell apart large differences. Range ${lo}%–${hi}%.`,
      ok: 'Reliable: SE below 0.10. Minimum defensible threshold (7+ runs).',
      errLabel: 'standard error',
      ciLabel: (hw) => `95% interval: ±${hw}`,
    },
  },
};

export function GeoWhitepaperClient({ locale }: { locale: GeoWpLocale }) {
  useEffect(() => {
    const s = STR[locale];
    const cleanups: Array<() => void> = [];
    const $ = (id: string) => document.getElementById(id);

    // ---------- DEMO 1 · dense vs sparse ----------
    (() => {
      const q = $('ds-q') as HTMLInputElement | null;
      const ds = $('ds-dense-score');
      const ss = $('ds-sparse-score');
      const db = $('ds-dense-bar');
      const sb = $('ds-sparse-bar');
      const dn = $('ds-dense-note');
      const sn = $('ds-sparse-note');
      if (!q || !ds || !ss || !db || !sb || !dn || !sn) return;
      const analyze = (t: string) => {
        const str = t.trim().toLowerCase();
        const hasCode = /\b[a-z]*\d{2,}\b/.test(str) || /\b[a-z]+\s?\d+\b/.test(str);
        const hasProper = /\b[A-Z][a-z]+/.test(t);
        const words = str.split(/\s+/).filter(Boolean).length;
        const isQ = /\b(come|cosa|qual|quale|perch|quando|dove|miglior|how|what|which|why|when|where|best)\b/.test(str);
        let sparse = 40;
        if (hasCode) sparse += 40;
        if (hasProper) sparse += 12;
        if (words <= 4) sparse += 8;
        if (isQ) sparse -= 18;
        let dense = 45;
        if (isQ) dense += 30;
        if (words >= 5) dense += 12;
        if (hasCode) dense -= 22;
        sparse = Math.max(8, Math.min(98, sparse));
        dense = Math.max(8, Math.min(98, dense));
        ds.textContent = dense + '%';
        ss.textContent = sparse + '%';
        (db as HTMLElement).style.width = dense + '%';
        (sb as HTMLElement).style.width = sparse + '%';
        dn.textContent = dense >= sparse ? s.dsWin : s.dsLose;
        sn.textContent = sparse >= dense ? s.spWin : s.spLose;
      };
      const onInput = () => analyze(q.value);
      q.addEventListener('input', onInput);
      cleanups.push(() => q.removeEventListener('input', onInput));
      document.querySelectorAll<HTMLElement>('#ds-chips .chip').forEach((c) => {
        const onClick = () => {
          q.value = c.dataset.q ?? '';
          analyze(q.value);
        };
        c.addEventListener('click', onClick);
        cleanups.push(() => c.removeEventListener('click', onClick));
      });
      analyze(q.value);
    })();

    // ---------- DEMO 2 · chunking ----------
    (() => {
      const inp = $('chunk-in') as HTMLInputElement | null;
      const out = $('chunk-out');
      const meta = $('chunk-meta');
      if (!inp || !out || !meta) return;
      let mode = 'recursive';
      const tok = (str: string) => str.trim().split(/\s+/).filter(Boolean);
      const notes: Record<string, string> = { fixed: s.chunk.fixed, recursive: s.chunk.recursive, semantic: s.chunk.semantic };
      const render = () => {
        const text = inp.value.trim();
        const toks = tok(text);
        out.innerHTML = '';
        let chunks: string[] = [];
        if (mode === 'fixed') {
          const n = 8;
          for (let i = 0; i < toks.length; i += n) chunks.push(toks.slice(i, i + n).join(' '));
        } else if (mode === 'recursive') {
          chunks = text.split(/(?<=[.!?])\s+/).filter(Boolean);
        } else {
          chunks = text
            .split(/(?<=[.!?])\s+/)
            .filter(Boolean)
            .flatMap((c) => {
              const t = tok(c);
              return t.length > 9 ? [t.slice(0, Math.ceil(t.length / 2)).join(' '), t.slice(Math.ceil(t.length / 2)).join(' ')] : [c];
            });
        }
        chunks.forEach((c, i) => {
          const d = document.createElement('div');
          d.className = 'chunk c' + (i % 3);
          d.innerHTML = '<span class="tag">CHUNK ' + (i + 1) + ' · ' + tok(c).length + ' TOK</span>' + c;
          d.style.animationDelay = i * 0.05 + 's';
          out.appendChild(d);
        });
        const avg = chunks.length ? Math.round(chunks.reduce((a, c) => a + tok(c).length, 0) / chunks.length) : 0;
        meta.textContent = s.chunk.unit(chunks.length, avg, notes[mode]);
      };
      const btns = Array.from(document.querySelectorAll<HTMLElement>('#demo-chunk .chunk-controls button'));
      btns.forEach((b) => {
        const onClick = () => {
          mode = b.dataset.mode ?? 'recursive';
          btns.forEach((x) => x.classList.toggle('ghost', x !== b));
          render();
        };
        b.addEventListener('click', onClick);
        cleanups.push(() => b.removeEventListener('click', onClick));
        if (b.dataset.mode !== 'recursive') b.classList.add('ghost');
      });
      const onInput = () => render();
      inp.addEventListener('input', onInput);
      cleanups.push(() => inp.removeEventListener('input', onInput));
      render();
    })();

    // ---------- DEMO 3 · query fan-out ----------
    (() => {
      const q = $('fo-q') as HTMLInputElement | null;
      const go = $('fo-go');
      const rs = $('fo-reset');
      const out = $('fo-out');
      if (!q || !go || !rs || !out) return;
      const fan = (query: string) => {
        const str = query.trim().replace(/\?+$/, '');
        const subs: Array<{ l: string; q: string }> = [{ l: s.fan.literal, q: str }];
        const m = str.match(/migliore?\s+(.+?)(?:\s+per\s+(.+))?$/i) || str.match(/best\s+(.+?)(?:\s+for\s+(.+))?$/i);
        if (m) {
          const o = m[1];
          const ctx = m[2] || '';
          subs.push({ l: s.fan.criteria, q: 'criteri per scegliere ' + o });
          subs.push({ l: s.fan.compare, q: o + ' confronto modelli 2026' });
          if (ctx) subs.push({ l: s.fan.contextual, q: o + ' consigli per ' + ctx });
          subs.push({ l: s.fan.price, q: 'quanto costa ' + o });
          subs.push({ l: s.fan.reviews, q: 'recensioni ' + o });
        } else {
          subs.push({ l: s.fan.definition, q: 'cosa significa ' + str });
          subs.push({ l: s.fan.deepen, q: str + ' guida completa' });
          subs.push({ l: s.fan.alternatives, q: str + ' alternative a confronto' });
          subs.push({ l: s.fan.fresh, q: str + ' 2026' });
        }
        return subs;
      };
      const run = () => {
        out.style.display = 'block';
        out.innerHTML = '';
        const subs = fan(q.value);
        subs.forEach((sub, i) => {
          const d = document.createElement('div');
          d.className = 'fan-q';
          d.style.animationDelay = i * 0.12 + 's';
          d.innerHTML = '<span class="lbl">↳ ' + sub.l + '</span>' + sub.q;
          out.appendChild(d);
        });
        const n = document.createElement('div');
        n.className = 'fan-q';
        n.style.animationDelay = subs.length * 0.12 + 's';
        n.style.borderLeftColor = 'var(--ink)';
        n.innerHTML = '<span class="lbl" style="color:var(--ink)">→ ' + s.fan.synthesisLbl + '</span>' + s.fan.synthesis(subs.length);
        out.appendChild(n);
      };
      const onGo = () => run();
      const onReset = () => {
        out.style.display = 'none';
        out.innerHTML = '';
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') run();
      };
      go.addEventListener('click', onGo);
      rs.addEventListener('click', onReset);
      q.addEventListener('keydown', onKey);
      cleanups.push(() => go.removeEventListener('click', onGo));
      cleanups.push(() => rs.removeEventListener('click', onReset));
      cleanups.push(() => q.removeEventListener('keydown', onKey));
    })();

    // ---------- DEMO 4 · standard error (Schulte 2026, Table 16) ----------
    (() => {
      const data: Record<number, [number, number]> = {
        1: [0.37, 0.724],
        2: [0.246, 0.483],
        3: [0.188, 0.369],
        4: [0.151, 0.296],
        5: [0.123, 0.241],
        6: [0.101, 0.197],
        7: [0.081, 0.158],
        8: [0.062, 0.121],
        9: [0.041, 0.081],
      };
      const r = $('se-range') as HTMLInputElement | null;
      const nEl = $('se-n');
      const val = $('se-val');
      const ci = $('se-ci');
      const band = $('se-band');
      const v = $('se-verdict');
      if (!r || !nEl || !val || !ci || !band || !v) return;
      const f = (x: number) => (locale === 'it' ? x.toFixed(3).replace('.', ',') : x.toFixed(3));
      const upd = () => {
        const n = +r.value;
        const [se, hw] = data[n];
        nEl.textContent = String(n);
        val.innerHTML = f(se) + '<small>' + s.se.errLabel + '</small>';
        ci.textContent = s.se.ciLabel(f(hw));
        const lo = Math.max(0, 0.5 - hw);
        const hi = Math.min(1, 0.5 + hw);
        (band as HTMLElement).style.left = lo * 100 + '%';
        (band as HTMLElement).style.width = (hi - lo) * 100 + '%';
        let c: string;
        let t: string;
        if (n <= 2) {
          c = 'bad';
          t = s.se.bad(Math.round(lo * 100), Math.round(hi * 100));
        } else if (n <= 6) {
          c = 'warn';
          t = s.se.warn(Math.round(lo * 100), Math.round(hi * 100));
        } else {
          c = 'ok';
          t = s.se.ok;
        }
        v.className = 'se-verdict ' + c;
        v.textContent = t;
      };
      const onInput = () => upd();
      r.addEventListener('input', onInput);
      cleanups.push(() => r.removeEventListener('input', onInput));
      upd();
    })();

    return () => cleanups.forEach((fn) => fn());
  }, [locale]);

  return null;
}
