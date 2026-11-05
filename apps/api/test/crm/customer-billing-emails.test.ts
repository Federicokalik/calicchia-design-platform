/**
 * Bug 2 — clienti con più destinatari per le comunicazioni amministrative.
 *
 * Prima: `customers` aveva solo `email`; promemoria domini, dunning e conferme
 * di pagamento partivano sempre e solo lì. Dopo: `billing_emails text[]`; se
 * popolato, ogni invio automatico amministrativo va a quegli indirizzi,
 * altrimenti a `email`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { simpleParser } from 'mailparser';
import { onDatabaseClosing, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { useCrmFixtures } from '../helpers/crm';
import { api } from '../helpers/http';
import { startFakeSmtp, type FakeSmtpServer } from '../helpers/mail-servers';
import { runDunningEngine } from '../../src/cron/dunning-engine';

useTestDatabase();
const crm = useCrmFixtures('crm-billing-emails');

let smtp: FakeSmtpServer;
onDatabaseReady(async () => {
  smtp = await startFakeSmtp();
  // Trasporto di sistema (lib/email.ts): il transporter è un singleton creato
  // al primo invio, quindi l'ambiente va impostato prima di qualunque invio.
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'false',
    SMTP_USER: 'sistema@example.test',
    SMTP_PASS: 'x',
    EMAIL_FROM: 'Calicchia Design <hi@example.test>',
  });
});
onDatabaseClosing(async () => {
  await smtp?.close();
});

function isoDate(daysFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

describe('billingRecipients', () => {
  test('billing_emails se popolato, altrimenti email; deduplica e scarta i non validi', async () => {
    // Import dinamico: il modulo è nuovo, il resto del file deve girare anche sul codice prima del fix.
    const { billingRecipients } = await import('../../src/lib/customer-recipients');
    assert.deepEqual(billingRecipients({ email: 'a@x.test', billing_emails: [] }), ['a@x.test']);
    assert.deepEqual(billingRecipients({ email: 'a@x.test', billing_emails: null }), ['a@x.test']);
    assert.deepEqual(
      billingRecipients({ email: 'a@x.test', billing_emails: ['Amm@X.test', 'amm@x.test', 'gmail@x.test'] }),
      ['amm@x.test', 'gmail@x.test'],
    );
    assert.deepEqual(billingRecipients({ email: null, billing_emails: null }), []);
    assert.deepEqual(billingRecipients({ email: 'erased-1@deleted.invalid', billing_emails: [] }), []);
  });
});

describe('API clienti', () => {
  test('PUT billing_emails: normalizza (minuscolo, senza duplicati) e lo restituisce', async () => {
    const c = await crm.customer();
    const amm = crm.email('amministrazione');
    const res = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { billing_emails: [amm.toUpperCase(), amm, ' altro@gmail.example.test '] } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.customer.billing_emails, [amm, 'altro@gmail.example.test']);
  });

  test('PUT billing_emails non validi → 400 sull’elemento', async () => {
    const c = await crm.customer();
    const res = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { billing_emails: ['ok@example.test', 'non-una-email'] } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /billing_emails\.1/);
  });

  test('PUT billing_emails [] svuota; POST accetta billing_emails', async () => {
    const created = await api.post('/api/customers', {
      auth: 'admin',
      body: { contact_name: crm.name('nuovo'), email: crm.email('nuovo'), billing_emails: [crm.email('amm-nuovo')], createOnStripe: false },
    });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(created.json.customer.billing_emails, [crm.email('amm-nuovo')]);
    const cleared = await api.put(`/api/customers/${created.json.customer.id}`, { auth: 'admin', body: { billing_emails: [] } });
    assert.deepEqual(cleared.json.customer.billing_emails, []);
  });
});

describe('invii automatici al cliente', () => {
  test('POST /api/domains/send-reminders usa billing_emails se popolato', async () => {
    const amm = crm.email('amm');
    const gmail = crm.email('gmail');
    const withBilling = await crm.customer({ billing_emails: [amm, gmail] });
    const plain = await crm.customer();
    await crm.domain(withBilling.id, { expiration_date: isoDate(10) });
    await crm.domain(plain.id, { expiration_date: isoDate(10) });

    smtp.messages.length = 0;
    const res = await api.post('/api/domains/send-reminders', { auth: 'admin' });
    assert.equal(res.status, 200, res.text);

    const toBilling = smtp.messages.find((m) => m.rcpt.includes(amm));
    assert.ok(toBilling, 'promemoria agli indirizzi amministrativi');
    assert.deepEqual([...toBilling.rcpt].sort(), [amm, gmail].sort());
    assert.ok(!smtp.messages.some((m) => m.rcpt.includes(withBilling.email!)), 'non anche all’email principale');
    const parsed = await simpleParser(toBilling.raw);
    assert.match(parsed.subject ?? '', /domini|dominio/i);

    assert.ok(smtp.messages.some((m) => m.rcpt.includes(plain.email!)), 'senza billing_emails resta email');

    const [alert] = await sql<Array<{ sent_to: string }>>`
      SELECT a.sent_to FROM domain_alerts a JOIN domains d ON d.id = a.domain_id WHERE d.customer_id = ${withBilling.id}
    `;
    assert.equal(alert.sent_to, [amm, gmail].join(', '));
  });

  test('dunning: il promemoria di pagamento va a billing_emails', async () => {
    const amm = crm.email('dunning-amm');
    const c = await crm.customer({ billing_emails: [amm] });
    await sql`
      INSERT INTO subscriptions ${sql({
        customer_id: c.id, name: crm.name('Hosting'), amount: 120, start_date: isoDate(-400),
        next_billing_date: isoDate(-3), status: 'active', provider: 'stripe', auto_renew: true,
        dunning_grace_days: 1, dunning_reminder_days: [3], dunning_suspend_days: 30,
      })}
    `;
    smtp.messages.length = 0;
    await runDunningEngine();
    const reminder = smtp.messages.find((m) => m.rcpt.includes(amm));
    assert.ok(reminder, 'promemoria dunning agli indirizzi amministrativi');
    assert.ok(!reminder.rcpt.includes(c.email!));
  });
});
