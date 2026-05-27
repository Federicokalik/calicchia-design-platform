import { SITE } from '@/data/site';
import { getSiteConfig } from '@/lib/site-config';
import { fetchBlogList, buildBlogUrl } from '@/lib/blog-api';

/**
 * Feed RSS 2.0 reale — popolato dal blog API (Hono in apps/api).
 * Quando l'API è offline durante il build statico, fetchBlogList torna [];
 * il feed resta vuoto ma valido (non rompe).
 *
 * Audit C-013/C-014: feed brand/description leggono getSiteConfig() così
 * che l'admin possa cambiare il titolo del feed senza redeploy. SITE.url
 * resta dal file (origin di deploy).
 */
export async function GET() {
  const site = await getSiteConfig();
  const base = SITE.url.replace(/\/$/, '');
  const posts = await fetchBlogList(50);

  const items = posts
    .map((post) => {
      const url = `${base}${buildBlogUrl(post)}`;
      const pubDate = post.published_at ?? post.created_at;
      const pubDateRfc = pubDate ? new Date(pubDate).toUTCString() : new Date().toUTCString();
      return `    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pubDateRfc}</pubDate>
      ${post.category ? `<category><![CDATA[${post.category}]]></category>` : ''}
      ${post.excerpt ? `<description><![CDATA[${post.excerpt}]]></description>` : ''}
      <author>noreply@calicchia.design (Federico Calicchia)</author>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${site.brand} — ${site.legalName}</title>
    <link>${base}/blog</link>
    <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml" />
    <description>${site.description}</description>
    <language>it-IT</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=600',
    },
  });
}
