import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Source whitepaper (bespoke Swiss HTML). Extracts + SCOPES the CSS to `.geo-wp`
// (so it can coexist with the site header/footer) and makes the text full-width.
// CSS is always regenerated; the IT body is only SEEDED (then hand/agent-edited).
const SRC = 'C:/Users/calicchiadesign/Downloads/geo-whitepaper-swiss.html';
const DIR = 'apps/sito-v3/src/data/risorse';

const src = readFileSync(SRC, 'utf8');

// 1) Raw CSS from the first <style> block; drop the Google Fonts @import and map
//    the family-names to the site's self-hosted Funnel CSS variables.
let css = src
  .match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace(/\s*@import url\([^)]*\);\s*/, '\n')
  .replace(/(["'])Funnel Display\1/g, 'var(--font-display)')
  .replace(/(["'])Funnel Sans\1/g, 'var(--font-sans)')
  // strip CSS comments (their commas/braces break the scoper; not needed shipped)
  .replace(/\/\*[\s\S]*?\*\//g, '');

// --- scope every selector under `.geo-wp` so the whitepaper CSS never leaks
// into the site chrome (header/footer/global tags). ---
const ROOT = '.geo-wp';

function splitTopLevel(input) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of input) {
    buf += ch;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        out.push(buf.trim());
        buf = '';
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function scopeSelectorList(selList) {
  return selList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === ':root' || s === 'html' || s === 'body' ? ROOT : `${ROOT} ${s}`))
    .join(',');
}

function scopeRule(rule) {
  const i = rule.indexOf('{');
  if (i === -1) return ''; // stray comment/whitespace
  const prelude = rule.slice(0, i).trim();
  const body = rule.slice(i); // includes braces

  // @keyframes are global — leave untouched.
  if (/^@(-webkit-)?keyframes/.test(prelude)) return rule;

  // @media / @supports — scope each inner rule, keep the at-rule wrapper.
  if (/^@/.test(prelude)) {
    const inner = body.slice(1, body.lastIndexOf('}'));
    const scopedInner = splitTopLevel(inner).map(scopeRule).filter(Boolean).join('\n');
    return `${prelude}{\n${scopedInner}\n}`;
  }

  return `${scopeSelectorList(prelude)}${body}`;
}

css = splitTopLevel(css).map(scopeRule).filter(Boolean).join('\n');

// --- full-width override (user request): drop the editorial reading measure. ---
css += `
/* full-width: niente cap di lettura (68ch/1180px) — richiesta utente 2026-06-16 */
${ROOT} .wrap{max-width:none}
${ROOT} p,${ROOT} .lede,${ROOT} ul,${ROOT} ol,${ROOT} blockquote{max-width:none}
`;

writeFileSync(
  `${DIR}/geo-whitepaper.css.ts`,
  `/**\n * CSS Swiss del white paper, SCOPATO sotto \`.geo-wp\` + full-width.\n * Generato da scripts/gen-geo-whitepaper.mjs — NON modificare a mano.\n */\nexport const GEO_WP_CSS = ${JSON.stringify(css)};\n`,
);
console.log('written geo-whitepaper.css.ts | css chars', css.length);
console.log('scoped under .geo-wp?', css.includes('.geo-wp '));
console.log('bare body/footer rule leaked?', /(^|\n)\s*(body|footer|h2|table)\s*\{/.test(css));

// 2) Seed the IT body ONCE (afterwards it is hand/agent-augmented).
const IT = `${DIR}/geo-whitepaper.it.ts`;
if (!existsSync(IT)) {
  const body = src
    .slice(src.indexOf('<body>') + 6, src.indexOf('<script>'))
    .replace(/<div class="progress" id="progress"><\/div>\s*/, '')
    .replace(/<button class="toc-toggle"[\s\S]*?<\/button>\s*/, '')
    .replace(/<nav class="toc"[\s\S]*?<\/nav>\s*/, '')
    .trim();
  writeFileSync(
    IT,
    `/**\n * Body IT del white paper (markup Swiss + demo). Seed dall'HTML sorgente,\n * poi allineato al markdown esteso. Modificabile a mano.\n */\nexport const GEO_WP_BODY_IT = ${JSON.stringify(body)};\n`,
  );
  console.log('seeded geo-whitepaper.it.ts');
} else {
  console.log('geo-whitepaper.it.ts exists — left untouched');
}
