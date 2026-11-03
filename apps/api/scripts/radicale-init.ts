/**
 * Inizializzazione del volume di Radicale, a mano, in F1 (piano F1; contratto
 * docs/calendar-radicale/contracts/control-plane.md §4.4; design §6.3 e
 * §13.3). Dalla F3 lo stesso passo lo esegue il wizard della migrazione: qui
 * c'è solo un involucro di riga di comando attorno a initializeVolume() e
 * createMissingCollections() di src/lib/calendar/radicale/identity.ts.
 *
 * Senza opzioni è una prova a vuoto: legge lo stato in PG, controlla il
 * principal su Radicale come caldes-svc, verifica l'identità e stampa che cosa
 * farebbe. Con --apply esegue:
 *  - volume mai inizializzato (mode postgres, epoch 0, principal assente):
 *    MKCOL del principal, marker volume-id/epoch 1, UPDATE dello stato,
 *    MKCALENDAR delle collezioni del sidecar (con le dead prop calendar-id e
 *    role) e della collezione di sistema `_canary` (canary del campanello,
 *    F2). Il NOTIFY dello stato fa riscrivere subito policy.json al
 *    control-plane dell'API in esecuzione;
 *  - volume già inizializzato con identità ok: solo le collezioni del sidecar
 *    che mancano su Radicale (es. un calendario creato dall'admin dopo) e
 *    `_canary` se manca (i volumi inizializzati in F1 non ce l'hanno: senza,
 *    il campanello della F2 resta in remote mode);
 *  - in ogni altro caso rifiuta (exit 3): un volume non vuoto senza marker, o
 *    con un marker diverso da PG, non viene mai inizializzato né adottato.
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
import { principalPath, type RadicaleClient, radicaleClientFromEnv } from '../src/lib/calendar/radicale/client';
import { DAV_PROPS } from '../src/lib/calendar/radicale/dav-xml';
import {
  type CanaryProvisioning,
  type CollectionProvisioning,
  checkVolumeIdentity,
  createMissingCollections,
  ensureCanaryCollection,
  initializeVolume,
  remoteIdentitySource,
  VolumeInitError,
  type VolumeInitErrorCode,
} from '../src/lib/calendar/radicale/identity';
import { type Db, readBackendState, readSidecarCollections } from '../src/lib/calendar/radicale/policy';
import { DEFAULT_PRINCIPAL, isValidCollectionName, isValidPrincipal } from '../src/lib/calendar/radicale/types';

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
  /** Collezioni del sidecar attive con collection_name valido (quelle che l'inizializzazione crea). */
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
  const state = await readBackendState(db);
  const props = await client.readProps(principalPath(principal), [DAV_PROPS.resourcetype]);
  const principalExists = props !== null;
  const identity = await checkVolumeIdentity(state, remoteIdentitySource(client), principal);
  const collections = (await readSidecarCollections(db))
    .filter((c) => c.lifecycle === 'active' && isValidCollectionName(c.collection_name))
    .map((c) => ({ collection_name: c.collection_name as string, role: c.role }));

  const report: RadicaleInitReport = {
    schema: REPORT_SCHEMA,
    apply,
    principal,
    state: { mode: state.mode, epoch: state.epoch, volume_id: state.volume_id },
    principal_exists: principalExists,
    identity: { status: identity.status, detail: identity.detail },
    collections,
    action: 'refuse',
    refused: null,
    result: null,
  };

  // Stesse precondizioni di initializeVolume(), valutate qui per la prova a vuoto.
  if (state.mode !== 'postgres') {
    report.refused = { code: 'state_not_postgres', message: `inizializzazione ammessa solo in mode postgres (ora ${state.mode})` };
  } else if (state.epoch === 0) {
    if (principalExists) {
      report.refused = {
        code: 'principal_exists',
        message: `il principal /${principal}/ esiste già su Radicale ma PG non registra alcun volume: un volume non vuoto non viene mai adottato (serve la riassegnazione d'identità, F3)`,
      };
    } else {
      report.action = 'initialize';
    }
  } else if (identity.status === 'ok') {
    report.action = 'create_missing_collections';
  } else {
    report.refused = {
      code: 'identity_not_ok',
      message: `volume già registrato in PG (epoch ${state.epoch}) ma identità ${identity.status}${identity.detail ? ` (${identity.detail})` : ''}: nessuna modifica`,
    };
  }

  if (!apply || report.action === 'refuse') return report;

  try {
    if (report.action === 'initialize') {
      const result = await initializeVolume({ db, client, principal });
      report.result = { volume_id: result.volumeId, epoch: result.epoch, collections: result.collections, canary: result.canary };
    } else {
      const created = await createMissingCollections({ db, client, principal });
      const canary = await ensureCanaryCollection({ db, client, principal });
      report.result = { volume_id: state.volume_id, epoch: state.epoch, collections: created, canary };
    }
  } catch (err) {
    // Lo stato è cambiato fra la prova e l'esecuzione (es. un'altra istanza).
    if (err instanceof VolumeInitError) {
      report.action = 'refuse';
      report.refused = { code: err.code, message: err.message };
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
    `Collezioni del sidecar: ${report.collections.map((c) => `${c.collection_name} (${c.role})`).join(', ') || 'nessuna'}.`,
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
