/**
 * One-shot backfill: encrypt plaintext webhooks.secret values.
 * Idempotent: skips rows already in iv:tag:ct format.
 *
 * Run after setting WEBHOOK_ENCRYPTION_KEY.
 */
import { sql } from '../src/db';
import { encryptSecret, isEncryptedSecret } from '../src/lib/crypto';

type WebhookRow = {
  id: string;
  secret: string;
};

type WorkflowRow = {
  id: string;
  trigger_config: Record<string, unknown> | string | null;
};

async function main() {
  const rows = (await sql`
    SELECT id, secret
    FROM webhooks
    WHERE secret IS NOT NULL
  `) as WebhookRow[];

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isEncryptedSecret(row.secret)) {
      skipped++;
      continue;
    }

    await sql`
      UPDATE webhooks
      SET secret = ${encryptSecret(row.secret)}
      WHERE id = ${row.id}
    `;
    encrypted++;
  }

  const workflows = (await sql`
    SELECT id, trigger_config
    FROM workflows
    WHERE trigger_type = 'webhook'
      AND trigger_config ? 'webhook_secret'
  `) as WorkflowRow[];

  let workflowEncrypted = 0;
  let workflowSkipped = 0;
  for (const workflow of workflows) {
    const config = typeof workflow.trigger_config === 'string'
      ? JSON.parse(workflow.trigger_config) as Record<string, unknown>
      : workflow.trigger_config ?? {};
    const secret = config.webhook_secret;
    if (typeof secret !== 'string' || !secret) {
      workflowSkipped++;
      continue;
    }
    if (isEncryptedSecret(secret)) {
      workflowSkipped++;
      continue;
    }

    await sql`
      UPDATE workflows
      SET trigger_config = ${JSON.stringify({ ...config, webhook_secret: encryptSecret(secret) })}::jsonb
      WHERE id = ${workflow.id}
    `;
    workflowEncrypted++;
  }

  console.log(`Done. Encrypted ${encrypted} webhooks.secret values, skipped ${skipped}.`);
  console.log(`Done. Encrypted ${workflowEncrypted} workflow webhook secrets, skipped ${workflowSkipped}.`);
}

main()
  .catch((err) => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
