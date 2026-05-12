/**
 * User-defined mail filter rules.
 * First matching active rule (ordered by priority asc) wins.
 * All non-null conditions must match (AND logic). ILIKE patterns; `%` is wildcard.
 */
import { sql } from '../../db';
import type { MailCategory } from './classifier';

export interface MailRule {
  id: string;
  user_id: string;
  name: string;
  priority: number;
  active: boolean;
  match_from: string | null;
  match_subject: string | null;
  match_has_unsubscribe: boolean | null;
  set_category: MailCategory;
}

export async function loadUserRules(userId: string): Promise<MailRule[]> {
  const rows = await sql<MailRule[]>`
    SELECT id, user_id, name, priority, active,
           match_from, match_subject, match_has_unsubscribe, set_category
    FROM email_rules
    WHERE user_id = ${userId} AND active = true
    ORDER BY priority ASC, created_at ASC
  `;
  return rows;
}

export interface RuleInput {
  fromAddr: string | null;
  subject: string | null;
  listUnsubscribe?: boolean;
}

/** Converts an ILIKE pattern (`%@domain.com`) to a JS regex for in-memory matching. */
function ilikeToRegex(pattern: string): RegExp {
  // Escape regex special chars EXCEPT % and _, then replace % → .* and _ → .
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${regex}$`, 'i');
}

export function applyRules(input: RuleInput, rules: MailRule[]): MailCategory | null {
  const from = (input.fromAddr || '').toLowerCase();
  const subj = (input.subject || '');
  const hasUnsub = !!input.listUnsubscribe;

  for (const r of rules) {
    // match_from
    if (r.match_from) {
      if (!ilikeToRegex(r.match_from).test(from)) continue;
    }
    // match_subject
    if (r.match_subject) {
      if (!ilikeToRegex(r.match_subject).test(subj)) continue;
    }
    // match_has_unsubscribe: if set, must equal
    if (r.match_has_unsubscribe !== null && r.match_has_unsubscribe !== undefined) {
      if (r.match_has_unsubscribe !== hasUnsub) continue;
    }
    // All conditions matched
    return r.set_category;
  }
  return null;
}
