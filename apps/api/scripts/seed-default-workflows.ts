/**
 * Seed default workflow templates into the `workflows` table.
 *
 * All seeded workflows start in 'paused' so they do not fire until the
 * admin flips the switch in /workflows.
 *
 * Upsert behaviour: if a workflow with the same name already exists AND
 * `execution_count = 0` (never been run), it is updated in place so
 * placeholder fixes propagate. Workflows that have already run at least
 * once are left untouched to avoid clobbering admin customisations.
 *
 * Orphan archival: workflows previously seeded that listen on events the
 * codebase never fires (`contatto_ricevuto`, `pagamento_ricevuto`) are
 * marked 'archived' so they vanish from the active list.
 *
 *   pnpm --filter @calicchia/api seed:workflows
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

type TriggerType = 'manual' | 'event' | 'cron' | 'webhook' | 'telegram';

interface NodeDef {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface EdgeDef {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

type WorkflowTemplate = {
  name: string;
  description: string;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
} & (
  | { steps: Array<{ id: string; type: string; data: Record<string, unknown> }>; graph?: never }
  | { graph: { nodes: NodeDef[]; edges: EdgeDef[] }; steps?: never }
);

const GRID_X = 320;
const ROW_Y = 200;

function buildChain(steps: NonNullable<Extract<WorkflowTemplate, { steps: any }>['steps']>): {
  nodes: NodeDef[];
  edges: EdgeDef[];
} {
  const nodes: NodeDef[] = steps.map((s, i) => ({
    id: s.id,
    type: s.type,
    position: { x: 100 + i * GRID_X, y: ROW_Y },
    data: s.data,
  }));
  const edges: EdgeDef[] = nodes.slice(0, -1).map((n, i) => ({
    id: `e-${n.id}-${nodes[i + 1].id}`,
    source: n.id,
    target: nodes[i + 1].id,
  }));
  return { nodes, edges };
}

function gridPos(col: number, row = 0): { x: number; y: number } {
  return { x: 100 + col * GRID_X, y: ROW_Y + row * 180 };
}

/**
 * Event payload reference — kept in sync with code that calls fireEvent():
 *
 *   nuovo_lead         (contacts.ts)         { name, email, phone, company }
 *   preventivo_firmato (quote-public.ts)     { quote_id, title, total, signer_name, customer_email }
 *   booking_creato     (calendar/public.ts)  { booking_uid, event_type_slug, attendee_name, attendee_email, start_time }
 *   dominio_scadenza   (domain-alerts.ts)    { domain_id, domain_name, expiration_date, days_remaining,
 *                                              milestone, auto_renew, customer_id, customer_name,
 *                                              customer_company, customer_email, customer_phone }
 *
 * If you add a new template, grep `fireEvent(` first to confirm the
 * event is actually emitted AND to see what fields are in the payload.
 */
const TEMPLATES: WorkflowTemplate[] = [
  {
    name: '[default] Notifica nuovo lead',
    description: 'Avvisa su Telegram appena arriva un nuovo lead dal sito.',
    trigger_type: 'event',
    trigger_config: { event_type: 'nuovo_lead' },
    steps: [
      { id: 'trg', type: 'trigger_event', data: { event_type: 'nuovo_lead' } },
      {
        id: 'tg',
        type: 'tool_send_telegram',
        data: {
          message:
            '🆕 <b>Nuovo lead</b>\n' +
            'Nome: {{name}}\n' +
            'Email: {{email}}\n' +
            'Tel: {{phone}}\n' +
            'Azienda: {{company}}',
        },
      },
    ],
  },

  {
    name: '[default] Preventivo firmato → crea progetto',
    description:
      'Quando un preventivo viene firmato: notifica Telegram e crea automaticamente il progetto con task AI.',
    trigger_type: 'event',
    trigger_config: { event_type: 'preventivo_firmato' },
    steps: [
      { id: 'trg', type: 'trigger_event', data: { event_type: 'preventivo_firmato' } },
      {
        id: 'tg',
        type: 'tool_send_telegram',
        data: {
          message:
            '✅ <b>Preventivo firmato!</b>\n' +
            'Cliente: {{signer_name}}\n' +
            'Titolo: {{title}}\n' +
            'Importo: €{{total}}',
        },
      },
      { id: 'mkproj', type: 'tool_create_project', data: { quote_id: '{{quote_id}}' } },
    ],
  },

  {
    name: '[default] Alert dominio in scadenza',
    description: 'Notifica Telegram quando un dominio gestito sta per scadere.',
    trigger_type: 'event',
    trigger_config: { event_type: 'dominio_scadenza' },
    steps: [
      { id: 'trg', type: 'trigger_event', data: { event_type: 'dominio_scadenza' } },
      {
        id: 'tg',
        type: 'tool_send_telegram',
        data: {
          message:
            '⏰ <b>Dominio in scadenza</b>\n' +
            '{{domain_name}} scade tra {{days_remaining}} giorni.\n' +
            'Cliente: {{customer_name}}',
        },
      },
    ],
  },

  {
    name: '[default] Notifica nuovo booking',
    description: 'Avvisa su Telegram quando un cliente prenota una call o un appuntamento.',
    trigger_type: 'event',
    trigger_config: { event_type: 'booking_creato' },
    steps: [
      { id: 'trg', type: 'trigger_event', data: { event_type: 'booking_creato' } },
      {
        id: 'tg',
        type: 'tool_send_telegram',
        data: {
          message:
            '📅 <b>Nuova prenotazione</b>\n' +
            '{{attendee_name}} — {{event_type_slug}}\n' +
            '{{start_time}}',
        },
      },
    ],
  },

  {
    name: '[default] Daily digest',
    description:
      'Ogni mattina alle 09:00 riassume i KPI del giorno precedente (lead, bookings, pagamenti) e li invia su Telegram.',
    trigger_type: 'cron',
    trigger_config: { interval_hours: 24, time: '09:00' },
    steps: [
      { id: 'trg', type: 'trigger_cron', data: { interval_hours: 24, time: '09:00' } },
      {
        id: 'q',
        type: 'tool_db_query',
        data: {
          query:
            'SELECT ' +
            "(SELECT COUNT(*) FROM leads WHERE created_at > NOW() - INTERVAL '24 hours') AS leads_24h, " +
            "(SELECT COUNT(*) FROM calendar_bookings WHERE created_at > NOW() - INTERVAL '24 hours') AS bookings_24h, " +
            "(SELECT COUNT(*) FROM payments WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'completed') AS payments_24h, " +
            "(SELECT COALESCE(SUM(amount), 0) FROM payments WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'completed') AS revenue_24h",
          params: [],
        },
      },
      { id: 'sum', type: 'llm_summarize', data: { max_length: 80, style: 'telegrafico' } },
      {
        id: 'tg',
        type: 'tool_send_telegram',
        data: { message: '📊 <b>Digest giornaliero</b>\n{{summary}}' },
      },
    ],
  },

  {
    name: '[default] Conferma booking al cliente',
    description:
      "Quando un cliente prenota una call: gli invia subito un'email di conferma con l'orario.",
    trigger_type: 'event',
    trigger_config: { event_type: 'booking_creato' },
    steps: [
      { id: 'trg', type: 'trigger_event', data: { event_type: 'booking_creato' } },
      {
        id: 'mail',
        type: 'tool_send_email',
        data: {
          to: '{{attendee_email}}',
          subject: 'Prenotazione confermata — {{event_type_slug}}',
          body:
            '<p>Ciao {{attendee_name}},</p>' +
            '<p>La tua prenotazione per <b>{{event_type_slug}}</b> è confermata per il <b>{{start_time}}</b>.</p>' +
            '<p>A presto,<br/>Federico</p>',
        },
      },
    ],
  },

  {
    name: '[default] Dominio scadenza → WhatsApp cliente',
    description:
      'Quando un dominio gestito sta per scadere, avvisa il cliente proprietario via WhatsApp. Richiede WhatsApp (GOWA) configurato.',
    trigger_type: 'event',
    trigger_config: { event_type: 'dominio_scadenza' },
    steps: [
      { id: 'trg', type: 'trigger_event', data: { event_type: 'dominio_scadenza' } },
      {
        id: 'wa',
        type: 'tool_send_whatsapp',
        data: {
          phone: '{{customer_phone}}',
          // 'operational' = service reminder; rispetta opt-out operational
          // ma viene inviato anche senza preferences row (default ON).
          category: 'operational',
          message:
            'Ciao {{customer_name}}, ti scrivo da calicchia.design: il dominio {{domain_name}} scade tra {{days_remaining}} giorni. Vuoi rinnovarlo?',
        },
      },
    ],
  },

  {
    name: '[default] Weekly digest',
    description:
      'Ogni lunedì alle 09:00: riassume i KPI della settimana precedente (lead, bookings, pagamenti, revenue) via AI e li invia su Telegram.',
    trigger_type: 'cron',
    trigger_config: { interval_hours: 168, time: '09:00' },
    steps: [
      { id: 'trg', type: 'trigger_cron', data: { interval_hours: 168, time: '09:00' } },
      {
        id: 'q',
        type: 'tool_db_query',
        data: {
          query:
            'SELECT ' +
            "(SELECT COUNT(*) FROM leads WHERE created_at > NOW() - INTERVAL '7 days') AS leads_7d, " +
            "(SELECT COUNT(*) FROM calendar_bookings WHERE created_at > NOW() - INTERVAL '7 days') AS bookings_7d, " +
            "(SELECT COUNT(*) FROM payments WHERE created_at > NOW() - INTERVAL '7 days' AND status = 'completed') AS payments_7d, " +
            "(SELECT COALESCE(SUM(amount), 0) FROM payments WHERE created_at > NOW() - INTERVAL '7 days' AND status = 'completed') AS revenue_7d, " +
            "(SELECT COUNT(*) FROM client_projects WHERE created_at > NOW() - INTERVAL '7 days') AS new_projects_7d",
          params: [],
        },
      },
      { id: 'sum', type: 'llm_summarize', data: { max_length: 100, style: 'telegrafico' } },
      {
        id: 'tg',
        type: 'tool_send_telegram',
        data: { message: '📈 <b>Weekly digest</b>\n{{summary}}' },
      },
    ],
  },

  // AI-classify branch: lead → urgenza → solo se urgente notifica Telegram
  {
    name: '[default] Lead urgente con AI',
    description:
      "Classifica il lead in arrivo per urgenza (alta/media/bassa) e manda una notifica Telegram solo se 'alta'. Gli altri vanno solo a log.",
    trigger_type: 'event',
    trigger_config: { event_type: 'nuovo_lead' },
    graph: {
      nodes: [
        { id: 'trg', type: 'trigger_event', position: gridPos(0), data: { event_type: 'nuovo_lead' } },
        {
          id: 'cls',
          type: 'llm_classify',
          position: gridPos(1),
          data: {
            categories: ['alta', 'media', 'bassa'],
            prompt:
              "Classifica l'urgenza del lead (parole come 'urgente', 'subito', 'oggi' → alta; budget/scadenza chiari → media; richieste generiche → bassa).",
          },
        },
        {
          id: 'cond',
          type: 'logic_condition',
          position: gridPos(2),
          data: {
            condition: "input.category == 'alta'",
            true_label: 'Urgente',
            false_label: 'Non urgente',
          },
        },
        {
          id: 'tg',
          type: 'tool_send_telegram',
          position: gridPos(3, -1),
          data: {
            message:
              '🚨 <b>Lead URGENTE</b>\n' +
              'Nome: {{name}}\n' +
              'Email: {{email}}\n' +
              'Tel: {{phone}}',
          },
        },
        {
          id: 'log',
          type: 'output_log',
          position: gridPos(3, 1),
          data: { message: 'Lead non urgente: {{name}} ({{category}})' },
        },
      ],
      edges: [
        { id: 'e-trg-cls', source: 'trg', target: 'cls' },
        { id: 'e-cls-cond', source: 'cls', target: 'cond' },
        { id: 'e-cond-tg', source: 'cond', target: 'tg', sourceHandle: 'true' },
        { id: 'e-cond-log', source: 'cond', target: 'log', sourceHandle: 'false' },
      ],
    },
  },
];

/**
 * Names of `[default] *` workflows that earlier versions of this script
 * seeded but that listen on events the codebase never fires. They are
 * archived (status='archived') so they disappear from the admin's active
 * list, and a note is appended to the description for traceability.
 */
const ORPHAN_NAMES = [
  '[default] Notifica modulo contatti',          // event contatto_ricevuto — never fired
  '[default] Auto-reply contatto al cliente',    // event contatto_ricevuto — never fired
  '[default] Grazie pagamento ricevuto',         // event pagamento_ricevuto — never fired
] as const;

const ORPHAN_NOTE = ' [ARCHIVED: l\'evento non e` mai emesso dal sistema]';

interface ExistingRow {
  id: string;
  status: string;
  execution_count: number;
  description: string | null;
}

async function main() {
  console.log(`Seeding ${TEMPLATES.length} default workflows...\n`);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const tpl of TEMPLATES) {
    const rows = (await sql`
      SELECT id, status, execution_count, description
      FROM workflows WHERE name = ${tpl.name} LIMIT 1
    `) as ExistingRow[];
    const existing = rows[0];
    const { nodes, edges } = tpl.steps ? buildChain(tpl.steps) : tpl.graph;

    if (!existing) {
      await sql`
        INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges, variables)
        VALUES (
          ${tpl.name},
          ${tpl.description},
          'paused',
          ${tpl.trigger_type},
          ${JSON.stringify(tpl.trigger_config)},
          ${JSON.stringify(nodes)},
          ${JSON.stringify(edges)},
          '{}'
        )
      `;
      console.log(`  + ${tpl.name}  (inserted)`);
      inserted++;
      continue;
    }

    // Update only if never executed — preserve admin customisations.
    if (existing.execution_count > 0) {
      console.log(`  - ${tpl.name}  (skipped — execution_count=${existing.execution_count})`);
      skipped++;
      continue;
    }

    await sql`
      UPDATE workflows SET
        description = ${tpl.description},
        trigger_type = ${tpl.trigger_type},
        trigger_config = ${JSON.stringify(tpl.trigger_config)},
        nodes = ${JSON.stringify(nodes)},
        edges = ${JSON.stringify(edges)},
        last_error = NULL,
        updated_at = now()
      WHERE id = ${existing.id}
    `;
    console.log(`  ~ ${tpl.name}  (updated)`);
    updated++;
  }

  // Archive orphan templates that point at unemitted events.
  let archived = 0;
  for (const name of ORPHAN_NAMES) {
    const rows = (await sql`
      SELECT id, status, description FROM workflows WHERE name = ${name} LIMIT 1
    `) as ExistingRow[];
    const row = rows[0];
    if (!row) continue;
    if (row.status === 'archived') continue;
    const nextDesc = (row.description || '').includes('[ARCHIVED')
      ? row.description
      : `${row.description ?? ''}${ORPHAN_NOTE}`;
    await sql`
      UPDATE workflows SET status = 'archived', description = ${nextDesc}, updated_at = now()
      WHERE id = ${row.id}
    `;
    console.log(`  ⌫ ${name}  (archived — event never fired)`);
    archived++;
  }

  console.log(`\nDone: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${archived} archived.`);
  console.log(`Active templates are 'paused' — toggle them on from /workflows in admin.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
