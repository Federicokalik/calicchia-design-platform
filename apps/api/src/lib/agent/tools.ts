/**
 * Agent Tool Definitions
 *
 * Each tool has: name, description, parameters (JSON Schema), execute function.
 * The LLM sees name+description+parameters and decides which tool to call.
 * The execute function runs the actual logic with DB access.
 *
 * GUARDRAILS:
 * - Tools marked requiresConfirmation cannot execute from admin/telegram chat
 *   unless the user explicitly confirmed (handled by agent core)
 * - SQL queries are whitelisted (no DELETE/DROP/ALTER/TRUNCATE)
 * - Rate limited: max 20 tool calls per minute per channel
 */

import { sql } from '../../db';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskLevel?: 'low' | 'medium' | 'high';
  requiresConfirmation?: boolean; // If true, agent must ask user before executing
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// === GUARDRAILS ===

// SQL safety: block dangerous queries
const BLOCKED_SQL = /\b(DELETE|DROP|TRUNCATE|ALTER|UPDATE\s+users|INSERT\s+INTO\s+users)\b/i;

export function isSqlSafe(query: string): boolean {
  return !BLOCKED_SQL.test(query);
}

// Rate limiting: track calls per channel
const callCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_CALLS_PER_MINUTE = 20;

export function checkRateLimit(channel: string): boolean {
  const now = Date.now();
  const entry = callCounts.get(channel);
  if (!entry || now > entry.resetAt) {
    callCounts.set(channel, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= MAX_CALLS_PER_MINUTE) return false;
  entry.count++;
  return true;
}

// Budget cap: check monthly spend
let budgetCapEur = 20; // default €20/month
export function setBudgetCap(cap: number) { budgetCapEur = cap; }

export async function checkBudgetCap(): Promise<boolean> {
  try {
    const [result] = await sql`
      SELECT COALESCE(SUM(cost_eur), 0)::numeric AS total
      FROM ai_usage_logs
      WHERE created_at > DATE_TRUNC('month', CURRENT_DATE)
    `;
    return parseFloat(result?.total || '0') < budgetCapEur;
  } catch { return true; }
}

export const tools: ToolDefinition[] = [
  // === READ TOOLS ===
  {
    name: 'get_leads',
    description: 'Ottieni la lista dei lead nella pipeline, opzionalmente filtrati per stato',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filtra per stato: new, contacted, proposal, negotiation, won, lost', enum: ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'] },
        limit: { type: 'number', description: 'Numero max risultati (default 10)' },
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;
      const statusFilter = args.status ? sql`AND status = ${args.status as string}` : sql``;
      const rows = await sql`SELECT name, email, company, status, estimated_value, created_at FROM leads WHERE 1=1 ${statusFilter} ORDER BY created_at DESC LIMIT ${limit}`;
      return JSON.stringify({ leads: rows, count: rows.length });
    },
  },
  {
    name: 'get_customers',
    description: 'Cerca clienti per nome, azienda o email',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Termine di ricerca' },
        limit: { type: 'number', description: 'Numero max risultati (default 10)' },
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;
      const search = args.search as string;
      const searchFilter = search
        ? sql`AND (contact_name ILIKE ${'%' + search + '%'} OR company_name ILIKE ${'%' + search + '%'} OR email ILIKE ${'%' + search + '%'})`
        : sql``;
      const rows = await sql`SELECT contact_name, company_name, email, phone, status, total_revenue FROM customers WHERE 1=1 ${searchFilter} ORDER BY updated_at DESC LIMIT ${limit}`;
      return JSON.stringify({ customers: rows, count: rows.length });
    },
  },
  {
    name: 'get_projects',
    description: 'Ottieni la lista dei progetti, opzionalmente filtrati per stato',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filtra: draft, in_progress, review, completed, on_hold' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;
      const statusFilter = args.status ? sql`AND status = ${args.status as string}` : sql``;
      const rows = await sql`SELECT name, status, progress_percentage, customer_name FROM client_projects_view WHERE 1=1 ${statusFilter} ORDER BY updated_at DESC LIMIT ${limit}`;
      return JSON.stringify({ projects: rows, count: rows.length });
    },
  },
  {
    name: 'get_calendar_today',
    description: 'Ottieni gli appuntamenti e eventi di oggi',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const today = new Date().toISOString().split('T')[0];
      const bookings = await sql`SELECT title, start_time, end_time, attendee_name, status FROM cal_bookings WHERE DATE(start_time) = ${today} AND status != 'cancelled' ORDER BY start_time`;
      return JSON.stringify({ events: bookings, date: today });
    },
  },
  {
    name: 'get_revenue_summary',
    description: 'Ottieni il riepilogo revenue (mese corrente e precedente)',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const currentMonth = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'pagata' AND DATE_TRUNC('month', paid_date) = DATE_TRUNC('month', CURRENT_DATE)`;
      const prevMonth = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'pagata' AND DATE_TRUNC('month', paid_date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')`;
      const pending = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'emessa'`;
      return JSON.stringify({
        current_month: parseFloat(currentMonth[0]?.total || '0'),
        previous_month: parseFloat(prevMonth[0]?.total || '0'),
        pending: parseFloat(pending[0]?.total || '0'),
      });
    },
  },
  {
    name: 'get_domains_expiring',
    description: 'Ottieni i domini in scadenza nei prossimi N giorni',
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Giorni (default 30)' } },
    },
    execute: async (args) => {
      const days = (args.days as number) || 30;
      const rows = await sql`SELECT domain_name, expiry_date, auto_renew, customer_id FROM domains WHERE expiry_date <= CURRENT_DATE + ${days} * INTERVAL '1 day' AND expiry_date >= CURRENT_DATE ORDER BY expiry_date`;
      return JSON.stringify({ domains: rows, count: rows.length });
    },
  },
  {
    name: 'get_quotes',
    description: 'Ottieni lista preventivi con filtro opzionale per stato',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'sent', 'viewed', 'signed', 'rejected', 'expired'] },
      },
    },
    execute: async (args) => {
      const statusFilter = args.status ? sql`AND status = ${args.status as string}` : sql``;
      const rows = await sql`SELECT title, status, total, valid_until, created_at FROM quotes_v2 WHERE 1=1 ${statusFilter} ORDER BY created_at DESC LIMIT 10`;
      return JSON.stringify({ quotes: rows, count: rows.length });
    },
  },
  {
    name: 'search_everything',
    description: 'Ricerca globale in clienti, lead, progetti e preventivi',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Termine di ricerca' } },
      required: ['query'],
    },
    execute: async (args) => {
      const q = args.query as string;
      const like = `%${q}%`;
      const [customers, leads, projects, quotes] = await Promise.all([
        sql`SELECT 'cliente' as type, id, contact_name as name, email FROM customers WHERE contact_name ILIKE ${like} OR company_name ILIKE ${like} OR email ILIKE ${like} LIMIT 5`,
        sql`SELECT 'lead' as type, id, name, email FROM leads WHERE name ILIKE ${like} OR email ILIKE ${like} OR company ILIKE ${like} LIMIT 5`,
        sql`SELECT 'progetto' as type, id, name, status FROM client_projects WHERE name ILIKE ${like} LIMIT 5`,
        sql`SELECT 'preventivo' as type, id, title as name, status FROM quotes_v2 WHERE title ILIKE ${like} LIMIT 5`,
      ]);
      return JSON.stringify({ results: [...customers, ...leads, ...projects, ...quotes] });
    },
  },

  // === CUSTOMER / PROJECT READ ===
  {
    name: 'find_customer',
    description: 'Cerca un cliente per nome, email, azienda. Usa prima di create_customer per evitare duplicati.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare in contact_name, company_name, email' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const q = `%${(args.query as string).trim()}%`;
      const rows = await sql`
        SELECT id, contact_name, company_name, email, phone, status, created_at
        FROM customers
        WHERE deleted_at IS NULL
          AND (contact_name ILIKE ${q} OR company_name ILIKE ${q} OR email ILIKE ${q})
        ORDER BY updated_at DESC LIMIT 10
      `;
      return JSON.stringify({ count: rows.length, customers: rows });
    },
  },

  // === WRITE TOOLS ===
  {
    name: 'create_customer',
    description: 'Crea un nuovo cliente. RICHIEDE CONFERMA UTENTE. Prima usa find_customer per evitare duplicati.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Nome del referente/contatto' },
        email: { type: 'string' },
        company_name: { type: 'string', description: 'Nome azienda (opzionale, distinto dal referente)' },
        phone: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['contact_name', 'email'],
    },
    execute: async (args) => {
      const email = (args.email as string).toLowerCase().trim();
      const existing = await sql`SELECT id, contact_name FROM customers WHERE email = ${email} AND deleted_at IS NULL LIMIT 1`;
      if (existing.length > 0) {
        return JSON.stringify({ error: 'Cliente con questa email già esistente', existing: existing[0] });
      }
      const [row] = await sql`
        INSERT INTO customers (contact_name, email, company_name, phone, notes, tags)
        VALUES (
          ${args.contact_name as string},
          ${email},
          ${(args.company_name as string) || null},
          ${(args.phone as string) || null},
          ${(args.notes as string) || null},
          ${JSON.stringify((args.tags as string[]) || [])}::jsonb
        )
        RETURNING id, contact_name, company_name, email
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'create_project',
    description: 'Crea un progetto per un cliente. RICHIEDE CONFERMA. Passa customer_id dal find_customer/create_customer, oppure customer_email per resolve automatico.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente (preferito)' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente da cui risalire all\'id' },
        name: { type: 'string', description: 'Nome del progetto' },
        description: { type: 'string' },
        project_type: { type: 'string', enum: ['website', 'landing_page', 'ecommerce', 'maintenance', 'website_template', 'consulting', 'other'] },
        project_category: { type: 'string', enum: ['grafica', 'web', 'ecommerce', 'webapp', 'marketing', 'consulenza'] },
        status: { type: 'string', enum: ['draft', 'proposal', 'approved', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled'] },
        budget_amount: { type: 'number', description: 'Budget in euro' },
        estimated_hours: { type: 'number' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_end_date: { type: 'string', description: 'YYYY-MM-DD' },
        pipeline_steps: {
          type: 'array', items: { type: 'string' },
          description: 'Fasi del progetto visibili nel portale cliente (es. ["Brief", "Design", "Sviluppo", "Revisione", "Consegna"])',
        },
      },
      required: ['name'],
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      if (!customerId && args.customer_email) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${(args.customer_email as string).toLowerCase().trim()} AND deleted_at IS NULL LIMIT 1`;
        if (!c) return JSON.stringify({ error: 'Cliente non trovato per email; crealo prima con create_customer' });
        customerId = c.id as string;
      }
      if (!customerId) return JSON.stringify({ error: 'customer_id o customer_email richiesto' });

      const [row] = await sql`
        INSERT INTO client_projects (
          customer_id, name, description, project_type, project_category, status,
          budget_amount, estimated_hours, start_date, target_end_date, pipeline_steps
        ) VALUES (
          ${customerId},
          ${args.name as string},
          ${(args.description as string) || null},
          ${(args.project_type as string) || 'other'}::project_type,
          ${(args.project_category as string) || null},
          ${(args.status as string) || 'draft'}::project_status,
          ${(args.budget_amount as number) || null},
          ${(args.estimated_hours as number) || null},
          ${(args.start_date as string) || null},
          ${(args.target_end_date as string) || null},
          ${JSON.stringify((args.pipeline_steps as string[]) || [])}::jsonb
        )
        RETURNING id, name, status, customer_id
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'create_task',
    description: 'Crea un task in un progetto esistente. RICHIEDE CONFERMA. Passa project_id dal create_project o cerca per project_name.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID progetto (preferito)' },
        project_name: { type: 'string', description: 'Alternativa: nome del progetto' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'number', description: '1 (urgente) a 5 (nessuna)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        estimated_hours: { type: 'number' },
      },
      required: ['title'],
    },
    execute: async (args) => {
      let projectId = args.project_id as string | undefined;
      if (!projectId && args.project_name) {
        const [p] = await sql`SELECT id FROM client_projects WHERE name ILIKE ${'%' + (args.project_name as string) + '%'} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`;
        if (!p) return JSON.stringify({ error: 'Progetto non trovato per nome' });
        projectId = p.id as string;
      }
      if (!projectId) return JSON.stringify({ error: 'project_id o project_name richiesto' });

      const [row] = await sql`
        INSERT INTO project_tasks (project_id, title, description, status, priority, due_date, estimated_hours)
        VALUES (
          ${projectId},
          ${args.title as string},
          ${(args.description as string) || null},
          ${(args.status as string) || 'todo'}::task_status,
          ${(args.priority as number) || 5},
          ${(args.due_date as string) || null},
          ${(args.estimated_hours as number) || null}
        )
        RETURNING id, title, status, project_id
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'link_emails_to_customer',
    description: 'Collega tutte le email archiviate contenenti un dato indirizzo (from o to) a un cliente CRM, così compaiono nella sua scheda. Utile dopo create_customer per agganciare lo storico.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente' },
        match_emails: {
          type: 'array', items: { type: 'string' },
          description: 'Indirizzi email da matchare (se vuoto usa customer_email)',
        },
      },
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      let customerEmail = (args.customer_email as string | undefined)?.toLowerCase().trim();
      if (!customerId && customerEmail) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${customerEmail} AND deleted_at IS NULL LIMIT 1`;
        if (!c) return JSON.stringify({ error: 'Cliente non trovato per email' });
        customerId = c.id as string;
      }
      if (!customerId) return JSON.stringify({ error: 'customer_id o customer_email richiesto' });

      if (!customerEmail) {
        const [c] = await sql`SELECT email FROM customers WHERE id = ${customerId} LIMIT 1`;
        customerEmail = (c?.email as string | undefined)?.toLowerCase().trim();
      }

      const matchList = ((args.match_emails as string[] | undefined) || [])
        .map((e) => e.toLowerCase().trim())
        .filter(Boolean);
      if (customerEmail) matchList.push(customerEmail);
      if (matchList.length === 0) return JSON.stringify({ error: 'Nessuna email da matchare' });

      const messages = await sql<Array<{ id: string }>>`
        SELECT id FROM email_messages
        WHERE LOWER(from_addr) = ANY(${matchList})
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(to_addrs) AS t
             WHERE LOWER(t->>'address') = ANY(${matchList})
           )
      `;
      let linked = 0;
      for (const m of messages) {
        const res = await sql`
          INSERT INTO email_links (message_id, entity_type, entity_id, auto)
          VALUES (${m.id}, 'cliente', ${customerId}, false)
          ON CONFLICT (message_id, entity_type, entity_id) DO NOTHING
          RETURNING id
        `;
        if (res.length > 0) linked++;
      }
      return JSON.stringify({ scanned: messages.length, linked });
    },
  },
  {
    name: 'create_lead',
    description: 'Crea un nuovo lead nella pipeline. RICHIEDE CONFERMA UTENTE.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome completo' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
        estimated_value: { type: 'number', description: 'Valore stimato in euro' },
        source: { type: 'string', enum: ['manual', 'website_form', 'calcom', 'referral'] },
      },
      required: ['name'],
    },
    execute: async (args) => {
      const rows = await sql`INSERT INTO leads (name, email, phone, company, estimated_value, source) VALUES (${args.name as string}, ${(args.email as string) || null}, ${(args.phone as string) || null}, ${(args.company as string) || null}, ${(args.estimated_value as number) || null}, ${(args.source as string) || 'manual'}) RETURNING id, name, status`;
      return JSON.stringify({ created: rows[0] });
    },
  },
  {
    name: 'update_lead_status',
    description: 'Aggiorna lo stato di un lead nella pipeline',
    parameters: {
      type: 'object',
      properties: {
        lead_name: { type: 'string', description: 'Nome del lead da cercare' },
        status: { type: 'string', enum: ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'] },
      },
      required: ['lead_name', 'status'],
    },
    execute: async (args) => {
      const rows = await sql`UPDATE leads SET status = ${args.status as string}, updated_at = now() WHERE name ILIKE ${'%' + (args.lead_name as string) + '%'} RETURNING id, name, status`;
      if (!rows.length) return JSON.stringify({ error: 'Lead non trovato' });
      return JSON.stringify({ updated: rows[0] });
    },
  },
  {
    name: 'send_whatsapp',
    description: 'Invia un messaggio WhatsApp a un numero di telefono. RICHIEDE CONFERMA UTENTE.',
    riskLevel: 'high',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Numero telefono (con prefisso, es +39...)' },
        message: { type: 'string', description: 'Testo del messaggio' },
      },
      required: ['phone', 'message'],
    },
    execute: async (args) => {
      try {
        const { sendWhatsAppText } = await import('../whatsapp');
        await sendWhatsAppText(args.phone as string, args.message as string);
        return JSON.stringify({ sent: true });
      } catch (err) {
        return JSON.stringify({ error: 'WhatsApp non configurato o errore invio' });
      }
    },
  },
  {
    name: 'send_email',
    description: 'Invia un\'email. RICHIEDE CONFERMA UTENTE.',
    riskLevel: 'high',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Indirizzo email destinatario' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Corpo email in HTML' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async (args) => {
      try {
        const { sendEmail } = await import('../email');
        await sendEmail({ to: args.to as string, subject: args.subject as string, html: args.body as string });
        return JSON.stringify({ sent: true });
      } catch (err) {
        return JSON.stringify({ error: 'Errore invio email' });
      }
    },
  },
  {
    name: 'generate_email',
    description: 'Genera il testo di un\'email professionale. NON la invia, restituisce solo il testo.',
    riskLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Tipo: follow_up, proposta, ringraziamento, sollecito', enum: ['follow_up', 'proposta', 'ringraziamento', 'sollecito'] },
        destinatario: { type: 'string', description: 'Nome del destinatario' },
        contesto: { type: 'string', description: 'Contesto aggiuntivo (progetto, servizio, ecc.)' },
      },
      required: ['tipo', 'destinatario'],
    },
    execute: async (args) => {
      // This will be handled by the LLM itself, not a DB tool
      return JSON.stringify({
        note: 'Genera il testo email basandoti su tipo, destinatario e contesto forniti. Scrivi in italiano, tono professionale ma cordiale.',
        tipo: args.tipo,
        destinatario: args.destinatario,
        contesto: args.contesto || '',
      });
    },
  },
  {
    name: 'create_project_from_quote',
    description: 'Crea un progetto completo con task a partire da un preventivo. L\'AI analizza le voci del preventivo e genera task dettagliati con stime di ore per ognuno.',
    riskLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        quote_id: { type: 'string', description: 'ID del preventivo da cui creare il progetto' },
      },
      required: ['quote_id'],
    },
    execute: async (args) => {
      const { generateText } = await import('./llm-router');

      // Get quote data
      const quotes = await sql`
        SELECT q.*, c.contact_name, c.company_name, c.id as cust_id
        FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id
        WHERE q.id = ${args.quote_id as string}
      `;
      if (!quotes.length) return JSON.stringify({ error: 'Preventivo non trovato' });

      const quote = quotes[0];
      const items = typeof quote.items === 'string' ? JSON.parse(quote.items) : (quote.items || []);

      // AI generates tasks from quote items
      const prompt = `Analizza questo preventivo e genera una lista di task dettagliati per completare il progetto.

Preventivo: ${quote.title}
Cliente: ${quote.contact_name} (${quote.company_name || ''})
Voci:
${items.map((i: any) => `- ${i.description}: €${i.total}`).join('\n')}

Per ogni task genera JSON con questa struttura (rispondi SOLO con JSON array, niente altro):
[{"title":"Nome task","description":"Breve desc","estimated_hours":4,"priority":5,"sort_order":1}]

Genera 5-12 task specifici e concreti. Le ore stimate devono essere realistiche per un web designer freelance.`;

      const result = await generateText('task_breakdown', [
        { role: 'system', content: 'Rispondi SOLO con JSON array valido.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.4 });

      let tasks: any[] = [];
      try {
        const match = result.match(/\[[\s\S]*\]/);
        tasks = match ? JSON.parse(match[0]) : [];
      } catch { tasks = []; }

      if (!tasks.length) return JSON.stringify({ error: 'AI non ha generato task validi', raw: result.slice(0, 300) });

      // Calculate total hours and timeline
      const totalHours = tasks.reduce((s: number, t: any) => s + (t.estimated_hours || 0), 0);
      const workDays = Math.ceil(totalHours / 6); // 6 ore/giorno produttive
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + workDays * 24 * 60 * 60 * 1000);

      // Create project
      const [project] = await sql`
        INSERT INTO client_projects (customer_id, name, project_type, status, priority, start_date, target_end_date, estimated_hours, budget_amount)
        VALUES (
          ${quote.cust_id || null},
          ${quote.title},
          'website',
          'draft',
          5,
          ${startDate.toISOString().split('T')[0]},
          ${endDate.toISOString().split('T')[0]},
          ${totalHours},
          ${quote.total || null}
        )
        RETURNING id, name
      `;

      // Create tasks
      for (const task of tasks) {
        await sql`
          INSERT INTO project_tasks (project_id, title, description, status, priority, estimated_hours, sort_order)
          VALUES (${project.id}, ${task.title}, ${task.description || null}, 'todo', ${task.priority || 5}, ${task.estimated_hours || 0}, ${task.sort_order || 0})
        `;
      }

      // Link quote to project
      await sql`UPDATE quotes_v2 SET project_id = ${project.id} WHERE id = ${args.quote_id as string}`;

      return JSON.stringify({
        created: true,
        project_id: project.id,
        project_name: project.name,
        tasks_count: tasks.length,
        total_hours: totalHours,
        estimated_days: workDays,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        message: `Progetto "${project.name}" creato con ${tasks.length} task (${totalHours}h stimate, ~${workDays} giorni lavorativi).`,
      });
    },
  },
  {
    name: 'generate_quote',
    description: 'Genera un preventivo completo con AI. Crea le voci, i prezzi, la premessa personalizzata e lo salva come bozza nel gestionale. RICHIEDE CONFERMA UTENTE.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Nome del cliente' },
        company: { type: 'string', description: 'Nome azienda' },
        services: { type: 'string', description: 'Servizi richiesti (es. sito web, e-commerce, logo)' },
        budget: { type: 'string', description: 'Budget indicativo (es. 2000-3000€)' },
        website: { type: 'string', description: 'Sito web attuale del cliente (opzionale, per ricerca)' },
        notes: { type: 'string', description: 'Note aggiuntive, report, info sul cliente' },
      },
      required: ['client_name', 'services'],
    },
    execute: async (args) => {
      const { generateText } = await import('./llm-router');

      // Load pricing KB for accurate prices
      let pricingContext = '';
      try {
        const { readFileSync } = await import('fs');
        const { resolve, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __dir = dirname(fileURLToPath(import.meta.url));
        pricingContext = readFileSync(resolve(__dir, 'pricing_knowledge_base.md'), 'utf-8').slice(0, 4000);
      } catch {}

      const prompt = `Sei Federico Calicchia, web designer freelance. Genera un preventivo usando i prezzi ESATTI dal listino.

LISTINO PREZZI (usa QUESTI prezzi, non inventare):
${pricingContext || 'One Page: da €799 | Multipage: da €1.199 | Taylored: da €1.579 | E-commerce: da €3.799 | Web App: €4.500-6.000 | SEO: €149-299 | Hosting VPS: €169-249/anno'}

Cliente: ${args.client_name} (${args.company || ''})
Servizi richiesti: ${args.services}
Budget indicativo: ${args.budget || 'da definire'}
Note: ${args.notes || 'nessuna'}

REGOLE PRICING:
- Usa i prezzi del listino, NON inventare
- Includi sempre hosting se è un sito nuovo
- Mostra sconto 10% per pagamento anticipato
- MINIMI 2026: One Page €799, Multipage €1.199

Rispondi SOLO con JSON valido:
{"title":"Titolo preventivo","description":"Preventivo e Contratto di Incarico","items":[{"description":"Nome servizio","quantity":1,"unit_price":749,"total":749}],"notes":"Note per il cliente (regime forfettario, marca da bollo se >77.47€)","premessa":"Premessa personalizzata 2-3 righe"}`;

      const result = await generateText('task_breakdown', [
        { role: 'system', content: 'Rispondi SOLO con JSON valido, niente altro testo.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.5 });

      // Parse JSON
      let quoteData: any;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        quoteData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch { quoteData = null; }

      if (!quoteData) return JSON.stringify({ error: 'AI non ha generato JSON valido', raw: result.slice(0, 500) });

      // Step 2: Save to DB
      const items = quoteData.items || [];
      const total = items.reduce((s: number, i: any) => s + (i.total || 0), 0);

      const rows = await sql`
        INSERT INTO quotes_v2 (title, description, items, subtotal, total, notes, internal_notes)
        VALUES (
          ${quoteData.title || `Preventivo ${args.client_name}`},
          ${quoteData.description || 'Preventivo e Contratto di Incarico'},
          ${JSON.stringify(items)},
          ${total}, ${total},
          ${quoteData.notes || null},
          ${'Generato da AI. Premessa: ' + (quoteData.premessa || '')}
        )
        RETURNING id, title, total
      `;

      return JSON.stringify({
        created: true,
        quote_id: rows[0].id,
        title: rows[0].title,
        total: rows[0].total,
        items_count: items.length,
        message: `Preventivo "${rows[0].title}" creato come bozza (€${total}). Vai su /preventivi/${rows[0].id} per revisione.`,
      });
    },
  },
  {
    name: 'summarize_week',
    description: 'Ottieni un riepilogo dell\'attività della settimana corrente',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
      const ws = weekStart.toISOString().split('T')[0];

      const [newLeads, signedQuotes, completedTasks, revenue] = await Promise.all([
        sql`SELECT COUNT(*)::int as count FROM leads WHERE created_at >= ${ws}`,
        sql`SELECT COUNT(*)::int as count FROM quotes_v2 WHERE signed_at >= ${ws}`,
        sql`SELECT COUNT(*)::int as count FROM project_tasks WHERE completed_at >= ${ws}`,
        sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'pagata' AND paid_date >= ${ws}`,
      ]);

      return JSON.stringify({
        week_start: ws,
        new_leads: newLeads[0]?.count || 0,
        signed_quotes: signedQuotes[0]?.count || 0,
        completed_tasks: completedTasks[0]?.count || 0,
        revenue: parseFloat(revenue[0]?.total || '0'),
      });
    },
  },

  // ── Knowledge: Note ──
  {
    name: 'create_note',
    description: "Crea una nota nel Knowledge Base / Second Brain. Usalo quando l'utente vuole annotare qualcosa, salvare un'idea, registrare info, o prendere appunti.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo della nota' },
        content: { type: 'string', description: 'Contenuto in testo/markdown' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag opzionali' },
        linked_type: { type: 'string', enum: ['project', 'customer'], description: 'Tipo entità collegata (opzionale)' },
        linked_id: { type: 'string', description: 'ID entità collegata (opzionale)' },
      },
      required: ['title', 'content'],
    },
    execute: async (args: Record<string, unknown>) => {
      const [note] = await sql`
        INSERT INTO notes (title, raw_markdown, source, tags, linked_type, linked_id)
        VALUES (
          ${args.title as string},
          ${args.content as string},
          'agent',
          ${(args.tags as string[]) || []},
          ${(args.linked_type as string) || null},
          ${(args.linked_id as string) || null}
        ) RETURNING id, title
      `;
      return JSON.stringify({ created: true, note_id: note.id, title: note.title });
    },
  },
  {
    name: 'search_notes',
    description: 'Cerca tra le note del Knowledge Base per parola chiave o tag.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare' },
        tag: { type: 'string', description: 'Filtra per tag' },
      },
      required: [],
    },
    execute: async (args: Record<string, unknown>) => {
      const searchFilter = args.query
        ? sql`AND (title ILIKE ${'%' + args.query + '%'} OR raw_markdown ILIKE ${'%' + args.query + '%'})`
        : sql``;
      const tagFilter = args.tag ? sql`AND ${args.tag as string} = ANY(tags)` : sql``;
      const notes = await sql`
        SELECT id, title, LEFT(raw_markdown, 200) AS preview, tags, source, created_at
        FROM notes WHERE 1=1 ${searchFilter} ${tagFilter}
        ORDER BY updated_at DESC LIMIT 10
      `;
      return JSON.stringify({ count: notes.length, notes });
    },
  },

  // === EMAIL TOOLS ===
  {
    name: 'list_recent_emails',
    description: 'Elenca le email più recenti. Per default: sia ricevute (INBOX) sia inviate (Sent). Usa direction="received" per solo ricevute, "sent" per solo inviate.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Giorni indietro (default 3)' },
        limit: { type: 'number', description: 'Max risultati (default 15, max 50)' },
        direction: {
          type: 'string',
          enum: ['received', 'sent', 'both'],
          description: 'Filtra per direzione. Default: both (ricevute + inviate)',
        },
      },
    },
    execute: async (args) => {
      const days = Math.max(1, Math.min((args.days as number) || 3, 60));
      const limit = Math.max(1, Math.min((args.limit as number) || 15, 50));
      const direction = (args.direction as string) || 'both';

      let folderFilter;
      if (direction === 'received') {
        folderFilter = sql`AND m.folder = 'INBOX'`;
      } else if (direction === 'sent') {
        folderFilter = sql`AND m.folder = COALESCE(a.sent_folder, 'Sent')`;
      } else {
        folderFilter = sql`AND (m.folder = 'INBOX' OR m.folder = COALESCE(a.sent_folder, 'Sent'))`;
      }

      const rows = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at,
               m.has_attachments, m.flags, m.folder, a.email AS account_email,
               CASE WHEN m.folder = 'INBOX' THEN 'received' ELSE 'sent' END AS direction
        FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id
        WHERE m.received_at > now() - (${days} || ' days')::interval
        ${folderFilter}
        ORDER BY m.received_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, days, direction, emails: rows });
    },
  },
  {
    name: 'search_emails',
    description: 'Cerca nelle email per testo (oggetto, mittente, anteprima). Usa per "email da mario", "email su progetto X", ecc.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare in subject, from, snippet, body_text' },
        days: { type: 'number', description: 'Limite temporale in giorni (default 90)' },
        limit: { type: 'number', description: 'Max risultati (default 15)' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const q = (args.query as string).trim();
      if (!q) return JSON.stringify({ error: 'query vuota' });
      const days = Math.max(1, Math.min((args.days as number) || 90, 365));
      const limit = Math.max(1, Math.min((args.limit as number) || 15, 30));
      const like = `%${q}%`;
      const rows = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at, m.folder,
               a.email AS account_email
        FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id
        WHERE m.received_at > now() - (${days} || ' days')::interval
          AND (
            m.subject ILIKE ${like}
            OR m.from_addr ILIKE ${like}
            OR m.from_name ILIKE ${like}
            OR m.snippet ILIKE ${like}
            OR m.body_text ILIKE ${like}
          )
        ORDER BY m.received_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, query: q, emails: rows });
    },
  },
  {
    name: 'read_email',
    description: 'Leggi il contenuto completo (testo + mittente + data) di una email specifica. Passa id email restituito da list_recent_emails o search_emails.',
    parameters: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'UUID email (id dalla lista)' },
      },
      required: ['email_id'],
    },
    execute: async (args) => {
      const id = args.email_id as string;
      const [msg] = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.to_addrs, m.subject, m.received_at,
               m.body_text, m.has_attachments,
               a.email AS account_email,
               (
                 SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'filename', at.filename, 'content_type', at.content_type, 'size_bytes', at.size_bytes
                 )), '[]'::jsonb)
                 FROM email_attachments at WHERE at.message_id = m.id
               ) AS attachments
        FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id
        WHERE m.id = ${id}
        LIMIT 1
      `;
      if (!msg) return JSON.stringify({ error: 'Email non trovata' });
      // Truncate body to keep token usage sane
      const body = (msg.body_text as string | null) || '';
      return JSON.stringify({
        ...msg,
        body_text: body.slice(0, 4000),
        body_truncated: body.length > 4000,
      });
    },
  },
  {
    name: 'draft_email',
    description: 'Crea una BOZZA email pronta da rivedere e inviare. NON invia direttamente - crea un link cliccabile che apre la finestra di invio pre-compilata. Usa SEMPRE questo tool quando l\'utente chiede di "scrivere/rispondere/inviare" una email. Se è una risposta, passa reply_to_email_id per mantenere il thread.',
    riskLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destinatario principale (email). Più destinatari separati da virgola.' },
        cc: { type: 'string', description: 'CC opzionale, virgole.' },
        subject: { type: 'string', description: 'Oggetto dell\'email.' },
        body: { type: 'string', description: 'Corpo del messaggio in testo semplice. Includi saluto e firma.' },
        reply_to_email_id: { type: 'string', description: 'Opzionale: UUID di una email esistente cui si sta rispondendo (per mantenere il thread).' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async (args) => {
      const to = (args.to as string).split(',').map((s) => s.trim()).filter(Boolean);
      const cc = (args.cc as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

      // Resolve user + active account (single-user assumption)
      const [acc] = await sql`
        SELECT id, user_id FROM email_accounts WHERE active = true ORDER BY created_at ASC LIMIT 1
      `;
      if (!acc) return JSON.stringify({ error: 'Nessun account email configurato. Configura prima la casella in /posta.' });

      // If replying, fetch the target email to thread correctly
      let inReplyToMsgid: string | null = null;
      let replyToMessageId: string | null = null;
      if (args.reply_to_email_id) {
        const [ref] = await sql`
          SELECT m.id, m.message_id
          FROM email_messages m
          JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${acc.user_id}
          WHERE m.id = ${args.reply_to_email_id as string}
          LIMIT 1
        `;
        if (ref) {
          inReplyToMsgid = (ref.message_id as string | null) || null;
          replyToMessageId = ref.id as string;
        }
      }

      const [draft] = await sql`
        INSERT INTO email_drafts (
          user_id, account_id, to_addrs, cc_addrs, subject, body,
          in_reply_to_msgid, reply_to_message_id, source
        ) VALUES (
          ${acc.user_id}, ${acc.id},
          ${JSON.stringify(to)}::jsonb,
          ${JSON.stringify(cc)}::jsonb,
          ${args.subject as string}, ${args.body as string},
          ${inReplyToMsgid}, ${replyToMessageId}, 'ai'
        )
        RETURNING id
      `;

      return JSON.stringify({
        status: 'drafted',
        draft_id: draft.id,
        open_url: `/posta?draft=${draft.id}`,
        message: `Bozza creata. Apri [questa bozza](/posta?draft=${draft.id}) per revisionare e inviare.`,
      });
    },
  },
  {
    name: 'emails_for_entity',
    description: 'Trova tutte le email linkate a un cliente/lead/progetto (match automatico per email o link manuale). Usa per "che email ho scambiato con Rossi", "email del progetto X".',
    parameters: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['cliente', 'lead', 'preventivo', 'progetto', 'collaboratore'] },
        entity_id: { type: 'string', description: 'UUID dell\'entità' },
        limit: { type: 'number', description: 'Max risultati (default 20)' },
      },
      required: ['entity_type', 'entity_id'],
    },
    execute: async (args) => {
      const entityType = args.entity_type as string;
      const entityId = args.entity_id as string;
      const limit = Math.max(1, Math.min((args.limit as number) || 20, 50));
      const rows = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at,
               l.auto AS link_auto
        FROM email_links l
        JOIN email_messages m ON m.id = l.message_id
        WHERE l.entity_type = ${entityType} AND l.entity_id = ${entityId}
        ORDER BY m.received_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, entity_type: entityType, emails: rows });
    },
  },

  // === CRM UPDATE TOOLS ===
  {
    name: 'update_customer',
    description: 'Aggiorna un cliente esistente (status, contatti, note, tag). RICHIEDE CONFERMA. Passa customer_id oppure customer_email.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente (preferito)' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente' },
        contact_name: { type: 'string' },
        company_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        status: { type: 'string', description: 'Stato cliente (es: active, vip, churned, prospect)' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      if (!customerId && args.customer_email) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${(args.customer_email as string).toLowerCase().trim()} AND deleted_at IS NULL LIMIT 1`;
        if (!c) return JSON.stringify({ error: 'Cliente non trovato per email' });
        customerId = c.id as string;
      }
      if (!customerId) return JSON.stringify({ error: 'customer_id o customer_email richiesto' });

      const updates: Record<string, unknown> = {};
      if (args.contact_name !== undefined) updates.contact_name = args.contact_name;
      if (args.company_name !== undefined) updates.company_name = args.company_name;
      if (args.email !== undefined) updates.email = (args.email as string).toLowerCase().trim();
      if (args.phone !== undefined) updates.phone = args.phone;
      if (args.status !== undefined) updates.status = args.status;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.tags !== undefined) updates.tags = JSON.stringify(args.tags as string[]);
      updates.updated_at = new Date().toISOString();
      if (Object.keys(updates).length === 1) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      const [row] = await sql`UPDATE customers SET ${sql(updates)} WHERE id = ${customerId} AND deleted_at IS NULL RETURNING id, contact_name, company_name, email, status`;
      if (!row) return JSON.stringify({ error: 'Aggiornamento fallito' });
      return JSON.stringify({ updated: row });
    },
  },
  {
    name: 'update_project',
    description: 'Aggiorna un progetto cliente (status, titolo, date, budget, descrizione). RICHIEDE CONFERMA. Passa project_id oppure project_name per risolvere.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        project_name: { type: 'string', description: 'Alternativa: nome progetto' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'proposal', 'approved', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled'] },
        priority: { type: 'number', description: '1 (urgente) - 5 (bassa)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_end_date: { type: 'string', description: 'YYYY-MM-DD' },
        budget_amount: { type: 'number' },
        estimated_hours: { type: 'number' },
      },
    },
    execute: async (args) => {
      let projectId = args.project_id as string | undefined;
      if (!projectId && args.project_name) {
        const [p] = await sql`SELECT id FROM client_projects WHERE name ILIKE ${'%' + (args.project_name as string) + '%'} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`;
        if (!p) return JSON.stringify({ error: 'Progetto non trovato per nome' });
        projectId = p.id as string;
      }
      if (!projectId) return JSON.stringify({ error: 'project_id o project_name richiesto' });

      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.start_date !== undefined) updates.start_date = args.start_date;
      if (args.target_end_date !== undefined) updates.target_end_date = args.target_end_date;
      if (args.budget_amount !== undefined) updates.budget_amount = args.budget_amount;
      if (args.estimated_hours !== undefined) updates.estimated_hours = args.estimated_hours;
      updates.updated_at = new Date().toISOString();
      if (Object.keys(updates).length === 1) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      const [row] = await sql`UPDATE client_projects SET ${sql(updates)} WHERE id = ${projectId} AND deleted_at IS NULL RETURNING id, name, status`;
      if (!row) return JSON.stringify({ error: 'Aggiornamento fallito' });
      return JSON.stringify({ updated: row });
    },
  },
  {
    name: 'update_task',
    description: 'Aggiorna un task (status, titolo, scadenza, priorità). RICHIEDE CONFERMA. Passa task_id oppure task_title per risolvere.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        task_title: { type: 'string', description: 'Alternativa: titolo task (match ILIKE)' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        estimated_hours: { type: 'number' },
      },
    },
    execute: async (args) => {
      let taskId = args.task_id as string | undefined;
      if (!taskId && args.task_title) {
        const [t] = await sql`SELECT id FROM project_tasks WHERE title ILIKE ${'%' + (args.task_title as string) + '%'} ORDER BY updated_at DESC LIMIT 1`;
        if (!t) return JSON.stringify({ error: 'Task non trovato per titolo' });
        taskId = t.id as string;
      }
      if (!taskId) return JSON.stringify({ error: 'task_id o task_title richiesto' });

      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) {
        updates.status = args.status;
        if (args.status === 'done') updates.completed_at = new Date().toISOString();
      }
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.due_date !== undefined) updates.due_date = args.due_date;
      if (args.estimated_hours !== undefined) updates.estimated_hours = args.estimated_hours;
      updates.updated_at = new Date().toISOString();
      if (Object.keys(updates).length === 1) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      const [row] = await sql`UPDATE project_tasks SET ${sql(updates)} WHERE id = ${taskId} RETURNING id, title, status`;
      if (!row) return JSON.stringify({ error: 'Aggiornamento fallito' });
      return JSON.stringify({ updated: row });
    },
  },

  // === APPUNTAMENTI (cal_bookings) ===
  {
    name: 'create_cal_booking',
    description: 'Crea un appuntamento/meeting interno (tabella cal_bookings). Usa quando l\'utente dice "prendi appuntamento", "crea meeting", "fissa call". RICHIEDE CONFERMA.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo meeting/appuntamento' },
        start_time: { type: 'string', description: 'ISO 8601 (es. 2026-04-25T15:00:00+02:00)' },
        end_time: { type: 'string', description: 'ISO 8601. Se omesso viene calcolato con duration_minutes (default 60).' },
        duration_minutes: { type: 'number', description: 'Alternativa a end_time (default 60)' },
        attendee_name: { type: 'string' },
        attendee_email: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string', description: 'Indirizzo o link meeting' },
      },
      required: ['title', 'start_time'],
    },
    execute: async (args) => {
      const startStr = args.start_time as string;
      const start = new Date(startStr);
      if (isNaN(start.getTime())) return JSON.stringify({ error: 'start_time non valido (usa ISO 8601)' });
      let end: Date;
      if (args.end_time) {
        end = new Date(args.end_time as string);
        if (isNaN(end.getTime())) return JSON.stringify({ error: 'end_time non valido' });
      } else {
        const dur = (args.duration_minutes as number) || 60;
        end = new Date(start.getTime() + dur * 60_000);
      }
      const durationMin = Math.round((end.getTime() - start.getTime()) / 60_000);
      const bookingUid = `mcp-${crypto.randomUUID()}`;

      const [row] = await sql`
        INSERT INTO cal_bookings (
          booking_uid, title, description, start_time, end_time, duration_minutes,
          attendee_name, attendee_email, location, status
        ) VALUES (
          ${bookingUid},
          ${args.title as string},
          ${(args.description as string) || null},
          ${start.toISOString()},
          ${end.toISOString()},
          ${durationMin},
          ${(args.attendee_name as string) || null},
          ${(args.attendee_email as string) || null},
          ${(args.location as string) || null},
          'upcoming'
        )
        RETURNING id, title, start_time, end_time, attendee_name, status
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'update_cal_booking',
    description: 'Modifica un appuntamento esistente (orario, titolo, note, partecipanti). RICHIEDE CONFERMA.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: 'UUID booking' },
        title: { type: 'string' },
        start_time: { type: 'string', description: 'ISO 8601' },
        end_time: { type: 'string', description: 'ISO 8601' },
        attendee_name: { type: 'string' },
        attendee_email: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['booking_id'],
    },
    execute: async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.start_time !== undefined) updates.start_time = args.start_time;
      if (args.end_time !== undefined) updates.end_time = args.end_time;
      if (args.attendee_name !== undefined) updates.attendee_name = args.attendee_name;
      if (args.attendee_email !== undefined) updates.attendee_email = args.attendee_email;
      if (args.location !== undefined) updates.location = args.location;
      if (!Object.keys(updates).length) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      const [row] = await sql`UPDATE cal_bookings SET ${sql(updates)} WHERE id = ${args.booking_id as string} RETURNING id, title, start_time, end_time, status`;
      if (!row) return JSON.stringify({ error: 'Booking non trovato' });
      return JSON.stringify({ updated: row });
    },
  },
  {
    name: 'cancel_cal_booking',
    description: 'Cancella un appuntamento (soft-cancel: status = cancelled). RICHIEDE CONFERMA.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        booking_id: { type: 'string' },
        reason: { type: 'string', description: 'Motivo cancellazione (opzionale)' },
      },
      required: ['booking_id'],
    },
    execute: async (args) => {
      const [row] = await sql`
        UPDATE cal_bookings
        SET status = 'cancelled', cancelled_at = now(), cancellation_reason = ${(args.reason as string) || null}
        WHERE id = ${args.booking_id as string}
        RETURNING id, title, status
      `;
      if (!row) return JSON.stringify({ error: 'Booking non trovato' });
      return JSON.stringify({ cancelled: row });
    },
  },
  {
    name: 'list_cal_bookings',
    description: 'Elenca appuntamenti in un intervallo di date (default: prossimi 14 giorni). Esclude cancellati.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Data inizio ISO/YYYY-MM-DD (default oggi)' },
        to: { type: 'string', description: 'Data fine ISO/YYYY-MM-DD (default +14gg)' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const from = args.from ? new Date(args.from as string) : new Date();
      const to = args.to ? new Date(args.to as string) : new Date(Date.now() + 14 * 24 * 3600 * 1000);
      const limit = Math.max(1, Math.min((args.limit as number) || 50, 100));
      const rows = await sql`
        SELECT id, title, start_time, end_time, attendee_name, attendee_email, location, status
        FROM cal_bookings
        WHERE start_time >= ${from.toISOString()} AND start_time <= ${to.toISOString()}
          AND status != 'cancelled'
        ORDER BY start_time ASC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, bookings: rows });
    },
  },

  // === IDEE (wrapper su notes con tag='idea') ===
  {
    name: 'create_idea',
    description: "Salva un'idea nel Knowledge Base (tag 'idea'). Usa quando l'utente dice \"segna un'idea\", \"crea idea\", \"appunta: ...\". RICHIEDE CONFERMA.",
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "Titolo breve dell'idea" },
        content: { type: 'string', description: 'Descrizione / contenuto markdown' },
        extra_tags: { type: 'array', items: { type: 'string' }, description: "Tag aggiuntivi oltre 'idea'" },
        linked_type: { type: 'string', enum: ['project', 'customer'] },
        linked_id: { type: 'string' },
      },
      required: ['title', 'content'],
    },
    execute: async (args) => {
      const tags = ['idea', ...(((args.extra_tags as string[]) || []).filter((t) => t && t !== 'idea'))];
      const [note] = await sql`
        INSERT INTO notes (title, raw_markdown, source, tags, linked_type, linked_id)
        VALUES (
          ${args.title as string},
          ${args.content as string},
          'agent',
          ${tags},
          ${(args.linked_type as string) || null},
          ${(args.linked_id as string) || null}
        ) RETURNING id, title, tags
      `;
      return JSON.stringify({ created: true, note_id: note.id, title: note.title, tags: note.tags });
    },
  },
  {
    name: 'list_ideas',
    description: "Elenca le idee salvate (note con tag 'idea'). Filtra opzionalmente per parola chiave.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filtro di testo su titolo/contenuto' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min((args.limit as number) || 20, 50));
      const searchFilter = args.query
        ? sql`AND (title ILIKE ${'%' + (args.query as string) + '%'} OR raw_markdown ILIKE ${'%' + (args.query as string) + '%'})`
        : sql``;
      const rows = await sql`
        SELECT id, title, LEFT(raw_markdown, 200) AS preview, tags, linked_type, linked_id, created_at
        FROM notes
        WHERE 'idea' = ANY(tags) ${searchFilter}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, ideas: rows });
    },
  },

  // ============================================
  // CALENDAR / BOOKING (cal.diy self-hosted)
  // ============================================
  {
    name: 'list_event_types',
    description: 'Lista delle tipologie di prenotazione disponibili (consulenza, sopralluogo, ecc.)',
    parameters: { type: 'object', properties: {} },
    riskLevel: 'low',
    execute: async () => {
      const rows = await sql`
        SELECT slug, title, description, duration_minutes, location_type, color, is_active, is_public
        FROM calendar_event_types
        ORDER BY sort_order ASC, title ASC
      `;
      return JSON.stringify({ count: rows.length, event_types: rows });
    },
  },
  {
    name: 'get_calendar_availability',
    description: 'Calcola gli slot disponibili per un event type in un range di date (date locali Europe/Rome)',
    parameters: {
      type: 'object',
      properties: {
        event_type_slug: { type: 'string', description: 'Slug dell\'event type (es. consulenza-gratuita-30min)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD (max 60 giorni dopo from_date)' },
      },
      required: ['event_type_slug', 'from_date', 'to_date'],
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { computeAvailableSlots } = await import('../calendar/slots');
      const result = await computeAvailableSlots({
        eventTypeIdOrSlug: args.event_type_slug as string,
        fromDateLocal: args.from_date as string,
        toDateLocal: args.to_date as string,
        onlyPublic: false,
      });
      if (!result) return JSON.stringify({ error: 'Event type non trovato' });
      return JSON.stringify({
        timezone: result.timezone,
        duration_minutes: result.eventType.duration_minutes,
        slots_count: result.slots.length,
        slots_by_date: result.slotsByDate,
      });
    },
  },
  {
    name: 'list_bookings',
    description: 'Lista delle prenotazioni con filtri opzionali per stato e date',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled', 'all'], description: 'Filtra per stato (default: confirmed)' },
        from_date: { type: 'string', description: 'YYYY-MM-DD: solo bookings con start >= questa data' },
        to_date: { type: 'string', description: 'YYYY-MM-DD: solo bookings con start <= questa data' },
        limit: { type: 'number' },
      },
    },
    riskLevel: 'low',
    execute: async (args) => {
      const status = (args.status as string) || 'confirmed';
      const limit = Math.max(1, Math.min((args.limit as number) || 50, 200));
      const statusFilter = status === 'all' ? sql`` : sql`AND b.status = ${status}`;
      const fromFilter = args.from_date ? sql`AND b.start_time >= ${(args.from_date as string) + 'T00:00:00Z'}` : sql``;
      const toFilter = args.to_date ? sql`AND b.start_time < ${(args.to_date as string) + 'T23:59:59Z'}` : sql``;
      const rows = await sql`
        SELECT b.uid, b.status, b.attendee_name, b.attendee_email,
               b.start_time, b.end_time, b.location_value,
               et.title AS event_type_title, et.slug AS event_type_slug
        FROM calendar_bookings b
        JOIN calendar_event_types et ON et.id = b.event_type_id
        WHERE 1=1 ${statusFilter} ${fromFilter} ${toFilter}
        ORDER BY b.start_time DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, bookings: rows });
    },
  },
  {
    name: 'create_booking',
    description: 'Crea una nuova prenotazione manuale per conto di un partecipante. Invia email di conferma.',
    parameters: {
      type: 'object',
      properties: {
        event_type_slug: { type: 'string' },
        start: { type: 'string', description: 'ISO UTC datetime (es. 2026-04-26T09:00:00Z)' },
        attendee_name: { type: 'string' },
        attendee_email: { type: 'string' },
        attendee_phone: { type: 'string' },
        attendee_company: { type: 'string' },
        attendee_message: { type: 'string' },
      },
      required: ['event_type_slug', 'start', 'attendee_name', 'attendee_email'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: async (args) => {
      const { createBooking, BookingConflictError, BookingValidationError } = await import('../calendar/booking');
      const { sendBookingConfirmation, sendBookingAdminNotification } = await import('../calendar/email');
      try {
        const { booking, eventType } = await createBooking({
          event_type_slug: args.event_type_slug as string,
          start: args.start as string,
          attendee: {
            name: args.attendee_name as string,
            email: args.attendee_email as string,
            phone: args.attendee_phone as string | undefined,
            company: args.attendee_company as string | undefined,
            timezone: 'Europe/Rome',
            message: args.attendee_message as string | undefined,
          },
          source: 'mcp',
          source_metadata: { created_via: 'mcp_tool' },
        });
        Promise.allSettled([
          sendBookingConfirmation({ booking, eventType }),
          sendBookingAdminNotification({ booking, eventType }),
        ]).catch(() => {});
        return JSON.stringify({
          success: true,
          uid: booking.uid,
          start_time: booking.start_time,
          end_time: booking.end_time,
        });
      } catch (err) {
        if (err instanceof BookingConflictError) return JSON.stringify({ error: err.message, code: 'CONFLICT' });
        if (err instanceof BookingValidationError) return JSON.stringify({ error: err.message, code: 'VALIDATION' });
        return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore sconosciuto' });
      }
    },
  },
  {
    name: 'cancel_booking',
    description: 'Cancella una prenotazione esistente per UID. Notifica il partecipante via email.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID pubblico del booking' },
        reason: { type: 'string', description: 'Motivo (opzionale, mostrato al partecipante)' },
      },
      required: ['uid'],
    },
    riskLevel: 'high',
    requiresConfirmation: true,
    execute: async (args) => {
      const { cancelBooking } = await import('../calendar/booking');
      const { sendBookingCancelled } = await import('../calendar/email');
      const result = await cancelBooking(args.uid as string, {
        cancelled_by: 'admin',
        reason: args.reason as string | undefined,
      });
      if (!result) return JSON.stringify({ error: 'Booking non trovato' });
      Promise.allSettled([
        sendBookingCancelled({ ...result, recipient: 'attendee' }),
      ]).catch(() => {});
      return JSON.stringify({ success: true, uid: args.uid });
    },
  },

  // ============================================
  // CALDES CALENDAR — eventi multi-calendario
  // ============================================
  {
    name: 'list_calendars',
    description: 'Lista tutti i calendari self-hosted (Lavoro, Personale, Bookings, Scadenze, ecc.) con colore, conteggio eventi, ICS feed URL.',
    parameters: { type: 'object', properties: {} },
    riskLevel: 'low',
    execute: async () => {
      const { listCalendars, buildFeedUrl } = await import('../calendar/calendars');
      const calendars = await listCalendars();
      const counts = await sql`
        SELECT calendar_id, COUNT(*)::int AS n FROM calendar_events
        WHERE status != 'cancelled' GROUP BY calendar_id
      `;
      const countMap = new Map(counts.map((r) => [r.calendar_id, r.n]));
      return JSON.stringify({
        count: calendars.length,
        calendars: calendars.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          color: c.color,
          timezone: c.timezone,
          is_default: c.is_default,
          is_system: c.is_system,
          event_count: countMap.get(c.id) || 0,
          ics_feed_url: c.ics_feed_enabled ? buildFeedUrl(c) : null,
        })),
      });
    },
  },
  {
    name: 'list_events',
    description: 'Lista eventi calendario in un range di date, con espansione automatica delle ricorrenze. Filtra opzionalmente per calendario specifico (slug o id).',
    parameters: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: 'Slug o id calendario (es. "lavoro"). Omettere per tutti i calendari.' },
        from: { type: 'string', description: 'ISO datetime inizio (es. 2026-04-26T00:00:00Z)' },
        to: { type: 'string', description: 'ISO datetime fine. Max 366 giorni dopo from.' },
      },
      required: ['from', 'to'],
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { listOccurrences } = await import('../calendar/events');
      const { getCalendar } = await import('../calendar/calendars');
      let calendarId: string | undefined;
      if (args.calendar) {
        const cal = await getCalendar(args.calendar as string);
        if (!cal) return JSON.stringify({ error: 'Calendario non trovato' });
        calendarId = cal.id;
      }
      const occurrences = await listOccurrences({
        calendarId,
        fromIso: args.from as string,
        toIso: args.to as string,
      });
      return JSON.stringify({ count: occurrences.length, events: occurrences });
    },
  },
  {
    name: 'get_events_for_today',
    description: 'Helper rapido: ritorna gli eventi del giorno corrente per un calendario (o tutti). Usa il timezone Europe/Rome per "today".',
    parameters: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: 'Slug calendario (opzionale)' },
      },
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { listOccurrences } = await import('../calendar/events');
      const { getCalendar } = await import('../calendar/calendars');
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      let calendarId: string | undefined;
      if (args.calendar) {
        const cal = await getCalendar(args.calendar as string);
        if (cal) calendarId = cal.id;
      }
      const occ = await listOccurrences({ calendarId, fromIso: start, toIso: end });
      return JSON.stringify({
        date: start.slice(0, 10),
        count: occ.length,
        events: occ.map((e) => ({
          summary: e.summary,
          start: e.start_time,
          end: e.end_time,
          location: e.location,
          url: e.url,
        })),
      });
    },
  },
  {
    name: 'find_free_slots',
    description: 'Trova finestre libere (no eventi confermati) in un calendario tra due date di durata minima specificata. Utile per proporre orari per nuovi appuntamenti.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime inizio finestra di ricerca' },
        to: { type: 'string', description: 'ISO datetime fine' },
        duration_minutes: { type: 'number', description: 'Durata minima slot libero in minuti' },
        working_hours_start: { type: 'string', description: 'Ora inizio giornata lavorativa (HH:MM, default 09:00)' },
        working_hours_end: { type: 'string', description: 'Ora fine giornata lavorativa (HH:MM, default 18:00)' },
      },
      required: ['from', 'to', 'duration_minutes'],
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { getBusyRanges } = await import('../calendar/events');
      const fromIso = args.from as string;
      const toIso = args.to as string;
      const durationMs = (args.duration_minutes as number) * 60_000;
      const whStart = (args.working_hours_start as string) || '09:00';
      const whEnd = (args.working_hours_end as string) || '18:00';
      const [whSh, whSm] = whStart.split(':').map(Number);
      const [whEh, whEm] = whEnd.split(':').map(Number);

      const busy = await getBusyRanges(fromIso, toIso);
      const busyMs = busy.map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
        .sort((a, b) => a.start - b.start);

      // Genera giornate lavorative nel range
      const free: { start: string; end: string }[] = [];
      const cursor = new Date(fromIso);
      const end = new Date(toIso);
      while (cursor < end) {
        // Skip weekend
        if (cursor.getDay() === 0 || cursor.getDay() === 6) {
          cursor.setDate(cursor.getDate() + 1);
          cursor.setHours(0, 0, 0, 0);
          continue;
        }
        const dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), whSh, whSm).getTime();
        const dayEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), whEh, whEm).getTime();

        let t = Math.max(dayStart, new Date(fromIso).getTime());
        for (const b of busyMs) {
          if (b.end <= t || b.start >= dayEnd) continue;
          if (b.start - t >= durationMs) {
            free.push({ start: new Date(t).toISOString(), end: new Date(b.start).toISOString() });
          }
          t = Math.max(t, b.end);
        }
        if (dayEnd - t >= durationMs) {
          free.push({ start: new Date(t).toISOString(), end: new Date(dayEnd).toISOString() });
        }

        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      }

      return JSON.stringify({ count: free.length, free_slots: free.slice(0, 50) });
    },
  },
  {
    name: 'create_event',
    description: 'Crea un nuovo evento calendario. Supporta ricorrenze RRULE (es. FREQ=WEEKLY;BYDAY=MO,WE per lun/mer settimanali).',
    parameters: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: 'Slug o id calendario destinazione (es. "lavoro")' },
        summary: { type: 'string', description: 'Titolo evento' },
        description: { type: 'string' },
        location: { type: 'string' },
        url: { type: 'string', description: 'Link meeting (Meet/Zoom)' },
        start: { type: 'string', description: 'ISO datetime inizio (es. 2026-04-26T09:00:00Z)' },
        end: { type: 'string', description: 'ISO datetime fine' },
        all_day: { type: 'boolean' },
        rrule: { type: 'string', description: 'RFC 5545 RRULE senza prefisso (es. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10")' },
      },
      required: ['calendar', 'summary', 'start', 'end'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: async (args) => {
      const { createEvent, EventValidationError } = await import('../calendar/events');
      const { getCalendar } = await import('../calendar/calendars');
      try {
        const cal = await getCalendar(args.calendar as string);
        if (!cal) return JSON.stringify({ error: 'Calendario non trovato' });
        const ev = await createEvent({
          calendar_id: cal.id,
          summary: args.summary as string,
          description: (args.description as string) || null,
          location: (args.location as string) || null,
          url: (args.url as string) || null,
          start_time: args.start as string,
          end_time: args.end as string,
          all_day: !!args.all_day,
          rrule: (args.rrule as string) || null,
          source: 'mcp',
        });
        return JSON.stringify({ success: true, event: { uid: ev.uid, id: ev.id, summary: ev.summary, start: ev.start_time, end: ev.end_time } });
      } catch (err) {
        if (err instanceof EventValidationError) return JSON.stringify({ error: err.message });
        return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore creazione evento' });
      }
    },
  },
  {
    name: 'update_event',
    description: 'Sposta o modifica un evento esistente (per id o uid). Per ricorrenti: questa modifica si applica al MASTER e quindi a tutte le occorrenze future. Per modificare singola occorrenza usa "create_event_exception".',
    parameters: {
      type: 'object',
      properties: {
        id_or_uid: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        url: { type: 'string' },
        start: { type: 'string', description: 'ISO datetime nuovo inizio' },
        end: { type: 'string', description: 'ISO datetime nuova fine' },
        rrule: { type: 'string', description: 'Nuova RRULE (vuota = rimuove ricorrenza)' },
        status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
      },
      required: ['id_or_uid'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: async (args) => {
      const { updateEvent, getEvent, EventValidationError } = await import('../calendar/events');
      try {
        const existing = await getEvent(args.id_or_uid as string);
        if (!existing) return JSON.stringify({ error: 'Evento non trovato' });
        const ev = await updateEvent(existing.id, {
          summary: args.summary as string | undefined,
          description: args.description as string | null | undefined,
          location: args.location as string | null | undefined,
          url: args.url as string | null | undefined,
          start_time: args.start as string | undefined,
          end_time: args.end as string | undefined,
          rrule: args.rrule === undefined ? undefined : (args.rrule as string | null),
          status: args.status as 'confirmed' | 'tentative' | 'cancelled' | undefined,
        });
        return JSON.stringify({ success: true, event: ev });
      } catch (err) {
        if (err instanceof EventValidationError) return JSON.stringify({ error: err.message });
        return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore' });
      }
    },
  },
  {
    name: 'delete_event',
    description: 'Cancella un evento. Per ricorrenti, cancella tutta la serie. Per cancellare singola occorrenza usa "create_event_exception" con status=cancelled.',
    parameters: {
      type: 'object',
      properties: {
        id_or_uid: { type: 'string' },
      },
      required: ['id_or_uid'],
    },
    riskLevel: 'high',
    requiresConfirmation: true,
    execute: async (args) => {
      const { deleteEvent, getEvent } = await import('../calendar/events');
      const existing = await getEvent(args.id_or_uid as string);
      if (!existing) return JSON.stringify({ error: 'Evento non trovato' });
      const ok = await deleteEvent(existing.id);
      return JSON.stringify({ success: ok });
    },
  },

  // ─── ANALYTICS (cookieless internal tracker) ────────────────────────────────

  {
    name: 'get_traffic_summary',
    description: 'KPI overview del traffico del sito: pageviews, visitatori unici, sessioni, bounce rate, durata media. Periodo: 24h | 7d | 30d | 90d | 12m (default 30d).',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const [row] = await sql`
        WITH base AS (
          SELECT session_id, visit_id, event_type, duration_ms
          FROM analytics
          WHERE website_id = 'main' AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
        ),
        visits AS (
          SELECT visit_id, COUNT(*) FILTER (WHERE event_type='pageview') AS pv, SUM(duration_ms) AS dur
          FROM base WHERE visit_id IS NOT NULL GROUP BY visit_id
        )
        SELECT
          (SELECT COUNT(*) FROM base WHERE event_type='pageview')::int AS pageviews,
          (SELECT COUNT(DISTINCT session_id) FROM base WHERE session_id IS NOT NULL)::int AS visitors,
          (SELECT COUNT(*) FROM visits)::int AS sessions,
          COALESCE(ROUND(100.0*(SELECT COUNT(*) FROM visits WHERE pv<=1)/NULLIF((SELECT COUNT(*) FROM visits),0),1),0)::float AS bounce_rate,
          COALESCE(ROUND(AVG(dur) FILTER (WHERE dur>0)),0)::int AS avg_duration_ms
        FROM visits
      `;
      return JSON.stringify({ period: args.period || '30d', ...(row || { pageviews: 0, visitors: 0, sessions: 0, bounce_rate: 0, avg_duration_ms: 0 }) });
    },
  },

  {
    name: 'get_top_pages',
    description: 'Top pagine per pageviews. Restituisce path, pageviews, visitatori unici, sessioni.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        limit: { type: 'number', description: 'Default 10, max 50' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
      const rows = await sql`
        SELECT page_path AS path,
          COUNT(*)::int AS pageviews,
          COUNT(DISTINCT session_id)::int AS visitors,
          COUNT(DISTINCT visit_id)::int AS sessions
        FROM analytics
        WHERE website_id = 'main'
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
          AND event_type = 'pageview'
          AND page_path IS NOT NULL
        GROUP BY page_path
        ORDER BY pageviews DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ period: args.period || '30d', pages: rows });
    },
  },

  {
    name: 'get_traffic_sources',
    description: 'Sorgenti di traffico: referrer domain, UTM source, UTM medium o UTM campaign. Specifica `kind` per scegliere.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        kind: { type: 'string', enum: ['referrer', 'utm_source', 'utm_medium', 'utm_campaign'], description: 'Dimensione (default referrer)' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const kindMap: Record<string, string> = {
        referrer: 'referrer_domain',
        utm_source: 'utm_source',
        utm_medium: 'utm_medium',
        utm_campaign: 'utm_campaign',
      };
      const col = kindMap[(args.kind as string) || 'referrer'] || 'referrer_domain';
      const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
      const rows = await sql`
        SELECT ${sql(col)} AS source,
          COUNT(*)::int AS pageviews,
          COUNT(DISTINCT session_id)::int AS visitors
        FROM analytics
        WHERE website_id = 'main'
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
          AND event_type = 'pageview'
        GROUP BY ${sql(col)}
        ORDER BY pageviews DESC NULLS LAST
        LIMIT ${limit}
      `;
      return JSON.stringify({ period: args.period || '30d', kind: args.kind || 'referrer', sources: rows });
    },
  },

  {
    name: 'get_realtime_visitors',
    description: 'Visitatori attivi sul sito negli ultimi 5 minuti + top 5 pagine attive + ultimi eventi.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const [visitors] = await sql`SELECT COUNT(DISTINCT visit_id)::int AS c FROM analytics WHERE website_id='main' AND created_at >= NOW() - INTERVAL '5 minutes' AND visit_id IS NOT NULL`;
      const topPages = await sql`
        SELECT page_path AS path, COUNT(DISTINCT visit_id)::int AS visitors
        FROM analytics
        WHERE website_id='main' AND event_type='pageview'
          AND created_at >= NOW() - INTERVAL '5 minutes' AND page_path IS NOT NULL
        GROUP BY page_path ORDER BY visitors DESC LIMIT 5
      `;
      const recentEvents = await sql`
        SELECT event_type AS type, event_name, page_path AS page, country, created_at
        FROM analytics
        WHERE website_id='main' AND created_at >= NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC LIMIT 10
      `;
      return JSON.stringify({ visitorsNow: visitors?.c ?? 0, topPages, recentEvents });
    },
  },

  {
    name: 'get_web_vitals',
    description: 'Core Web Vitals (LCP, CLS, INP, FCP, TTFB) p75 e p95 dal browser dei visitatori, con rating.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        page: { type: 'string', description: 'Path opzionale per filtrare a una pagina specifica' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const pageFilter = args.page ? sql`AND page_path = ${args.page as string}` : sql``;
      const rows = await sql`
        SELECT event_name AS metric, COUNT(*)::int AS count,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY event_value) AS p75,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY event_value) AS p95
        FROM analytics
        WHERE website_id='main' AND event_type='web_vital' AND event_value IS NOT NULL
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
          ${pageFilter}
        GROUP BY event_name ORDER BY metric
      ` as Array<{ metric: string; count: number; p75: number; p95: number }>;
      const thresholds: Record<string, { good: number; poor: number }> = {
        LCP: { good: 2500, poor: 4000 }, INP: { good: 200, poor: 500 },
        CLS: { good: 0.1, poor: 0.25 }, FCP: { good: 1800, poor: 3000 },
        TTFB: { good: 800, poor: 1800 },
      };
      const enriched = rows.map((m) => {
        const t = thresholds[m.metric];
        const rating = t ? (m.p75 <= t.good ? 'good' : m.p75 <= t.poor ? 'needs_improvement' : 'poor') : 'unknown';
        return { ...m, rating };
      });
      return JSON.stringify({ period: args.period || '30d', metrics: enriched });
    },
  },

  {
    name: 'get_goal_conversions',
    description: 'Lista i goal di analytics con il numero di conversioni nel periodo richiesto.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const goals = await sql`SELECT id, name, type, conditions, active FROM analytics_goals WHERE active = TRUE ORDER BY created_at DESC` as Array<{
        id: string; name: string; type: string; conditions: { path?: string; event_name?: string }; active: boolean;
      }>;
      const out = await Promise.all(goals.map(async (g) => {
        let count = 0;
        if (g.type === 'pageview' && g.conditions?.path) {
          const [r] = await sql`SELECT COUNT(DISTINCT session_id)::int AS c FROM analytics WHERE website_id='main' AND event_type='pageview' AND page_path=${g.conditions.path} AND created_at >= NOW() - CAST(${interval} AS INTERVAL)`;
          count = r?.c ?? 0;
        } else if (g.type === 'event' && g.conditions?.event_name) {
          const [r] = await sql`SELECT COUNT(DISTINCT session_id)::int AS c FROM analytics WHERE website_id='main' AND event_type='event' AND event_name=${g.conditions.event_name} AND created_at >= NOW() - CAST(${interval} AS INTERVAL)`;
          count = r?.c ?? 0;
        }
        return { name: g.name, type: g.type, conversions: count };
      }));
      return JSON.stringify({ period: args.period || '30d', goals: out });
    },
  },

  {
    name: 'get_traffic_geo',
    description: 'Breakdown geografico del traffico: top paesi con pageviews e visitatori unici.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const limit = Math.min(Math.max((args.limit as number) || 15, 1), 50);
      const rows = await sql`
        SELECT country, COUNT(*)::int AS pageviews, COUNT(DISTINCT session_id)::int AS visitors
        FROM analytics
        WHERE website_id='main' AND event_type='pageview' AND country IS NOT NULL
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
        GROUP BY country ORDER BY pageviews DESC LIMIT ${limit}
      `;
      return JSON.stringify({ period: args.period || '30d', countries: rows });
    },
  },
];

/**
 * Get tool definitions formatted for OpenAI function calling
 */
export function getToolsForLLM() {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool by name with given arguments
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Tool "${name}" non trovato` });
  try {
    return await tool.execute(args);
  } catch (err) {
    console.error(`Tool ${name} error:`, err);
    return JSON.stringify({ error: `Errore esecuzione tool "${name}"` });
  }
}
