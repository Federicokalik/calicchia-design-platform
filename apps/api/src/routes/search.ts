import { Hono } from 'hono';
import { sql } from '../db';

export const search = new Hono();

search.get('/', async (c) => {
  const query = c.req.query('q') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);

  if (!query || query.length < 2) {
    return c.json({ results: [] });
  }

  const searchTerm = `%${query}%`;

  const [customers, invoices, domains, blogPosts] = await Promise.all([
    sql`
      SELECT id, contact_name, email, company_name FROM customers
      WHERE contact_name ILIKE ${searchTerm} OR email ILIKE ${searchTerm} OR company_name ILIKE ${searchTerm}
      LIMIT ${limit}
    `,
    sql`
      SELECT id, invoice_number, customer_id, status FROM invoices
      WHERE invoice_number ILIKE ${searchTerm}
      LIMIT ${limit}
    `,
    sql`
      SELECT id, domain_name, customer_id, status FROM domains
      WHERE domain_name ILIKE ${searchTerm}
      LIMIT ${limit}
    `,
    sql`
      SELECT id, title, slug, is_published FROM blog_posts
      WHERE title ILIKE ${searchTerm} OR content ILIKE ${searchTerm}
      LIMIT ${limit}
    `,
  ]);

  return c.json({ results: { customers, invoices, domains, blogPosts } });
});

search.get('/fulltext', async (c) => {
  const query = c.req.query('q') || '';
  const table = c.req.query('table') || 'blog_posts';
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  if (!query) return c.json({ results: [] });

  // Only allow known tables with search_vector
  const allowedTables: Record<string, boolean> = { blog_posts: true, projects: true };
  if (!allowedTables[table]) {
    return c.json({ error: 'Tabella non supportata' }, 400);
  }

  let results;
  if (table === 'blog_posts') {
    results = await sql`
      SELECT * FROM blog_posts
      WHERE search_vector @@ websearch_to_tsquery('italian', ${query})
      ORDER BY ts_rank(search_vector, websearch_to_tsquery('italian', ${query})) DESC
      LIMIT ${limit}
    `;
  } else {
    results = await sql`
      SELECT * FROM projects
      WHERE search_vector @@ websearch_to_tsquery('italian', ${query})
      ORDER BY ts_rank(search_vector, websearch_to_tsquery('italian', ${query})) DESC
      LIMIT ${limit}
    `;
  }

  return c.json({ results });
});
