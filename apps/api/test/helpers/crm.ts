/**
 * Fixture del dominio CRM (clienti, domini, caselle email, bozze) per i test
 * di test/crm. Ogni riga porta il prefisso del gruppo nel nome o nell'email,
 * così `cleanup()` la ritrova anche dopo un run interrotto. Con
 * `useCrmFixtures()` la pulizia avviene prima e dopo i test del file.
 *
 * Le caselle email puntano ai server finti di helpers/mail-servers.ts e
 * cifrano la password con MAIL_ENC_KEY: `ensureMailKey()` imposta una chiave
 * di test (la variabile è tolta dall'ambiente ermetico di helpers/env.ts).
 */

import './env';
import { randomBytes } from 'node:crypto';
import { jsonb, sql } from '../../src/db';
import { encryptSecret } from '../../src/lib/mail/crypto';
import { onBeforeDatabaseClose, onDatabaseReady, testPrefix } from './db';
import { ensureTestAdmin, TEST_ADMIN } from './http';

/** Chiave AES di test (32 byte), mai usata fuori dai test. */
export const TEST_MAIL_ENC_KEY = 'a'.repeat(64);

export function ensureMailKey(): void {
  process.env.MAIL_ENC_KEY ??= TEST_MAIL_ENC_KEY;
}

export interface CrmCustomer {
  id: string;
  email: string | null;
  contact_name: string;
  billing_address: Record<string, unknown>;
}

export interface CrmFixtures {
  prefix: string;
  /** Email univoca con il prefisso del gruppo (dominio riservato .test). */
  email(tag?: string): string;
  /** Nome con il prefisso del gruppo. */
  name(tag?: string): string;
  /** Nome di dominio (senza TLD) con il prefisso, valido come etichetta DNS. */
  domainLabel(tag?: string): string;
  customer(overrides?: Record<string, unknown>): Promise<CrmCustomer>;
  domain(customerId: string, overrides?: Record<string, unknown>): Promise<Record<string, unknown>>;
  mailAccount(opts: { smtpPort: number; imapPort: number; sentFolder?: string | null; sentCopyMode?: string }): Promise<{ id: string; email: string }>;
  cleanup(): Promise<void>;
}

let counter = 0;

export function createCrmFixtures(label: string): CrmFixtures {
  const prefix = testPrefix(label, { random: true });
  const next = () => (++counter).toString(36);

  const fx: CrmFixtures = {
    prefix,
    email: (tag = next()) => `${prefix}-${tag}@example.test`.toLowerCase(),
    name: (tag = next()) => `${prefix} ${tag}`,
    domainLabel: (tag = next()) => `${prefix}-${tag}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),

    async customer(overrides = {}) {
      const row: Record<string, unknown> = {
        contact_name: fx.name('cliente'),
        email: fx.email(),
        ...overrides,
      };
      row.billing_address = jsonb(row.billing_address ?? {});
      const [customer] = await sql<CrmCustomer[]>`
        INSERT INTO customers ${sql(row)}
        RETURNING id, email, contact_name, billing_address
      `;
      return customer;
    },

    async domain(customerId, overrides = {}) {
      const [domain] = await sql`
        INSERT INTO domains ${sql({
          customer_id: customerId,
          domain_name: fx.domainLabel(),
          tld: 'it',
          registration_date: '2020-01-01',
          expiration_date: '2030-01-01',
          auto_renew: false,
          ...overrides,
        })}
        RETURNING *
      `;
      return domain;
    },

    async mailAccount({ smtpPort, imapPort, sentFolder = null, sentCopyMode }) {
      ensureMailKey();
      await ensureTestAdmin();
      const blob = encryptSecret('test-password');
      const email = fx.email(`box-${next()}`);
      const [acc] = await sql<Array<{ id: string; email: string }>>`
        INSERT INTO email_accounts ${sql({
          user_id: TEST_ADMIN.id,
          email,
          display_name: 'Casella di test',
          imap_host: '127.0.0.1',
          imap_port: imapPort,
          imap_secure: false,
          smtp_host: '127.0.0.1',
          smtp_port: smtpPort,
          smtp_secure: false,
          username: email,
          password_enc: blob.cipher,
          password_iv: blob.iv,
          password_tag: blob.tag,
          sent_folder: sentFolder,
          ...(sentCopyMode ? { sent_copy_mode: sentCopyMode } : {}),
        })}
        RETURNING id, email
      `;
      return acc;
    },

    async cleanup() {
      const like = `${prefix}%`;
      await sql`DELETE FROM email_accounts WHERE email LIKE ${like}`;
      const customers = await sql<Array<{ id: string }>>`
        SELECT id FROM customers WHERE contact_name LIKE ${like} OR email LIKE ${like}
      `;
      const ids = customers.map((c) => c.id);
      if (ids.length) {
        await sql`DELETE FROM domains WHERE customer_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM subscriptions WHERE customer_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM customers WHERE id = ANY(${ids}::uuid[])`;
      }
      await sql`DELETE FROM domains WHERE domain_name LIKE ${like}`;
    },
  };
  return fx;
}

/** Fixture CRM con pulizia prima e dopo i test del file. */
export function useCrmFixtures(label: string): CrmFixtures {
  const fx = createCrmFixtures(label);
  onDatabaseReady(() => fx.cleanup());
  onBeforeDatabaseClose(() => fx.cleanup());
  return fx;
}

/** Buffer PDF minimo ma riconoscibile (magic bytes %PDF-). */
export function fakePdf(size = 2048): Buffer {
  const head = Buffer.from('%PDF-1.4\n% proforma di test\n');
  const tail = Buffer.from('\n%%EOF\n');
  const filler = randomBytes(Math.max(0, size - head.length - tail.length));
  return Buffer.concat([head, filler, tail]);
}

/**
 * Imposta alcune righe di site_settings per la durata di `fn` e poi
 * ripristina lo stato precedente (riga tolta se prima non c'era).
 */
export async function withSettings<T>(values: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(values);
  const before = await sql<Array<{ key: string; value: unknown }>>`SELECT key, value FROM site_settings WHERE key = ANY(${keys})`;
  try {
    for (const [key, value] of Object.entries(values)) {
      await sql`
        INSERT INTO site_settings (key, value) VALUES (${key}, ${jsonb(value)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
    }
    return await fn();
  } finally {
    for (const key of keys) {
      const prev = before.find((r) => r.key === key);
      if (prev) await sql`UPDATE site_settings SET value = ${jsonb(prev.value)} WHERE key = ${key}`;
      else await sql`DELETE FROM site_settings WHERE key = ${key}`;
    }
  }
}

/** Profilo del fornitore valido per l'XML SDI (P.IVA e CF di esempio con cifra di controllo valida). */
export const TEST_BUSINESS_PROFILE = {
  company_name: 'Studio di test',
  vat_number: '12345678903',
  fiscal_code: 'RSSMRA80A01H501U',
  address_street: 'Via dei Test 1',
  address_zip: '03023',
  address_city: 'Ceccano',
  address_province: 'FR',
  address_country: 'IT',
};
