/**
 * Publish the article "WordPress nel 2026 e l'IA: ha ancora senso?" (IT + EN).
 *
 * Idempotent: upserts blog_posts on slug, the EN translation rows and the
 * cover in UPLOAD_DIR. Re-running updates the content in place (views and
 * comments are preserved). Charts and the stack quiz are React islands in
 * sito-v3 (components/blog/islands/wp2026) referenced by
 * `<div class="blog-island" data-island="...">` placeholders in the markdown —
 * do not re-save this post from the admin editor without checking they survive.
 *
 * Usage:
 *   pnpm --filter @calicchia/api exec tsx --env-file=../../.env scripts/seed-blog-wordpress-2026.ts
 * In the prod container (UPLOAD_DIR + DATABASE_URL already set):
 *   npx tsx apps/api/scripts/seed-blog-wordpress-2026.ts
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { uploadFile } from '../src/lib/s3';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, 'content', f), 'utf8');

const SLUG = 'wordpress-2026-ia-ha-ancora-senso';
const COVER_KEY = 'blog/wordpress-2026-ia-cover.webp';
const PUBLISHED_AT = '2026-09-25T08:00:00+02:00';

const IT = {
  title: "WordPress nel 2026 e l'IA: ha ancora senso?",
  excerpt:
    "La quota di mercato scende per la prima volta in vent'anni, TypeScript è diventato il linguaggio più usato su GitHub e gli agenti AI iniziano a leggere i siti al posto delle persone. Ho messo in fila i dati per capire quando WordPress ha ancora senso e quando no.",
  content: read('wordpress-2026.it.md'),
};

const EN = {
  title: 'WordPress in 2026 and AI: does it still make sense?',
  excerpt:
    "Market share is falling for the first time in twenty years, TypeScript has become the most used language on GitHub and AI agents are starting to read sites instead of people. I lined up the data to work out when WordPress still makes sense and when it doesn't.",
  content: read('wordpress-2026.en.md'),
};

const sql = postgres(DATABASE_URL, { max: 1 });

async function main() {
  const cover = readFileSync(join(here, 'content', 'wordpress-2026-cover.webp'));
  await uploadFile(cover, COVER_KEY, 'image/webp');

  const [author] = await sql`
    SELECT id FROM profiles WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1
  `;

  const [post] = await sql`
    INSERT INTO blog_posts (
      slug, title, content, excerpt, cover_image, author_id, category, tags,
      is_published, status, allow_comments, reading_time, published_at
    ) VALUES (
      ${SLUG}, ${IT.title}, ${IT.content}, ${IT.excerpt}, ${COVER_KEY},
      ${author?.id ?? null}, 'Sviluppo web',
      ${['WordPress', 'Intelligenza artificiale', 'Next.js', 'Astro', 'Laravel', 'Roots']},
      true, 'published', true, 14, ${PUBLISHED_AT}
    )
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      excerpt = EXCLUDED.excerpt,
      cover_image = EXCLUDED.cover_image,
      category = EXCLUDED.category,
      tags = EXCLUDED.tags,
      is_published = true,
      status = 'published',
      reading_time = EXCLUDED.reading_time,
      updated_at = NOW()
    RETURNING id
  `;

  const rows = (['title', 'excerpt', 'content'] as const).flatMap((field) => [
    { post_id: post.id, locale: 'it', field_name: field, field_value: IT[field] },
    { post_id: post.id, locale: 'en', field_name: field, field_value: EN[field] },
  ]);
  await sql`
    INSERT INTO blog_posts_translations ${sql(rows, 'post_id', 'locale', 'field_name', 'field_value')}
    ON CONFLICT (post_id, locale, field_name) DO UPDATE SET
      field_value = EXCLUDED.field_value,
      updated_at = NOW()
  `;

  console.log(`Published ${SLUG} (${post.id}) — IT + EN, cover ${COVER_KEY}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
