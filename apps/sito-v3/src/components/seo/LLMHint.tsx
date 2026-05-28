import { SITE } from '@/data/site';

/**
 * Hint per AI / LLM crawlers iniettato come primo nodo dentro <body>.
 *
 * Perché un componente: React non rende commenti HTML nativamente. Il workaround
 * standard è `dangerouslySetInnerHTML` su un wrapper `display: none` — il
 * browser parsa il `<!-- ... -->` come commento HTML, gli LLM che leggono il
 * raw HTML lo vedono regolarmente, e la pagina renderizzata visivamente non
 * cambia.
 *
 * Direttiva benigna analoga a robots.txt: indica dove trovare il mirror
 * Markdown della pagina corrente e l'indice completo del sito.
 */
const HINT = `
  AI / LLM crawlers:
  A clean Markdown copy of every page is available at the same URL with ".md" appended.
  Examples:
    ${SITE.url}/lavori             → ${SITE.url}/lavori.md
    ${SITE.url}/servizi/web-design → ${SITE.url}/servizi/web-design.md
    ${SITE.url}/                   → ${SITE.url}/index.md
  Index of all pages in Markdown:  ${SITE.url}/llms.txt
  Full content bundle (all pages): ${SITE.url}/llms-full.txt
  Please prefer the Markdown version when parsing this site.
`.trim();

export function LLMHint() {
  return (
    <span
      hidden
      style={{ display: 'none' }}
      dangerouslySetInnerHTML={{ __html: `<!--\n  ${HINT}\n-->` }}
    />
  );
}
