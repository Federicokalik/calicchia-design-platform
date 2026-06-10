/**
 * /llms.txt — indice del sito in formato llmstxt.org convention.
 *
 * Pattern: emette un file markdown flat con tutte le pagine pubbliche
 * (statiche + CMS-driven) come link ai mirror Markdown serviti da
 * `/<path>.md`. ISR 3600s + tag `sitemap` per consentire il revalidate
 * on-demand sincrono con la sitemap quando il CMS pubblica un contenuto.
 *
 * Sezioni:
 *   - Pages: home, contatti, perché, blog list, faq, glossari, zone
 *   - Services: catalogo servizi DB-backed
 *   - Portfolio: progetti pubblicati dall'API
 *   - Blog: post pubblicati
 *   - Optional: legali (più indietro, audience secondaria)
 *
 * Non-goal: non duplica la sitemap.xml (che è strutturata per crawler
 * tradizionali). Qui è LLM-first: testo narrativo, link Markdown.
 */
import { SITE } from '@/data/site';
import { getServiceCatalog, getSeoCities } from '@/lib/cms';
import { fetchAllPublishedProjects } from '@/lib/projects-api';
import { fetchBlogList, buildBlogUrl } from '@/lib/blog-api';

export const revalidate = 3600;

const HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
} as const;

function mdLink(name: string, path: string, suffix = '.md', description?: string): string {
  const url = `${SITE.url}${path}${suffix}`;
  return description ? `- [${name}](${url}): ${description}` : `- [${name}](${url})`;
}

export async function GET(): Promise<Response> {
  const [services, cities, projects, posts] = await Promise.all([
    getServiceCatalog('it').catch(() => ({ all: [] as Array<{ slug: string; title: string; lead: string }> })),
    getSeoCities().catch(() => ({ all: [] as Array<{ slug: string; nome: string; tier: number }> })),
    fetchAllPublishedProjects('it').catch(() => [] as Array<{ slug: string; title: string; description?: string | null }>),
    fetchBlogList(200, 'it').catch(() => [] as Array<{ slug: string; title: string; excerpt?: string | null; published_at?: string | null; created_at?: string | null }>),
  ]);

  const sections: string[] = [];

  sections.push(`# ${SITE.brand} — ${SITE.tagline}`);
  sections.push('');
  sections.push(
    `> Web Designer & Developer Freelance a Frosinone, in Ciociaria. Realizzo siti web, e-commerce, applicazioni web custom, audit di accessibilità (EAA 2025) e migrazioni WordPress/headless per professionisti, PMI e clienti internazionali. Un solo contatto: design + codice + SEO in-house.`,
  );
  sections.push('');
  sections.push(`> Site: <${SITE.url}>  ·  Sitemap: <${SITE.url}/sitemap.xml>  ·  Author: Federico Calicchia (<${SITE.contact.email}>)`);
  sections.push('');
  sections.push(
    '> Markdown access: append `.md` to any page URL, or request any page with the `Accept: text/markdown` header (HTML stays the default for browsers).',
  );
  sections.push('');

  // ─── Main pages ────────────────────────────────────────────────────
  sections.push('## Pages');
  sections.push(mdLink('Home', '/', '.md', 'Federico Calicchia — Web Designer & Developer Freelance'));
  sections.push(mdLink('Portfolio', '/lavori', '.md', 'Case study e lavori realizzati'));
  sections.push(mdLink('Servizi', '/servizi', '.md', 'Web design, sviluppo, e-commerce, SEO, WordPress, accessibilità'));
  sections.push(mdLink('Perché scegliermi', '/perche-scegliere-me', '.md', 'Manifesto, approccio in 5 pilastri, FAQ'));
  sections.push(mdLink('Blog', '/blog', '.md', 'Articoli su web design, sviluppo, SEO, performance'));
  sections.push(mdLink('Contatti', '/contatti', '.md', 'Email, telefono, indirizzo, prenota una call'));
  sections.push(mdLink('FAQ', '/faq', '.md', 'Risposte a 7 domande sul web design freelance'));
  sections.push(mdLink('Servizi per professione', '/servizi-per-professioni', '.md', 'Web design per dentisti, avvocati, ristoratori, e-commerce'));
  sections.push(mdLink('Zone', '/zone', '.md', 'Web designer freelance in Ciociaria e Lazio'));
  sections.push('');

  // ─── Services catalog ─────────────────────────────────────────────
  if (services.all.length > 0) {
    sections.push('## Services');
    for (const svc of services.all) {
      sections.push(mdLink(svc.title, `/servizi/${svc.slug}`, '.md', svc.lead));
    }
    sections.push('');
  }

  // ─── Portfolio ────────────────────────────────────────────────────
  if (projects.length > 0) {
    sections.push('## Portfolio');
    for (const p of projects) {
      sections.push(mdLink(p.title, `/lavori/${p.slug}`, '.md', p.description ?? undefined));
    }
    sections.push('');
  }

  // ─── Blog posts ───────────────────────────────────────────────────
  if (posts.length > 0) {
    sections.push('## Blog');
    for (const post of posts) {
      const path = buildBlogUrl({
        slug: post.slug,
        published_at: post.published_at ?? null,
        created_at: post.created_at ?? null,
      });
      sections.push(mdLink(post.title, path, '.md', post.excerpt ?? undefined));
    }
    sections.push('');
  }

  // ─── Glossari ─────────────────────────────────────────────────────
  sections.push('## Glossaries');
  sections.push(mdLink('Glossario SEO', '/glossario-seo', '.md', 'Termini chiave SEO spiegati senza fumo'));
  sections.push(mdLink('Glossario E-Commerce', '/glossario-e-commerce', '.md', 'Dropshipping, checkout, conversion rate, AOV, CAC, LTV'));
  sections.push(mdLink('Glossario Web Design', '/glossario-web-design', '.md', 'Termini chiave del web design'));
  sections.push('');

  // ─── Local SEO (top-tier cities only) ─────────────────────────────
  const tier1 = cities.all.filter((c) => c.tier === 1).slice(0, 30);
  if (tier1.length > 0) {
    sections.push('## Local pages (Ciociaria / Lazio)');
    for (const city of tier1) {
      sections.push(mdLink(`Web designer a ${city.nome}`, `/zone/${city.slug}`, '.md'));
    }
    sections.push('');
  }

  // ─── Optional / legal ─────────────────────────────────────────────
  sections.push('## Optional');
  sections.push(mdLink('Privacy Policy', '/privacy-policy', '.md'));
  sections.push(mdLink('Cookie Policy', '/cookie-policy', '.md'));
  sections.push(mdLink('Termini e Condizioni', '/termini-e-condizioni', '.md'));
  sections.push(mdLink('DPA Clienti', '/dpa-clienti', '.md'));
  sections.push('');

  sections.push('---');
  sections.push(`Full content bundle (all pages concatenated in one file): <${SITE.url}/llms-full.txt>`);
  sections.push('');

  return new Response(sections.join('\n'), { headers: HEADERS });
}
