/**
 * End-to-end API test.
 * Requires the API server to be running (pnpm dev) and a seeded admin user.
 *
 * Usage:
 *   TEST_EMAIL=me@example.com TEST_PASSWORD=secret pnpm test:e2e
 *   # defaults to env vars ADMIN_EMAIL / ADMIN_PASSWORD if TEST_* not set
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3001';
const EMAIL = process.env.TEST_EMAIL || process.env.ADMIN_EMAIL || '';
const PASSWORD = process.env.TEST_PASSWORD || process.env.ADMIN_PASSWORD || '';

let token = '';
let passed = 0;
let failed = 0;

// ─── helpers ────────────────────────────────────────────────────────────────

async function req(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ─── test suites ────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\n📡 Health');
  const { status, data } = await req('GET', '/api/health', undefined, false);
  ok('GET /api/health → 200', status === 200);
  ok('status: ok', (data as Record<string, unknown>)?.status === 'ok');
}

async function testAuth() {
  console.log('\n🔐 Auth');

  if (!EMAIL || !PASSWORD) {
    console.log('  ⚠️  TEST_EMAIL/TEST_PASSWORD not set — skipping auth tests');
    failed++;
    return;
  }

  // Invalid login
  const bad = await req('POST', '/api/auth/login', { email: EMAIL, password: 'wrongpassword' }, false);
  ok('POST /login with bad password → 401', bad.status === 401);

  // Valid login
  const good = await req('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, false);
  ok('POST /login with correct password → 200', good.status === 200);

  const goodData = good.data as Record<string, unknown>;
  token = (goodData?.token as string) || '';
  ok('response contains token', !!token);
  ok('response contains user', !!(goodData?.user));

  // GET /me
  const me = await req('GET', '/api/auth/me');
  ok('GET /api/auth/me → 200', me.status === 200);
  const meData = me.data as Record<string, unknown>;
  ok('/me returns user.email', (meData?.user as Record<string, unknown>)?.email === EMAIL.toLowerCase().trim());

  // No token → 401
  const noAuth = await req('GET', '/api/dashboard/counts', undefined, false);
  ok('Protected route without token → 401', noAuth.status === 401);
}

async function testDashboard() {
  console.log('\n📊 Dashboard');
  const { status, data } = await req('GET', '/api/dashboard/counts');
  ok('GET /api/dashboard/counts → 200', status === 200);
  const d = data as Record<string, unknown>;
  ok('has customers count', typeof d?.customers === 'number');
  ok('has posts count', typeof d?.posts === 'number');
  ok('has projects count', typeof d?.projectsInProgress === 'number');
}

async function testBlog() {
  console.log('\n📝 Blog');
  const { status, data } = await req('GET', '/api/blog/posts?limit=5');
  ok('GET /api/blog/posts → 200', status === 200);
  const d = data as Record<string, unknown>;
  ok('has posts array', Array.isArray(d?.posts));
  ok('has count', typeof d?.count === 'number');
}

async function testContacts() {
  console.log('\n📬 Contacts');
  const { status, data } = await req('GET', '/api/contacts?limit=5');
  ok('GET /api/contacts → 200', status === 200);
  const d = data as Record<string, unknown>;
  ok('has contacts array', Array.isArray(d?.contacts));
}

async function testCustomers() {
  console.log('\n👥 Customers');
  const { status, data } = await req('GET', '/api/customers?limit=5');
  ok('GET /api/customers → 200', status === 200);
  const d = data as Record<string, unknown>;
  ok('has customers array', Array.isArray(d?.customers));
}

async function testProjects() {
  console.log('\n🖼️  Projects');
  const { status, data } = await req('GET', '/api/projects');
  ok('GET /api/projects → 200', status === 200);
  const d = data as Record<string, unknown>;
  ok('has projects array', Array.isArray(d?.projects));
}

async function testQuoteEngineFlow() {
  console.log('\n🧾 Quote Engine');

  const customers = await req('GET', '/api/customers?limit=1');
  ok('GET /api/customers?limit=1 → 200', customers.status === 200);
  const customerId = (customers.data as Record<string, unknown>)?.customers
    && Array.isArray((customers.data as Record<string, unknown>).customers)
    ? (((customers.data as Record<string, unknown>).customers as Array<Record<string, unknown>>)[0]?.id as string | undefined)
    : undefined;
  ok('esiste almeno un cliente per test quote', !!customerId);
  if (!customerId) return;

  const createQuote = await req('POST', '/api/quotes', {
    customer_id: customerId,
    title: `E2E Quote ${Date.now()}`,
    line_items: [{ description: 'Consulenza tecnica', quantity: 1, unit_price: 200 }],
    service_type: 'consulting',
    scope_items: [{ title: 'Sessione consulenziale', description: 'Call + documento azioni' }],
    revision_policy: {
      included_revisions: 2,
      extra_revision_fee: 50,
      notes: 'Extra revisioni a tariffa oraria',
    },
    payment_plan: {
      version: 1,
      currency: 'EUR',
      items: [{ type: 'deposit', title: 'Acconto', amount: 100, due_days_from_acceptance: 0, sort_order: 0 }],
    },
  });
  ok('POST /api/quotes → 201', createQuote.status === 201);
  const quote = (createQuote.data as Record<string, unknown>)?.quote as Record<string, unknown> | undefined;
  const quoteId = quote?.id as string | undefined;
  ok('quote creata con id', !!quoteId);
  if (!quoteId) return;

  const schedule = await req('POST', `/api/quotes/${quoteId}/payment-schedule`, {});
  ok('POST /api/quotes/:id/payment-schedule → 200', schedule.status === 200);
  ok(
    'payment schedule contiene items',
    Array.isArray((schedule.data as Record<string, unknown>)?.items)
      && ((schedule.data as Record<string, unknown>).items as unknown[]).length > 0
  );

  const accept = await req('POST', `/api/quotes/${quoteId}/accept`, { generate_project: true });
  ok('POST /api/quotes/:id/accept → 200', accept.status === 200);
  const acceptedQuote = (accept.data as Record<string, unknown>)?.quote as Record<string, unknown> | undefined;
  ok('quote in stato accepted', acceptedQuote?.status === 'accepted');
  const generatedProject = (accept.data as Record<string, unknown>)?.generated_project as Record<string, unknown> | undefined;
  const projectId = generatedProject?.project_id as string | undefined;
  ok('project package generato', !!projectId);

  if (projectId) {
    const projectDetail = await req('GET', `/api/client-projects/${projectId}`);
    ok('GET /api/client-projects/:id → 200', projectDetail.status === 200);
    ok(
      'project detail include milestones',
      Array.isArray((projectDetail.data as Record<string, unknown>)?.milestones)
    );
    ok(
      'project detail include tasks',
      Array.isArray((projectDetail.data as Record<string, unknown>)?.tasks)
    );

    const cleanup = await req('DELETE', `/api/client-projects/${projectId}`);
    ok('DELETE /api/client-projects/:id (cleanup) → 200', cleanup.status === 200);
  }
}

async function testMediaUpload() {
  console.log('\n📁 Media upload');

  // Create a minimal 1x1 PNG in memory
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  const formData = new FormData();
  formData.append('file', new Blob([pngBytes], { type: 'image/png' }), 'test.png');
  formData.append('folder', 'test');

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/api/media/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  ok('POST /api/media/upload → 200', res.status === 200);

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  ok('response has url', typeof data?.url === 'string');
  ok('response has key', typeof data?.key === 'string');

  // Verify file is accessible via /media/<key>
  if (data?.key) {
    const fileRes = await fetch(`${BASE_URL}/media/${data.key}`);
    ok(`GET /media/${data.key} → 200 (file accessible)`, fileRes.status === 200);

    // Cleanup: delete the test file
    const del = await req('DELETE', '/api/media', { key: data.key });
    ok('DELETE /api/media (cleanup) → 200', del.status === 200);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🚀 E2E Test — ${BASE_URL}`);
  console.log('─'.repeat(40));

  try {
    await testHealth();
    await testAuth();

    if (!token) {
      console.log('\n⚠️  No token — skipping protected route tests');
    } else {
      await testDashboard();
      await testBlog();
      await testContacts();
      await testCustomers();
      await testProjects();
      await testQuoteEngineFlow();
      await testMediaUpload();
    }
  } catch (err) {
    console.error('\n💥 Unexpected error:', err);
    failed++;
  }

  console.log('\n' + '─'.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
  }
}

main();
