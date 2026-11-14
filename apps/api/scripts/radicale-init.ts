/**
 * Inizializzazione del volume di Radicale da riga di comando (piano F1;
 * contratto docs/calendar-radicale/contracts/control-plane.md §4.4; design
 * §6.3 e §13.3). Dalla F3 lo stesso passo lo esegue il wizard della
 * migrazione (passo 1, POST /api/admin/calendar/migration/init): questo
 * script è solo un involucro di riga di comando attorno a planInitialization()
 * ed executeInitialization() di src/lib/calendar/migration/init.ts, l'unico
 * punto del codice che fa MKCOL e MKCALENDAR. Precondizioni, collezioni del
 * piano e creazione sono quelle del wizard, senza logica duplicata.
 *
 * Senza opzioni è una prova a vuoto: legge lo stato in PG, controlla il
 * principal su Radicale come caldes-svc, verifica l'identità e stampa che cosa
 * farebbe. Con --apply esegue:
 *  - volume mai inizializzato (mode postgres, epoch 0, principal assente):
 *    MKCOL del principal, marker volume-id/epoch 1, UPDATE dello stato,
 *    MKCALENDAR delle collezioni del piano (calendari attivi con il nome di
 *    collezione valido, sub-* delle iscrizioni visibili ai device, archivio
 *    della Fase 0 se la riga esiste; con le dead prop calendar-id e role) e
 *    della collezione di sistema `_canary` (canary del campanello, F2). Il
 *    NOTIFY dello stato fa riscrivere subito policy.json al control-plane
 *    dell'API in esecuzione;
 *  - volume già inizializzato con identità ok: solo le collezioni del piano
 *    che mancano su Radicale (es. un calendario creato dall'admin dopo) e
 *    `_canary` se manca (i volumi inizializzati in F1 non ce l'hanno: senza,
 *    il campanello della F2 resta in remote mode);
 *  - in ogni altro caso rifiuta (exit 3): un volume non vuoto senza marker, o
 *    con un marker diverso da PG, non viene mai inizializzato né adottato (la
 *    riassegnazione d'identità confermata è nel wizard).
 * Lo script non ha il journal del run del wizard: se si interrompe fra la
 * MKCOL e l'aggiornamento dello stato, la ripresa si fa dal wizard
 * (riassegnazione d'identità volume_to_pg).
 *
 * Uso (da apps/api; nessun .env letto: le variabili sono quelle del container):
 *   pnpm calendar:radicale-init              prova a vuoto
 *   pnpm calendar:radicale-init -- --apply   esecuzione
 * In produzione, nel container dell'API (che è sulla rete caldav-int, l'unico
 * peer da cui caldes-svc è ammesso):
 *   docker compose -p <progetto> exec api pnpm calendar:radicale-init
 *   docker compose -p <progetto> exec api pnpm calendar:radicale-init -- --apply
 *
 * Variabili: DATABASE_URL, RADICALE_URL, RADICALE_SVC_PASSWORD,
 * RADICALE_SVC_USER (default caldes-svc), RADICALE_PRINCIPAL (default
 * federico), RADICALE_TIMEOUT_MS.
 *
 * Output: un report JSON su stdout (nessun segreto), un riepilogo su stderr.
 * Exit code: 0 ok (o prova a vuoto con un'azione eseguibile), 1 errore,
 * 2 uso errato o configurazione mancante, 3 rifiutato dalle precondizioni.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type RadicaleClient, radicaleClientFromEnv } from '../src/lib/calendar/radicale/client';
import type { CanaryProvisioning, CollectionProvisioning, VolumeInitErrorCode } from '../src/lib/calendar/radicale/identity';
import type { Db } from '../src/lib/calendar/radicale/policy';
import { DEFAULT_PRINCIPAL, isValidPrincipal } from '../src/lib/calendar/radicale/types';

/** Versione del formato del report. */
export const REPORT_SCHEMA = 'caldes.radicale-init/v1';

/** Che cosa farebbe (o ha fatto) lo script. */
export type RadicaleInitAction =
  /** Volume mai inizializzato: principal, marker, stato e collezioni. */
  | 'initialize'
  /** Volume inizializzato con identità ok: solo le collezioni mancanti. */
  | 'create_missing_collections'
  /** Precondizioni non soddisfatte: nessuna modifica. */
  | 'refuse';

export interface RadicaleInitReport {
  schema: typeof REPORT_SCHEMA;
  apply: boolean;
  principal: string;
  state: { mode: string; epoch: number; volume_id: string | null };
  principal_exists: boolean;
  identity: { status: string; detail: string | null };
  /** Collezioni del piano (quelle che l'inizializzazione crea o verifica), senza `_canary`. */
  collections: Array<{ collection_name: string; role: string }>;
  action: RadicaleInitAction;
  refused: { code: VolumeInitErrorCode; message: string } | null;
  /** Esito dell'esecuzione (solo con apply e azione eseguibile). */
  result: { volume_id: string | null; epoch: number | null; collections: CollectionProvisioning[]; canary: CanaryProvisioning } | null;
}

/**
 * Prova a vuoto o esecuzione. Non lancia per le precondizioni (finiscono in
 * `refused`); lancia per gli errori di database e di rete.
 */
export async function runRadicaleInit(opts: { db: Db; client: RadicaleClient; principal: string; apply: boolean }): Promise<RadicaleInitReport> {
  const { db, client, principal, apply } = opts;
  // Import dinamico: migration/init carica il pool del database, che nasce solo dopo i controlli dell'ambiente.
  const { executeInitialization, planInitialization } = await import('../src/lib/calendar/migration/init');
  const { MigrationError } = await import('../src/lib/calendar/migration/types');
  const { VolumeInitError } = await import('../src/lib/calendar/radicale/identity');

  const plan = await planInitialization({ db, client, principal });
  const report: RadicaleInitReport = {
    schema: REPORT_SCHEMA,
    apply,
    principal,
    state: { mode: plan.state.mode, epoch: plan.state.epoch, volume_id: plan.state.volume_id },
    principal_exists: plan.principal_exists,
    identity: { status: plan.identity.status, detail: plan.identity.detail },
    collections: plan.collections
      .filter((c) => c.kind !== 'system')
      .map((c) => ({ collection_name: c.collection_name, role: c.role ?? 'user' })),
    action: plan.action === 'create_missing' ? 'create_missing_collections' : plan.action,
    refused: plan.refused,
    result: null,
  };
  if (!apply || plan.action === 'refuse') return report;

  try {
    const result = await executeInitialization({ db, client, principal, action: plan.action });
    report.result = { volume_id: result.volume_id, epoch: result.epoch, collections: result.collections, canary: result.canary };
  } catch (err) {
    // Lo stato è cambiato fra la prova e l'esecuzione (es. un'altra istanza o il wizard).
    if (err instanceof VolumeInitError) {
      report.action = 'refuse';
      report.refused = { code: err.code, message: err.message };
      return report;
    }
    if (err instanceof MigrationError && err.code === 'PRECONDITION_FAILED') {
      const reasons = Array.isArray(err.details?.reasons) ? (err.details?.reasons as string[]) : [];
      report.action = 'refuse';
      report.refused = { code: reasons.includes('MODE_NOT_POSTGRES') ? 'state_not_postgres' : 'identity_not_ok', message: err.message };
      return report;
    }
    throw err;
  }
  return report;
}

/** Riepilogo leggibile per stderr. */
export function summarizeRadicaleInit(report: RadicaleInitReport): string {
  const lines = [
    `Stato in PG: mode ${report.state.mode}, epoch ${report.state.epoch}, volume ${report.state.volume_id ?? '(nessuno)'}.`,
    `Principal /${report.principal}/ su Radicale: ${report.principal_exists ? 'presente' : 'assente'}; identità ${report.identity.status}${report.identity.detail ? ` (${report.identity.detail})` : ''}.`,
    `Collezioni del piano: ${report.collections.map((c) => `${c.collection_name} (${c.role})`).join(', ') || 'nessuna'}.`,
  ];
  if (report.refused) {
    lines.push(`RIFIUTATO (${report.refused.code}): ${report.refused.message}`);
  } else if (!report.apply) {
    lines.push(report.action === 'initialize'
      ? 'Prova a vuoto: con --apply verrebbero creati principal, marker (epoch 1), collezioni e _canary.'
      : 'Prova a vuoto: con --apply verrebbero create solo le collezioni mancanti (e _canary, se manca).');
  } else if (report.result) {
    const byStatus = (status: CollectionProvisioning['status']) => report.result!.collections.filter((c) => c.status === status).map((c) => c.collectionName);
    lines.push(`Eseguito: volume ${report.result.volume_id}, epoch ${report.result.epoch}.`);
    lines.push(`Collezioni create: ${byStatus('created').join(', ') || 'nessuna'}; già presenti: ${byStatus('exists').join(', ') || 'nessuna'}.`);
    lines.push(`Collezione _canary del campanello: ${report.result.canary === 'created' ? 'creata' : report.result.canary === 'exists' ? 'già presente' : 'non richiesta'}.`);
    const conflicts = report.result.collections.filter((c) => c.status === 'conflict');
    if (conflicts.length) lines.push(`CONFLITTI (non toccati): ${conflicts.map((c) => `${c.collectionName}: ${c.detail ?? ''}`).join('; ')}`);
  }
  return lines.join('\n');
}

const USAGE = `Uso: pnpm calendar:radicale-init [-- --apply]

Senza opzioni: prova a vuoto (nessuna modifica).
  --apply   inizializza il volume (MKCOL, marker, stato in PG, collezioni)
            o crea le collezioni mancanti di un volume già inizializzato
  -h        questo aiuto

Variabili: DATABASE_URL, RADICALE_URL, RADICALE_SVC_PASSWORD, RADICALE_SVC_USER,
RADICALE_PRINCIPAL, RADICALE_TIMEOUT_MS.`;

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function main(argv: string[]): Promise<number> {
  let values: { apply?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      // pnpm (dalla 7) inoltra allo script anche il separatore '--'.
      args: argv.filter((a) => a !== '--'),
      options: { apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${describeError(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL non impostata.');
    return 2;
  }
  const principal = process.env.RADICALE_PRINCIPAL?.trim() || DEFAULT_PRINCIPAL;
  if (!isValidPrincipal(principal)) {
    console.error(`RADICALE_PRINCIPAL non valido: ${JSON.stringify(principal)}`);
    return 2;
  }
  let client: RadicaleClient | null;
  try {
    client = radicaleClientFromEnv(process.env);
  } catch (err) {
    console.error(`Configurazione del client Radicale non valida: ${describeError(err)}`);
    return 2;
  }
  if (!client) {
    console.error('RADICALE_URL non impostata: lo script va eseguito dove l\'API raggiunge Radicale (container api, rete caldav-int).');
    return 2;
  }

  // Import dinamico: il pool nasce solo qui, dopo i controlli dell'ambiente.
  const { sql } = await import('../src/db');
  try {
    const report = await runRadicaleInit({ db: sql, client, principal, apply: !!values.apply });
    console.log(JSON.stringify(report, null, 2));
    console.error(summarizeRadicaleInit(report));
    return report.refused ? 3 : 0;
  } catch (err) {
    console.error(`Errore: ${describeError(err)}`);
    return 1;
  } finally {
    client.close();
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
