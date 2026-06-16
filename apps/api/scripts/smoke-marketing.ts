/**
 * Smoke test for the Email Marketing refinements (personalization + AI copy).
 * Run: pnpm --filter @calicchia/api tsx --env-file=../../.env scripts/smoke-marketing.ts
 * Non-destructive: creates rows with a 'smoke-' prefix and deletes them at the end.
 */
import { sql } from '../src/db';
import { signToken } from '../src/lib/jwt';
import {
  compileCampaignTemplate, renderForMessage, personalize,
} from '../src/lib/email-marketing';

const BASE = process.env.API_URL || 'http://127.0.0.1:3001';
let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function main() {
  console.log('\n🔬 Smoke test — Email Marketing refinements\n');

  // 0) Admin token
  const [admin] = await sql`SELECT id, email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1`;
  if (!admin) throw new Error('no admin user in DB');
  const token = await signToken({ sub: admin.id, email: admin.email, role: 'admin' });
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1) Auth gate
  const noAuth = await fetch(`${BASE}/api/email-marketing/analytics`);
  ok('GET /analytics without token → 401', noAuth.status === 401, `got ${noAuth.status}`);
  const withAuth = await fetch(`${BASE}/api/email-marketing/analytics`, { headers: auth });
  ok('GET /analytics with admin token → 200', withAuth.status === 200, `got ${withAuth.status}`);

  // 2) Seed list + eligible contact (Mario / Acme)
  const [list] = await sql`
    INSERT INTO mkt_lists (name, description) VALUES ('smoke-list', 'smoke test') RETURNING id`;
  const [contact] = await sql`
    INSERT INTO mkt_contacts
      (email, first_name, last_name, company, role, email_consent, email_legal_basis, audience_type, status)
    VALUES ('smoke.mario@example.test', 'Mario', 'Rossi', 'Acme S.r.l.', 'CMO',
            'confirmed', 'consent', 'warm', 'active')
    RETURNING id, unsubscribe_token`;
  await sql`INSERT INTO mkt_list_members (list_id, contact_id) VALUES (${list.id}, ${contact.id})`;

  // 3) Campaign with personalization tokens (created via HTTP → tests POST route)
  const createRes = await fetch(`${BASE}/api/email-marketing/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: 'smoke-campaign', channel: 'email',
      subject: 'Ciao {{nome}}, novità per {{azienda|la tua azienda}}',
      preheader: 'Un saluto da Calicchia Design',
      content_mode: 'blocks',
      content_blocks: { blocks: [
        { type: 'heading', text: 'Ciao {{nome|cliente}}!', level: 2 },
        { type: 'text', text: 'Abbiamo pensato a {{azienda|te}} per un restyling. Ruolo: {{ruolo}}.' },
        { type: 'button', text: 'Prenota una call', url: 'https://calicchia.design/contatti' },
      ] },
      audience_kind: 'list', list_id: list.id,
      track_opens: false, track_clicks: false,
    }),
  });
  const created = await createRes.json();
  ok('POST /campaigns → 201', createRes.status === 201, `got ${createRes.status}`);
  const campaignId = created?.campaign?.id;

  // 4) Personalization rendering (mirrors /test + cron send path)
  const [camp] = await sql`SELECT * FROM mkt_campaigns WHERE id = ${campaignId}`;
  const compiled = await compileCampaignTemplate(camp as never);
  const vars = { first_name: 'Mario', last_name: 'Rossi', company: 'Acme S.r.l.', role: 'CMO', email: 'm@x.it' };
  const rendered = renderForMessage(compiled, { id: contact.id, unsubscribe_token: contact.unsubscribe_token }, vars);
  ok('render resolves {{nome}} → Mario', rendered.includes('Ciao Mario!'));
  ok('render resolves {{azienda}} → Acme', rendered.includes('Acme S.r.l.'));
  ok('render resolves {{ruolo}} → CMO', rendered.includes('Ruolo: CMO'));
  ok('no leftover {{ tokens in body', !rendered.includes('{{'));

  // 4b) personalize() edge cases
  ok('fallback used when value empty', personalize('Ciao {{nome|amico}}', { first_name: '' }) === 'Ciao amico');
  ok('subject personalization', personalize(camp.subject, vars) === 'Ciao Mario, novità per Acme S.r.l.');
  ok('HTML escape on inject', personalize('{{azienda}}', { company: 'A & <b>B</b>' }, { escapeHtml: true }) === 'A &amp; &lt;b&gt;B&lt;/b&gt;');

  // 5) Audience preview (eligible should count our confirmed contact)
  const prev = await fetch(`${BASE}/api/email-marketing/campaigns/${campaignId}/audience-preview`, { headers: auth });
  const prevJson = await prev.json();
  ok('audience-preview eligible ≥ 1', (prevJson?.eligible ?? 0) >= 1, JSON.stringify(prevJson));

  // 6) AI copy generation (real OpenAI — tolerate provider hiccups)
  const aiRes = await fetch(`${BASE}/api/email-marketing/campaigns/ai-generate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ prompt: 'Email breve per promuovere un restyling sito per studi legali, tono professionale', tone: 'professionale' }),
  });
  const aiJson = await aiRes.json().catch(() => ({}));
  if (aiRes.status === 200) {
    ok('AI generate → subject + blocks', !!aiJson.subject && Array.isArray(aiJson.blocks) && aiJson.blocks.length > 0,
      `subject="${(aiJson.subject || '').slice(0, 50)}" blocks=${aiJson.blocks?.length}`);
    const types = new Set((aiJson.blocks || []).map((b: { type: string }) => b.type));
    ok('AI blocks only valid types', [...types].every((t) => ['heading', 'text', 'button', 'image', 'divider', 'spacer'].includes(t as string)),
      [...types].join(','));
  } else {
    console.log(`  ⚠ AI generate returned ${aiRes.status} — ${JSON.stringify(aiJson).slice(0, 120)} (skipped, non-fatal)`);
  }

  // 7) Cleanup
  await sql`DELETE FROM mkt_campaigns WHERE id = ${campaignId}`;
  await sql`DELETE FROM mkt_list_members WHERE list_id = ${list.id}`;
  await sql`DELETE FROM mkt_contacts WHERE id = ${contact.id}`;
  await sql`DELETE FROM mkt_lists WHERE id = ${list.id}`;
  console.log('\n  🧹 cleanup done');

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
  await sql.end({ timeout: 5 });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('smoke test crashed:', err);
  try { await sql.end({ timeout: 5 }); } catch { /* noop */ }
  process.exit(1);
});
