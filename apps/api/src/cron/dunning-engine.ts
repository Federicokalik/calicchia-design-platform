/**
 * Dunning engine - gestisce automaticamente le subscriptions con next_billing_date
 * superato. Logica:
 *  - giorni di ritardo = CURRENT_DATE - next_billing_date
 *  - se ritardo < grace_days -> niente, dunning_state='none'
 *  - se ritardo >= grace_days E ritardo NON in reminder_days (offset) -> 'grace'
 *  - se ritardo nei reminder_days (es. 3,7,14) -> invia email reminder
 *  - se ritardo >= suspend_days -> status='past_due', dunning_state='suspended', auto_renew=false
 *
 * Idempotenza: last_dunning_at viene aggiornato a NOW() solo quando si invia un
 * reminder o si sospende. I reminder gia' inviati nello stesso CURRENT_DATE DB
 * vengono saltati.
 */
import { sql, sqlv } from '../db';
import { sendEmail } from '../lib/email';

type DunningRow = Record<string, unknown> & {
  id: string;
  name: string | null;
  amount: string | number | null;
  currency: string | null;
  next_billing_date: string | null;
  status: string | null;
  dunning_grace_days: number | null;
  dunning_reminder_days: number[] | null;
  dunning_suspend_days: number | null;
  last_dunning_at: string | Date | null;
  dunning_state: string | null;
  customer_email: string | null;
  contact_name: string | null;
  company_name: string | null;
  days_late: string | number;
  processed_today: boolean;
};

type SendEmailResult = Awaited<ReturnType<typeof sendEmail>>;

export async function runDunningEngine(): Promise<void> {
  const todayCheck = await sql`SELECT CURRENT_DATE AS today` as Array<{ today: string }>;
  console.log('[dunning] Run for', todayCheck[0]?.today);

  const candidates = await sql`
    SELECT
      s.id, s.name, s.amount, s.currency, s.next_billing_date, s.status,
      s.dunning_grace_days, s.dunning_reminder_days, s.dunning_suspend_days,
      s.last_dunning_at, s.dunning_state,
      c.email AS customer_email, c.contact_name, c.company_name,
      (CURRENT_DATE - s.next_billing_date) AS days_late,
      (s.last_dunning_at::date = CURRENT_DATE) AS processed_today
    FROM subscriptions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.status IN ('active', 'past_due', 'unpaid')
      AND s.auto_renew = true
      AND s.next_billing_date IS NOT NULL
      AND s.next_billing_date < CURRENT_DATE
  ` as DunningRow[];

  console.log(`[dunning] ${candidates.length} candidates`);

  for (const row of candidates) {
    const daysLate = Number(row.days_late);
    const graceDays = Number(row.dunning_grace_days ?? 7);
    const suspendDays = Number(row.dunning_suspend_days ?? 30);
    const reminderDays = row.dunning_reminder_days ?? [3, 7, 14];
    const currentState = String(row.dunning_state ?? 'none');
    const processedToday = Boolean(row.processed_today);

    if (daysLate < graceDays) {
      if (currentState !== 'none') {
        await sql`
          UPDATE subscriptions
          SET dunning_state = 'none', updated_at = NOW()
          WHERE id = ${row.id}
        `;
      }
      continue;
    }

    if (daysLate >= suspendDays) {
      if (currentState !== 'suspended' && !processedToday) {
        await sql`
          UPDATE subscriptions
          SET status = 'past_due',
              dunning_state = 'suspended',
              auto_renew = false,
              last_dunning_at = NOW(),
              updated_at = NOW()
          WHERE id = ${row.id}
        `;
        await writeAudit('SUSPEND', row);

        const email = String(row.customer_email ?? '');
        if (email) {
          await sendEmail({
            to: email,
            subject: `Sospensione abbonamento "${row.name}" - ritardo pagamento`,
            html: renderSuspendHtml(row, daysLate),
            transport: 'critical',
          }).catch((err: unknown) => console.error('[dunning] suspend mail error', err));
        }
      }
      continue;
    }

    const isReminderDay = reminderDays.includes(daysLate);
    if (isReminderDay && !processedToday) {
      const email = String(row.customer_email ?? '');
      if (email) {
        const sent: SendEmailResult | { success: false } = await sendEmail({
          to: email,
          subject: `Promemoria pagamento "${row.name}" - ${daysLate} giorni di ritardo`,
          html: renderReminderHtml(row, daysLate),
          transport: 'critical',
        }).catch((err: unknown) => {
          console.error('[dunning] reminder mail error', err);
          return { success: false };
        });

        if (sent.success) {
          await sql`
            UPDATE subscriptions
            SET dunning_state = 'reminded',
                last_dunning_at = NOW(),
                updated_at = NOW()
            WHERE id = ${row.id}
          `;
          await writeAudit('REMINDER', row);
        }
      }
      continue;
    }

    if (currentState !== 'grace' && currentState !== 'reminded') {
      await sql`
        UPDATE subscriptions
        SET dunning_state = 'grace', updated_at = NOW()
        WHERE id = ${row.id}
      `;
    }
  }

  console.log('[dunning] done');
}

async function writeAudit(action: 'REMINDER' | 'SUSPEND', row: DunningRow): Promise<void> {
  await sql`
    INSERT INTO audit_logs (
      user_id, user_email, user_role, action, table_name, record_id,
      old_data, new_data, changed_fields, user_agent, metadata
    ) VALUES (
      ${null}, ${'system@dunning'}, ${'system'},
      ${action}, ${'subscriptions'}, ${row.id},
      ${null}, ${null}, ${null}, ${'cron/dunning-engine'},
      ${sqlv({ subscription_name: row.name, days_late: Number(row.days_late) })}
    )
  `.catch((err: unknown) => console.error('[dunning] audit error', err));
}

function renderReminderHtml(row: DunningRow, daysLate: number): string {
  const name = String(row.contact_name ?? row.company_name ?? 'Cliente');
  const subName = String(row.name ?? 'Abbonamento');
  const amount = Number(row.amount ?? 0);
  const currency = String(row.currency ?? 'EUR');
  return `
    <p>Ciao ${escapeHtml(name)},</p>
    <p>il pagamento dell'abbonamento <strong>${escapeHtml(subName)}</strong> risulta in ritardo di <strong>${daysLate} giorni</strong>.</p>
    <p>Importo dovuto: <strong>${amount.toFixed(2)} ${escapeHtml(currency)}</strong></p>
    <p>Per regolarizzare la posizione e mantenere il servizio attivo, ti chiediamo di procedere al pagamento il prima possibile.</p>
    <p>Grazie,<br/>Calicchia Design</p>
  `;
}

function renderSuspendHtml(row: DunningRow, daysLate: number): string {
  const name = String(row.contact_name ?? row.company_name ?? 'Cliente');
  const subName = String(row.name ?? 'Abbonamento');
  return `
    <p>Ciao ${escapeHtml(name)},</p>
    <p>l'abbonamento <strong>${escapeHtml(subName)}</strong> e' stato <strong>sospeso</strong> a causa di un ritardo di ${daysLate} giorni nel pagamento.</p>
    <p>Per riattivarlo, contattaci e completa il pagamento. Il rinnovo automatico e' stato disattivato.</p>
    <p>Calicchia Design</p>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
