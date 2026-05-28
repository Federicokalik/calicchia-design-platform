/**
 * /llms-full.txt — variante "full content" di /llms.txt.
 *
 * Concatena title + description + canonical di ogni pagina pubblica in un
 * unico file markdown. Per LLM che vogliono fare full-index del sito senza
 * dover seguire decine di link `.md` separati.
 *
 * Pragmatic scope: include metadata sintetico per ogni pagina, NON il body
 * completo (che potrebbe pesare megabyte ed essere ridondante col mirror
 * per-pagina). Il body completo è sempre disponibile a `<url>.md` linkato.
 */
import { SITE } from '@/data/site';
import { getServiceCatalog } from '@/lib/cms';
import { fetchAllPublishedProjects } from '@/lib/projects-api';
import { fetchBlogList, buildBlogUrl } from '@/lib/blog-api';

export const revalidate = 3600;

const HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
} as const;

interface Entry {
  title: string;
  description?: string;
  path: string;
}

function block(entry: Entry): string {
  const url = `${SITE.url}${entry.path}`;
  const mdUrl = `${url}.md`;
  const lines = [
    `## ${entry.title}`,
    '',
    `- URL (HTML): <${url}>`,
    `- URL (Markdown mirror): <${mdUrl}>`,
  ];
  if (entry.description) {
    lines.push(`- Description: ${entry.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function GET(): Promise<Response> {
  const [services, projects, posts] = await Promise.all([
    getServiceCatalog('it').catch(() => ({ all: [] as Array<{ slug: string; title: string; lead: string }> })),
    fetchAllPublishedProjects('it').catch(() => [] as Array<{ slug: string; title: string; description?: string | null }>),
    fetchBlogList(200, 'it').catch(() => [] as Array<{ slug: string; title: string; excerpt?: string | null; published_at?: string | null; created_at?: string | null }>),
  ]);

  const out: string[] = [];

  out.push(`# ${SITE.brand} — ${SITE.tagline}`);
  out.push('');
  out.push(
    `> Federico Calicchia, Web Designer & Developer Freelance a Frosinone (Ciociaria). Siti web, e-commerce, sviluppo, SEO, WordPress, accessibilità, manutenzione. Italia + estero.`,
  );
  out.push('');
  out.push(`Site: <${SITE.url}>  ·  Index: <${SITE.url}/llms.txt>  ·  Sitemap: <${SITE.url}/sitemap.xml>`);
  out.push(`Email: ${SITE.contact.email}  ·  Phone: ${SITE.contact.phone}`);
  out.push('');

  // ─── Statics ──────────────────────────────────────────────────────
  out.push('---');
  out.push('# Pagine principali');
  out.push('');
  for (const e of [
    { title: 'Home', path: '/', description: 'Web Designer & Developer Freelance a Frosinone' },
    { title: 'Portfolio', path: '/lavori', description: 'Progetti reali, numeri verificabili, clienti veri' },
    { title: 'Servizi', path: '/servizi', description: 'Web design, e-commerce, sviluppo, SEO, WordPress, accessibilità' },
    { title: 'Perché scegliermi', path: '/perche-scegliere-me', description: 'Manifesto e approccio in 5 pilastri' },
    { title: 'Contatti', path: '/contatti', description: 'Email, telefono, prenota una call' },
    { title: 'Blog', path: '/blog', description: 'Articoli su web design, SEO, performance' },
    { title: 'FAQ', path: '/faq', description: '7 domande frequenti' },
  ] satisfies Entry[]) {
    out.push(block(e));
  }

  // ─── Services ─────────────────────────────────────────────────────
  if (services.all.length > 0) {
    out.push('---');
    out.push('# Servizi');
    out.push('');
    for (const svc of services.all) {
      out.push(block({ title: svc.title, path: `/servizi/${svc.slug}`, description: svc.lead }));
    }
  }

  // ─── Portfolio ────────────────────────────────────────────────────
  if (projects.length > 0) {
    out.push('---');
    out.push('# Portfolio (case study)');
    out.push('');
    for (const p of projects) {
      out.push(block({ title: p.title, path: `/lavori/${p.slug}`, description: p.description ?? undefined }));
    }
  }

  // ─── Blog ─────────────────────────────────────────────────────────
  if (posts.length > 0) {
    out.push('---');
    out.push('# Blog');
    out.push('');
    for (const post of posts) {
      out.push(
        block({
          title: post.title,
          path: buildBlogUrl({
            slug: post.slug,
            published_at: post.published_at ?? null,
            created_at: post.created_at ?? null,
          }),
          description: post.excerpt ?? undefined,
        }),
      );
    }
  }

  out.push('---');
  out.push(`Generated: ${new Date().toISOString()}  ·  Source: <${SITE.url}>`);
  out.push('');

  return new Response(out.join('\n'), { headers: HEADERS });
}
