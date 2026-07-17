import { sql } from '../../db';
import { logger } from '../logger';
import { quoteDisplayTitle } from './format';

const log = logger.child({ scope: 'quote-project' });

// Accepts the raw quotes_v2 row (postgres `Row`); reads id, title, total,
// customer_id, auto_create_project, project_id, project_template.
type QuoteForProject = Record<string, unknown>;

/**
 * A signed quote becomes a "lavoro": create the linked client_projects row
 * (budget = quote total, status 'approved' — contract signed, work not yet
 * started) unless auto_create_project is off, a project is already linked, or
 * the quote has no customer. Mirrors the materials-checklist auto-creation in
 * routes/quotes-v2.ts; failures are logged and never break the signing flow.
 */
export async function ensureProjectForQuote(
  quote: QuoteForProject,
): Promise<{ id: string; name: string } | null> {
  if (!quote.auto_create_project || quote.project_id || !quote.customer_id) return null;

  try {
    let template: Record<string, unknown> = {};
    try {
      const parsed =
        typeof quote.project_template === 'string'
          ? JSON.parse(quote.project_template)
          : quote.project_template;
      if (parsed && typeof parsed === 'object') template = parsed as Record<string, unknown>;
    } catch {
      /* malformed template → defaults */
    }

    const name = String(template.name || '').trim() || quoteDisplayTitle(quote.title) || 'Progetto';
    const [project] = await sql`
      INSERT INTO client_projects (customer_id, name, project_type, status, priority, budget_amount)
      VALUES (
        ${String(quote.customer_id)},
        ${name},
        ${String(template.type || 'website')},
        'approved',
        5,
        ${quote.total ? String(quote.total) : null}
      )
      RETURNING id, name
    `;
    await sql`UPDATE quotes_v2 SET project_id = ${project.id}, updated_at = now() WHERE id = ${String(quote.id)}`;

    log.info({ quoteId: quote.id, projectId: project.id }, 'project auto-created from signed quote');
    return { id: project.id, name: project.name };
  } catch (err) {
    log.error({ err, quoteId: quote.id }, 'auto project creation from signed quote failed');
    return null;
  }
}
