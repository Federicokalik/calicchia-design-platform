/**
 * Segment DSL → SQL.
 *
 * A saved segment (`mkt_segments.definition`) is a small JSON object describing
 * filters over mkt_contacts. This compiles it to a postgres-js fragment that can
 * be embedded as `... WHERE 1=1 ${buildSegmentWhere(def)}`. All values flow
 * through parameter binding (no string interpolation → no SQL injection).
 */

import { sql } from '../../db';
import type { SegmentDefinition } from '@calicchia/shared';

type Fragment = ReturnType<typeof sql>;

/** Chain an array of boolean fragments into ` AND a AND b ...` (empty → ``). */
function andAll(parts: Fragment[]): Fragment {
  return parts.reduce((acc, p) => sql`${acc} AND ${p}`, sql``);
}

export function buildSegmentWhere(def: SegmentDefinition): Fragment {
  const parts: Fragment[] = [];

  if (def.audience_type) parts.push(sql`audience_type = ${def.audience_type}`);

  if (def.email_consent?.length) {
    parts.push(sql`email_consent = ANY(${def.email_consent}::text[])`);
  }
  if (def.wa_consent?.length) {
    parts.push(sql`wa_consent = ANY(${def.wa_consent}::text[])`);
  }
  if (def.tags_any?.length) {
    parts.push(sql`tags && ${def.tags_any}::text[]`);
  }
  if (def.tags_all?.length) {
    parts.push(sql`tags @> ${def.tags_all}::text[]`);
  }
  if (def.industry) parts.push(sql`lower(industry) = ${def.industry.toLowerCase()}`);
  if (def.country) parts.push(sql`lower(country) = ${def.country.toLowerCase()}`);
  if (def.city) parts.push(sql`lower(city) = ${def.city.toLowerCase()}`);
  if (def.has_email === true) parts.push(sql`email IS NOT NULL`);
  if (def.has_email === false) parts.push(sql`email IS NULL`);
  if (def.has_phone === true) parts.push(sql`phone IS NOT NULL`);
  if (def.has_phone === false) parts.push(sql`phone IS NULL`);

  return andAll(parts);
}
