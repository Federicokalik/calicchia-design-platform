/**
 * data-retention — Daily GDPR / security retention sweep (GDPR-02 / DB-03).
 *
 * Invokes the two Postgres retention functions that, before this job, were
 * defined but never scheduled (migrations 038 and 084):
 *  - run_data_retention(): anonymizes contacts and purges audit_logs,
 *    cookie_consents and analytics past their retention window.
 *  - cleanup_webhook_security_retention(): purges webhook + payment provider
 *    logs older than 30 days.
 *
 * Note: run_data_retention() also calls purge_old_analytics(), which the
 * separate `analytics-retention` job runs too — the second call is a harmless
 * no-op (nothing left to purge).
 *
 * Calendario su Radicale (fase F3, design §16.4, contratto
 * docs/calendar-radicale/contracts/f3-modules.md §6.4 e §13.2), dopo le
 * funzioni di prima e ognuno isolato (un errore si registra e non ferma gli
 * altri passi):
 *  - purgeMigrationArtifacts(): run e righe dello strumento di migrazione oltre
 *    30 giorni (tranne l'ultimo riuscito di ogni tipo) e file caricati per
 *    l'archivio della Fase 0 oltre 24 ore;
 *  - enqueueExpiredProjectionRewrites(): proiezioni delle prenotazioni la cui
 *    fine ha appena superato i 24 mesi, riscritte come "Prenotazione" sui
 *    device (project_booking con lo store Radicale, shadow_mirror in mode
 *    postgres con lo shadow acceso).
 */
import { sql } from '../db';
import { enqueueExpiredProjectionRewrites, purgeMigrationArtifacts } from '../lib/calendar/gdpr';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'data-retention' });

/** Esegue un passo della retention del calendario registrando l'errore senza propagarlo. */
async function isolated(step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    log.info({ result }, step);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), step }, `${step}: passo della retention non riuscito`);
  }
}

export async function runDataRetention(): Promise<void> {
  // Un errore delle funzioni di prima non salta la retention del calendario: si rilancia alla fine.
  let failure: unknown = null;
  try {
    const [retention] = (await sql`SELECT run_data_retention() AS result`) as Array<{
      result: Record<string, unknown>;
    }>;
    log.info({ result: retention?.result ?? {} }, 'run_data_retention');

    const [webhook] = (await sql`
      SELECT * FROM cleanup_webhook_security_retention()
    `) as Array<Record<string, number>>;
    log.info(
      { result: webhook ?? {} },
      'cleanup_webhook_security_retention'
    );
  } catch (err) {
    failure = err;
  }

  await isolated('calendar_migration_artifacts', () => purgeMigrationArtifacts());
  await isolated('calendar_projection_retention', async () => ({ jobs: await enqueueExpiredProjectionRewrites() }));

  if (failure) throw failure;
}
