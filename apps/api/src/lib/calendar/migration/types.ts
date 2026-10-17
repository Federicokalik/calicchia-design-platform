/**
 * Tipi, costanti e funzioni pure condivise dallo strumento di migrazione del
 * calendario a Radicale (fase F3 del piano; design §13.1-§13.8, §16.2,
 * §16.4, §16.6; contratto docs/calendar-radicale/contracts/f3-modules.md).
 *
 * È il punto d'incontro dei sei gruppi della F3 (INIT, SERIALIZE, APPLY,
 * SHADOW, ROUTES, OPS) e del wizard dell'admin: run e righe dei run
 * (migrazione 165), ledger a tre vie, codici delle anomalie, dei conflitti,
 * dei controlli e delle differenze V1-V5, opzioni dell'anteprima, conferme
 * digitate, dichiarazioni del wizard, contratto dati dell'API REST
 * /api/admin/calendar/migration.
 *
 * Modulo foglia e puro: nessun I/O, nessun database, nessun orologio
 * implicito. Importa dagli altri moduli solo tipi e costanti foglia
 * (index-model.ts, radicale/types.ts). Un gruppo che ha bisogno di un codice o
 * di un campo nuovo aggiorna prima il contratto f3-modules.md, poi questo file
 * (e, se tocca il database, una migrazione successiva alla 165).
 *
 * Convenzioni dei DTO REST: chiavi snake_case come il resto dell'API admin,
 * istanti in ISO 8601 UTC (`toISOString()`), id delle righe int8 come stringa
 * (contratto f2-modules §2.1), id UUID minuscoli.
 */

import type { Logger } from 'pino';
import type { CanaryProvisioning, CollectionProvisioning } from '../radicale/identity';
import type { Db } from '../radicale/policy';
// Solo tipo (cancellato in compilazione): l'anteprima leggibile la costruisce plan.ts.
import type { PlanPreview } from './plan';
import {
  type BackendMode,
  type CalendarBackendState,
  type CalendarLifecycle,
  type CalendarOrigin,
  type CalendarRole,
  type IdentityStatus,
  normalizeBackendState,
} from '../radicale/types';
import { CAL_LOCKS, INDEX_LIMITS } from '../index-model';

// ─── Versioni ───────────────────────────────────────────────

/** Versione di questo contratto (cambia con una modifica incompatibile dei DTO REST). */
export const MIGRATION_CONTRACT_VERSION = 1 as const;

/**
 * Fase del piano in cui gira questo codice: dalla F4 esistono cutover,
 * rollback, anteprima del rollback, ri-baseline e finalize (route, esecutore
 * e wizard; contratto f4-modules §6).
 */
export const MIGRATION_PHASE = 'F4' as const;

/**
 * Livello del protocollo calendario di questa build dell'API (design §16.6):
 * l'avvio confronta `calendar_backend_state.api_min_version` con questo
 * valore e, se il database chiede di più, non serve il calendario. Sale di uno
 * a ogni release che cambia il significato dello stato: 3 in F3, 4 dalla F4
 * (guardia 166, proiezione inversa, righe derivate). Il cutover scrive questo
 * valore in api_min_version (contratto f4-modules §3.4).
 */
export const CALENDAR_API_LEVEL = 4 as const;

// ─── Lock, job e limiti ─────────────────────────────────────

/**
 * Lock dello strumento (design §13.2): `pg_advisory_lock(hashtext('cal-migration'))`
 * tenuto dall'esecutore di un run per tutta la sua durata, su una connessione
 * riservata del pool principale (mai di `calSql`), e preso con
 * `pg_try_advisory_lock` da ogni job shadow_mirror. Ordine ammesso:
 * cal-migration → cal-sync:* e cal-migration → cal-write (F4); mai il contrario.
 */
export const MIGRATION_LOCK_KEY = CAL_LOCKS.migration;

/** Tipo del job di cal_jobs che esegue un run in background (ripreso dopo un riavvio). */
export const MIGRATION_RUN_JOB_KIND = 'migration_run' as const;

/** Tipo del job dello shadow mirror (riservato in jobs.ts, accodato dai trigger della 165). */
export const SHADOW_MIRROR_JOB_KIND = 'shadow_mirror' as const;

export const MIGRATION_LIMITS = Object.freeze({
  /** Scritture verso Radicale di apply, shadow e archivio (≤ 20 PUT/s degli scrittori di sistema, design §8). */
  maxPutsPerSecond: INDEX_LIMITS.maxSystemPutsPerSecond,
  /** Battito dell'esecutore (heartbeat_at e lease del job). */
  heartbeatIntervalMs: 15_000,
  /** Un run 'running' senza battito da così tanto, con il lock libero, è interrotto. */
  staleHeartbeatMs: 5 * 60_000,
  /** Lease del job migration_run (esteso dal battito). */
  runJobLeaseMs: 60_000,
  /** Tentativi del job migration_run prima della dead letter (il run diventa interrupted). */
  runJobMaxAttempts: 3,
  /** Intervallo minimo fra due scritture dell'avanzamento in cal_migration_runs. */
  progressWriteIntervalMs: 1_000,
  /** V3: finestre di al più 60 giorni (il legacy espande al massimo 500 occorrenze per master, design §13.7). */
  v3WindowDays: 60,
  /** V3: intervallo [oggi − 365, oggi + 730]. */
  v3PastDays: 365,
  v3FutureDays: 730,
  /** V4: busy identico su [oggi, oggi + 180]. */
  v4Days: 180,
  /** V4 orario dello shadow: prossimi 14 giorni (design §13.8). */
  v4HourlyDays: 14,
  /** Giorni di parità verde richiesti prima del cutover (design §13.8). */
  parityDaysRequired: 7,
  /** Backup coordinato richiesto dal preflight: meno di 24 ore (design §13.3). */
  backupMaxAgeHours: 24,
  /** Validità di una dichiarazione "backup verificato" fatta a mano. */
  backupDeclarationValidHours: 24,
  /** Retention di run e righe (design §16.4: piani di migrazione cancellati dopo 30 giorni). */
  runRetentionDays: 30,
  /** Anteprima più vecchia di così: il passo "Anteprima" torna da rivedere. */
  planMaxAgeHours: 24,
  /** Archivio della Fase 0 caricato dal wizard. */
  archiveMaxBytes: 20 * 1024 * 1024,
  archiveMaxItems: 20_000,
  /** Paginazione delle righe di un run. */
  itemsPageDefault: 100,
  itemsPageMax: 500,
  /** Debounce dei job shadow_mirror accodati dai trigger (165). */
  shadowDebounceMs: 2_000,
});

// ─── Run ────────────────────────────────────────────────────

/**
 * Tipi di run (CHECK cal_migration_runs_kind_check). Quelli della F4
 * (cutover, rollback_preview, rollback, rebaseline, finalize) sono ammessi dal
 * database ma in F3 nessuno li crea: le route rispondono PHASE_NOT_AVAILABLE.
 */
export const MIGRATION_RUN_KINDS = [
  'preflight', 'init', 'archive', 'identity', 'inventory', 'plan', 'apply', 'verify',
  'cutover', 'rollback_preview', 'rollback', 'rebaseline', 'finalize',
] as const;
export type MigrationRunKind = (typeof MIGRATION_RUN_KINDS)[number];

/** Run che la F3 può creare. */
export const F3_RUN_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>([
  'preflight', 'init', 'archive', 'identity', 'inventory', 'plan', 'apply', 'verify',
]);

/** Run che scrivono su Radicale o sullo stato: richiedono conferma digitata e chiave d'idempotenza. */
export const WRITING_RUN_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>([
  'init', 'archive', 'identity', 'apply',
]);

export const MIGRATION_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type MigrationRunStatus = (typeof MIGRATION_RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: readonly MigrationRunStatus[] = Object.freeze(['queued', 'running']);
export const TERMINAL_RUN_STATUSES: readonly MigrationRunStatus[] = Object.freeze(['succeeded', 'failed', 'cancelled', 'interrupted']);

export function isActiveRunStatus(status: MigrationRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** admin (wizard), schedule (cadenza dello shadow), shadow (catch-up all'attivazione), restore (dopo un import), system. */
export const MIGRATION_RUN_TRIGGERS = ['admin', 'schedule', 'shadow', 'restore', 'system'] as const;
export type MigrationRunTrigger = (typeof MIGRATION_RUN_TRIGGERS)[number];

/** Avanzamento di un run (cal_migration_runs.progress). */
export interface MigrationProgress {
  /** Fase corrente, codice breve (es. 'read-legacy', 'read-target', 'write', 'v3'). */
  phase: string;
  done?: number;
  total?: number;
  calendar_id?: string | null;
  /** Testo per il wizard, in italiano, senza dati personali. */
  message?: string | null;
}

/** Codici di errore di un run (cal_migration_runs.error_code). */
export const MIGRATION_RUN_ERROR_CODES = [
  'PRECONDITION_FAILED',
  'PLAN_CHANGED',
  'MODE_CHANGED',
  'IDENTITY_NOT_OK',
  'IDENTITY_CHANGED',
  'RADICALE_NOT_CONFIGURED',
  'RADICALE_UNREACHABLE',
  'PRINCIPAL_EXISTS',
  'STATE_CHANGED',
  'ARCHIVE_INVALID',
  'LOCK_TIMEOUT',
  'CANCELLED',
  'INTERRUPTED',
  'INTERNAL',
  // F4 (contratto f4-modules §9): transizioni, quiescenza, proiezione inversa.
  /** Un'altra transizione è attiva, o lo stato non è quello che la transizione si aspetta. */
  'TRANSITION_CONFLICT',
  /** Gate cal-write esclusivo non ottenuto entro il tempo massimo (scritture in corso). */
  'GATE_TIMEOUT',
  /** Device non quiescenti: la PUT del probe su _canary non riceve 403, o le directory non si fermano. */
  'QUIESCENCE_TIMEOUT',
  /** Password di caldes-probe non disponibile: la quiescenza non è verificabile. */
  'PROBE_UNAVAILABLE',
  /** Control-plane non attivo o policy non scritta: lo stato non arriva ai device. */
  'CONTROL_PLANE_UNAVAILABLE',
  /** Marker del volume diverso da quello atteso nel passo d'epoch. */
  'EPOCH_CONFLICT',
  /** Cutover annullato prima del passo d'epoch (verifica rossa, conflitti del delta, richiesta dell'admin). */
  'CUTOVER_ABORTED',
  /** Rollback annullato prima del passo d'epoch (anteprima cambiata senza emergenza, richiesta dell'admin). */
  'ROLLBACK_ABORTED',
  /** Anteprima del rollback diversa da quella confermata (degradi o oggetti cambiati dopo la conferma). */
  'PREVIEW_CHANGED',
  /** Verifica del delta del cutover con differenze rosse. */
  'VERIFY_RED',
  /** Proiezione inversa con upsert non riusciti (REVERSE_FAILED) dove non ammessi. */
  'REVERSE_FAILED',
] as const;
export type MigrationRunErrorCode = (typeof MIGRATION_RUN_ERROR_CODES)[number];

// ─── Righe dei run ──────────────────────────────────────────

export const MIGRATION_ITEM_TYPES = ['check', 'anomaly', 'object', 'collection', 'diff', 'degradation'] as const;
export type MigrationItemType = (typeof MIGRATION_ITEM_TYPES)[number];

/** Azioni del piano per oggetto (design §13.6). */
export const PLAN_ACTIONS = ['create', 'update', 'delete', 'noop', 'adopt', 'skip', 'conflict'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/** Le sole azioni che scrivono su Radicale: "seconda esecuzione a zero scritture" = nessuna di queste. */
export const WRITE_ACTIONS: ReadonlySet<PlanAction> = new Set<PlanAction>(['create', 'update', 'delete']);

export function isWriteAction(action: PlanAction): boolean {
  return WRITE_ACTIONS.has(action);
}

/** Esiti dell'apply per oggetto. */
export const APPLY_OUTCOMES = ['done', 'adopted', 'noop', 'skipped', 'conflict', 'failed', 'forced'] as const;
export type ApplyOutcome = (typeof APPLY_OUTCOMES)[number];

export const ITEM_SEVERITIES = ['info', 'warning', 'error'] as const;
export type ItemSeverity = (typeof ITEM_SEVERITIES)[number];

export const VERIFY_LEVELS = ['V1', 'V2', 'V3', 'V4', 'V5'] as const;
export type VerifyLevel = (typeof VERIFY_LEVELS)[number];

/** Riga da aggiungere a un run (l'esecutore assegna seq e id). */
export interface MigrationItemInput {
  item_type: MigrationItemType;
  calendar_id?: string | null;
  collection_name?: string | null;
  href?: string | null;
  legacy_key?: string | null;
  action?: PlanAction | null;
  outcome?: ApplyOutcome | null;
  code?: string | null;
  level?: VerifyLevel | null;
  severity?: ItemSeverity;
  expected?: boolean | null;
  /** Mai email, telefoni, messaggi o descrizioni delle prenotazioni (contratto §5.4). */
  detail?: Record<string, unknown>;
  forced?: boolean;
}

// ─── Ledger ─────────────────────────────────────────────────

/**
 * Tipo di oggetto del ledger (cal_migration_ledger.kind):
 * - event: un master legacy con i suoi override (anche cancellati → EXDATE);
 * - detached: override orfano convertito in evento singolo (`<uid>-det-<epoch>`);
 * - booking: proiezione di una prenotazione rigenerata da calendar_bookings;
 * - archive: item del volume della Fase 0 (decisione 7).
 */
export const LEDGER_KINDS = ['event', 'detached', 'booking', 'archive'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEDGER_INTENT_OPS = ['create', 'update', 'delete'] as const;
export type LedgerIntentOp = (typeof LEDGER_INTENT_OPS)[number];

/** Chiave della sorgente: `event:<uuid del master>`, `detached:<uuid>`, `booking:<uid>`, `archive:<nome>`. */
export type LegacyKey = `${LedgerKind}:${string}`;

export function legacyKey(kind: LedgerKind, id: string): LegacyKey {
  if (!id) throw new TypeError(`identificativo vuoto per la chiave ${kind}`);
  return `${kind}:${id}` as LegacyKey;
}

export function parseLegacyKey(key: string): { kind: LedgerKind; id: string } | null {
  const sep = key.indexOf(':');
  if (sep <= 0 || sep === key.length - 1) return null;
  const kind = key.slice(0, sep);
  if (!(LEDGER_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as LedgerKind, id: key.slice(sep + 1) };
}

/** Formato di legacy_hash e intent_legacy_hash: `s<versione del serializer>:<sha256>`. */
export const LEGACY_HASH_RE = /^s[0-9]{1,6}:[0-9a-f]{64}$/;

/** Riga di cal_migration_ledger (int8 come stringa, timestamptz come Date). */
export interface LedgerRow {
  id: string;
  calendar_id: string;
  collection_name: string;
  href: string;
  kind: LedgerKind;
  legacy_key: LegacyKey;
  legacy_event_id: string | null;
  uid: string | null;
  legacy_snapshot: LegacySnapshot | null;
  legacy_hash: string | null;
  written_etag: string | null;
  written_fingerprint: string | null;
  written_at: Date | null;
  intent_op: LedgerIntentOp | null;
  intent_fingerprint: string | null;
  intent_legacy_hash: string | null;
  intent_snapshot: LegacySnapshot | null;
  intent_etag: string | null;
  intent_at: Date | null;
  intent_run_id: string | null;
  adopted: boolean;
  derived: boolean;
  revalidate_reason: string | null;
  revalidate_since: Date | null;
  deleted_at: Date | null;
  last_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Riga viva con un intento pendente (design §13.6): al giro successivo si legge la destinazione. */
export function hasPendingIntent(row: Pick<LedgerRow, 'intent_op'>): boolean {
  return row.intent_op !== null;
}

/** Calendario come entra nello snapshot del serializer. */
export interface CalendarSnapshot {
  id: string;
  collection_name: string;
  timezone: string;
  role: CalendarRole;
}

/** Riga di calendar_events come entra nello snapshot (istanti in ISO UTC). */
export interface LegacyEventRowSnapshot {
  id: string;
  uid: string;
  calendar_id: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  rrule: string | null;
  exdates: string[];
  recurrence_id: string | null;
  recurrence_master_id: string | null;
  source: string;
  source_id: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

/** Opzioni dell'anteprima che hanno cambiato l'uscita per questo oggetto (entrano nell'hash). */
export interface SnapshotOptions {
  fix_until_admin_pattern?: boolean;
  realign_dst_exceptions?: boolean;
  orphans?: OrphanPolicy;
  moved_to_calendar_id?: string | null;
  /**
   * DTSTART fuori dalla regola (anomalia DTSTART_NOT_IN_RULE): l'oggetto parte
   * dalla prima occorrenza della semantica legacy (rrule.js non conta il
   * DTSTART che non soddisfa la regola, RFC 5545 sì), con la stessa durata.
   */
  realign_dtstart?: boolean;
}

export interface LegacyEventSnapshot {
  v: 1;
  kind: 'event';
  calendar: CalendarSnapshot;
  master: LegacyEventRowSnapshot;
  overrides: LegacyEventRowSnapshot[];
  options: SnapshotOptions;
}

export interface LegacyDetachedSnapshot {
  v: 1;
  kind: 'detached';
  calendar: CalendarSnapshot;
  master_id: string;
  master_uid: string;
  override: LegacyEventRowSnapshot;
  options: SnapshotOptions;
}

/** Proiezione: i soli dati che entrano nel contenuto della decisione 3 (nome e telefono compresi: GDPR §16.4). */
export interface LegacyBookingSnapshot {
  v: 1;
  kind: 'booking';
  calendar: CalendarSnapshot;
  booking: {
    uid: string;
    status: string;
    start_time: string;
    end_time: string;
    title: string;
    attendee_name: string;
    attendee_phone: string | null;
    location: string | null;
    meeting_url: string | null;
    created_at: string | null;
  } | null;
  /** Riga legacy della proiezione (source='booking', source_id=uid), se esiste. */
  legacy_event_id: string | null;
  legacy_uid: string | null;
  /** Contenuto ridotto a "Prenotazione" (oltre 24 mesi, prenotazione sparita o anonimizzata). */
  minimized: boolean;
}

export interface ArchiveSnapshot {
  v: 1;
  kind: 'archive';
  source_name: string;
  sha256: string;
}

/**
 * Ingresso canonico del serializer per una riga del ledger. LegacyDerivedSnapshot
 * (F4, contratto f4-modules §5.6) è il gruppo delle righe derivate di una
 * risorsa espansa dalla proiezione inversa: non si ricostruisce mai un
 * oggetto da lì (il piano dà noop o DERIVED_EDITED).
 */
export type LegacySnapshot = LegacyEventSnapshot | LegacyDetachedSnapshot | LegacyBookingSnapshot | ArchiveSnapshot | LegacyDerivedSnapshot;

// ─── Conflitti e salti del piano ────────────────────────────

/**
 * Conflitti del piano (design §13.6): mai sovrascritti, salvo "forza"
 * esplicito sul singolo item o per codice.
 * - TARGET_NEWER: sorgente invariata, destinazione cambiata fuori dallo strumento;
 * - BOTH_CHANGED: cambiate entrambe;
 * - UNTRACKED_TARGET: destinazione presente e non tracciata con un contenuto
 *   diverso (anche un intento pendente con un contenuto che non è né quello
 *   voluto né quello scritto);
 * - DELETED_IN_TARGET: scritta e poi sparita dalla destinazione;
 * - UID_AT_OTHER_HREF: 409 no-uid-conflict (o UID trovato nella lettura della
 *   collezione) a un altro href con un contenuto diverso dal piano;
 * - COLLECTION_MISSING: la collezione non esiste (mai creata fuori dall'init);
 * - REVALIDATION_REQUIRED: riga del ledger da rivalidare dopo un import di
 *   backup o una riassegnazione d'identità (design §16.2);
 * - DERIVED_EDITED: riga derivata dalla proiezione inversa modificata in PG (F4).
 */
export const CONFLICT_CODES = [
  'TARGET_NEWER',
  'BOTH_CHANGED',
  'UNTRACKED_TARGET',
  'DELETED_IN_TARGET',
  'UID_AT_OTHER_HREF',
  'COLLECTION_MISSING',
  'REVALIDATION_REQUIRED',
  'DERIVED_EDITED',
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

/** Conflitti che "forza" può risolvere scrivendo il contenuto del piano. COLLECTION_MISSING mai: serve l'init. */
export const FORCEABLE_CONFLICTS: ReadonlySet<ConflictCode> = new Set<ConflictCode>([
  'TARGET_NEWER', 'BOTH_CHANGED', 'UNTRACKED_TARGET', 'DELETED_IN_TARGET', 'UID_AT_OTHER_HREF', 'REVALIDATION_REQUIRED',
  // F4 (contratto f4-modules §5.6): "mantieni la risorsa di Radicale", l'unica forzatura senza scrittura.
  'DERIVED_EDITED',
]);

/** Sorgenti non migrate per scelta del design o delle opzioni (azione skip, nessuna scrittura). */
export const SKIP_CODES = [
  /** Master STATUS cancelled: non migrato (design §13.4). */
  'CANCELLED_MASTER',
  /** UNTIL precedente al DTSTART: non migrata, nel report (design §13.5). */
  'UNTIL_BEFORE_DTSTART',
  /** Override orfano con l'opzione "scarta". */
  'ORPHAN_DISCARDED',
  /** Proiezione di una prenotazione non proiettata (pending, cancelled, rescheduled): la riga legacy resta com'è. */
  'BOOKING_NOT_PROJECTED',
  /** Calendario escluso dal piano (sidecar d'iscrizione, archivio, collection_name non valido, non attivo). */
  'EXCLUDED_CALENDAR',
  /** Oggetto che calendar-core rifiuta (validateObject) o che Radicale rifiuterebbe. */
  'INVALID_OBJECT',
  /** Festività duplicata: la seconda per la stessa data non si migra. */
  'DUPLICATE_HOLIDAY',
] as const;
export type SkipCode = (typeof SKIP_CODES)[number];

// ─── Anomalie (design §13.4) ────────────────────────────────

export const ANOMALY_CODES = [
  'ORPHAN_OVERRIDE_NOT_IN_RULE',
  'OVERRIDE_CALENDAR_MISMATCH',
  'UNTIL_ADMIN_PATTERN',
  'ALLDAY_UNTIL_DATETIME',
  'ALLDAY_EXDATE_DATETIME',
  'ALLDAY_AMBIGUOUS',
  'INVALID_RRULE',
  'UNTIL_BEFORE_DTSTART',
  'RADICALE_RRULE_LIMIT',
  'NON_ROME_SERIES',
  'CANCELLED_MASTER',
  'DST_SHIFTED_EXCEPTION',
  'MIXED_BYDAY',
  'DTSTART_NOT_IN_RULE',
  'DUPLICATE_HOLIDAY',
  'POSSIBLE_DUPLICATE',
  'BOOKING_DRIFT',
  'NON_PROJECTION_IN_BOOKINGS',
  'ICS_PULL_REFETCH',
  'SUBSCRIPTION_BLOCKING_IMPACT',
  'NON_CANONICAL_APP_PASSWORD',
  'RESERVED_APP_PASSWORD',
  'EVENTS_IN_EXCLUDED_CALENDAR',
  'COLLECTION_NAME_INVALID',
  'INVALID_OBJECT',
] as const;
export type AnomalyCode = (typeof ANOMALY_CODES)[number];

export interface AnomalyDefinition {
  severity: ItemSeverity;
  /** Blocca l'apply finché non è risolta (in PG o con un'opzione). */
  blocking: boolean;
  /** Opzione dell'anteprima che la governa, se c'è. */
  option: keyof MigrationOptions | null;
  /** Descrizione per il wizard. */
  description: string;
}

export const ANOMALY_DEFINITIONS: Readonly<Record<AnomalyCode, AnomalyDefinition>> = Object.freeze({
  ORPHAN_OVERRIDE_NOT_IN_RULE: { severity: 'warning', blocking: false, option: 'orphans', description: 'Override il cui RECURRENCE-ID non appartiene più alla regola: convertito in evento singolo (default) o scartato.' },
  OVERRIDE_CALENDAR_MISMATCH: { severity: 'warning', blocking: false, option: null, description: 'Override in un calendario diverso da quello del master: migrato nell\'oggetto del master.' },
  UNTIL_ADMIN_PATTERN: { severity: 'warning', blocking: false, option: 'fix_until_admin_pattern', description: 'UNTIL salvato dall\'admin a mezzanotte UTC del giorno "fino al": riallineato a fine giornata locale (default).' },
  ALLDAY_UNTIL_DATETIME: { severity: 'warning', blocking: false, option: null, description: 'Serie tutto il giorno con UNTIL orario: scritto come DATE.' },
  ALLDAY_EXDATE_DATETIME: { severity: 'warning', blocking: false, option: null, description: 'Serie tutto il giorno con EXDATE orari: scritti come DATE.' },
  ALLDAY_AMBIGUOUS: { severity: 'warning', blocking: false, option: null, description: 'Evento tutto il giorno con orari non a mezzanotte: data calcolata con la regola +12 h.' },
  INVALID_RRULE: { severity: 'warning', blocking: false, option: null, description: 'RRULE non valida: migrato come evento singolo con X-CALDES-LEGACY-RRULE.' },
  UNTIL_BEFORE_DTSTART: { severity: 'warning', blocking: false, option: null, description: 'Serie con UNTIL precedente al DTSTART: non migrata.' },
  RADICALE_RRULE_LIMIT: { severity: 'error', blocking: false, option: null, description: 'Serie oltre il limite di occorrenze di Radicale: non migrata finché non viene corretta in PG.' },
  NON_ROME_SERIES: { severity: 'info', blocking: false, option: null, description: 'Serie di un calendario con fuso diverso da Europe/Rome: scritta in Europe/Rome come la espande il legacy.' },
  CANCELLED_MASTER: { severity: 'info', blocking: false, option: null, description: 'Master cancellato: non migrato.' },
  DST_SHIFTED_EXCEPTION: { severity: 'warning', blocking: false, option: 'realign_dst_exceptions', description: 'EXDATE o RECURRENCE-ID con l\'ora UTC del DTSTART ma un\'ora di Roma diversa (codice precedente al fix DST): riallineato (default).' },
  MIXED_BYDAY: { severity: 'warning', blocking: false, option: null, description: 'BYDAY misto in una serie mensile o annuale: Radicale e i device mostrano l\'unione RFC 5545, il legacy l\'intersezione. Entrambe le espansioni sono nel dettaglio.' },
  DTSTART_NOT_IN_RULE: { severity: 'warning', blocking: false, option: null, description: 'Serie con la data d\'inizio fuori dalla regola: il legacy non la mostra come occorrenza, RFC 5545 e i device sì. Migrata dalla prima occorrenza del legacy (stessa durata); il feed di oggi la pubblica già con l\'occorrenza in più.' },
  DUPLICATE_HOLIDAY: { severity: 'warning', blocking: false, option: null, description: 'Più festività di sistema per la stessa data: si migra la prima.' },
  POSSIBLE_DUPLICATE: { severity: 'info', blocking: false, option: null, description: 'Evento identico a un altro (stesso calendario, titolo e orari), per esempio una copia fatta con "Duplica": migrato così com\'è.' },
  BOOKING_DRIFT: { severity: 'warning', blocking: false, option: null, description: 'Prenotazione confermata senza proiezione, proiezione senza prenotazione o orari divergenti: la proiezione si rigenera dalla prenotazione.' },
  NON_PROJECTION_IN_BOOKINGS: { severity: 'info', blocking: false, option: 'bookings_move_event_ids', description: 'Evento manuale nel calendario Prenotazioni: resta lì (default, decisione 8) o si sposta nel calendario scelto.' },
  ICS_PULL_REFETCH: { severity: 'info', blocking: false, option: null, description: 'Iscrizione che al passaggio verrà riscaricata da capo (validatori azzerati): non copiata nel volume.' },
  SUBSCRIPTION_BLOCKING_IMPACT: { severity: 'info', blocking: false, option: null, description: 'Ore occupate e slot persi a settimana se si abilitasse "blocca disponibilità" per l\'iscrizione (decisione 5).' },
  NON_CANONICAL_APP_PASSWORD: { severity: 'info', blocking: false, option: null, description: 'App-password con username diverso dal principal: continua a funzionare, mappata sul principal canonico.' },
  RESERVED_APP_PASSWORD: { severity: 'error', blocking: true, option: null, description: 'App-password attiva con username riservato (caldes-*): va revocata dall\'admin prima di procedere.' },
  EVENTS_IN_EXCLUDED_CALENDAR: { severity: 'warning', blocking: false, option: null, description: 'Righe legacy in un calendario escluso dal piano (sidecar d\'iscrizione o archivio): non migrate.' },
  COLLECTION_NAME_INVALID: { severity: 'error', blocking: true, option: null, description: 'Calendario senza un nome di collezione valido (needs_review): escluso finché non viene corretto.' },
  INVALID_OBJECT: { severity: 'error', blocking: false, option: null, description: 'Oggetto che calendar-core o Radicale rifiuterebbero: non migrato, va corretto in PG.' },
});

/** Anomalia rilevata (inventario, serializer, piano). */
export interface AnomalyRecord {
  code: AnomalyCode;
  calendar_id: string | null;
  legacy_key: string | null;
  severity: ItemSeverity;
  /** Senza dati personali: id, uid, date, conteggi, titoli degli eventi non di prenotazione. */
  detail: Record<string, unknown>;
}

// ─── Opzioni dell'anteprima (design §13.4) ─────────────────

export type OrphanPolicy = 'convert' | 'discard';

export interface MigrationOptions {
  /** Correggi UNTIL "fino al" (UNTIL_ADMIN_PATTERN): ON di default. */
  fix_until_admin_pattern: boolean;
  /** Riallinea le eccezioni DST (DST_SHIFTED_EXCEPTION): ON di default. */
  realign_dst_exceptions: boolean;
  /** Override orfani: convertiti in eventi singoli (default) o scartati. */
  orphans: OrphanPolicy;
  /**
   * Eventi non-proiezione del calendario Prenotazioni da spostare (decisione
   * 8, per singolo evento): id dei master legacy. Vuoto = tutti restano lì
   * (default, parità totale). Lo spostamento vale solo per la destinazione
   * Radicale: lo strumento non scrive mai calendar_events.
   */
  bookings_move_event_ids: string[];
  /** Calendario di destinazione degli spostamenti (null = calendario di default, 'lavoro'). */
  bookings_move_target_calendar_id: string | null;
}

export const DEFAULT_MIGRATION_OPTIONS: Readonly<MigrationOptions> = Object.freeze({
  fix_until_admin_pattern: true,
  realign_dst_exceptions: true,
  orphans: 'convert',
  bookings_move_event_ids: [],
  bookings_move_target_calendar_id: null,
});

/** Opzioni complete da quelle parziali di una richiesta (valori non ammessi → MigrationError VALIDATION_FAILED). */
export function resolveMigrationOptions(input: Partial<MigrationOptions> | null | undefined): MigrationOptions {
  const o = input ?? {};
  const bool = (v: unknown, def: boolean, name: string): boolean => {
    if (v === undefined) return def;
    if (typeof v !== 'boolean') throw new MigrationError('VALIDATION_FAILED', `Opzione ${name}: atteso un booleano`);
    return v;
  };
  const orphans = o.orphans ?? DEFAULT_MIGRATION_OPTIONS.orphans;
  if (orphans !== 'convert' && orphans !== 'discard') {
    throw new MigrationError('VALIDATION_FAILED', 'Opzione orphans: valori ammessi convert o discard');
  }
  const ids = o.bookings_move_event_ids ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new MigrationError('VALIDATION_FAILED', 'Opzione bookings_move_event_ids: attesi id UUID');
  }
  const target = o.bookings_move_target_calendar_id ?? null;
  if (target !== null && (typeof target !== 'string' || !UUID_RE.test(target))) {
    throw new MigrationError('VALIDATION_FAILED', 'Opzione bookings_move_target_calendar_id: atteso un id UUID o null');
  }
  return {
    fix_until_admin_pattern: bool(o.fix_until_admin_pattern, DEFAULT_MIGRATION_OPTIONS.fix_until_admin_pattern, 'fix_until_admin_pattern'),
    realign_dst_exceptions: bool(o.realign_dst_exceptions, DEFAULT_MIGRATION_OPTIONS.realign_dst_exceptions, 'realign_dst_exceptions'),
    orphans,
    bookings_move_event_ids: [...new Set(ids.map((id) => id.toLowerCase()))].sort(),
    bookings_move_target_calendar_id: target ? target.toLowerCase() : null,
  };
}

// ─── Controlli del preflight (design §13.3) ────────────────

export const PREFLIGHT_CHECK_CODES = [
  'MODE_POSTGRES',
  'RESTORE_GUARD',
  'RADICALE_CONFIGURED',
  'RADICALE_REACHABLE',
  'RADICALE_VERSION',
  'SERVICE_LOGIN',
  'IDENTITY',
  'COLLECTIONS',
  'CANARY_COLLECTION',
  'PROBE_READONLY',
  'PROBE_CANARY_FORBIDDEN',
  'VOLUME_WATCH',
  'CONTROL_PLANE',
  'SERVICE_PUBLIC_401',
  'RESERVED_APP_PASSWORDS',
  'NON_CANONICAL_APP_PASSWORDS',
  'BACKUP_RECENT',
  'SUBSCRIPTION_SYNC_IDLE',
  'PHASE0_VOLUME',
  'DST_EXCEPTIONS',
] as const;
export type PreflightCheckCode = (typeof PREFLIGHT_CHECK_CODES)[number];

/**
 * pass: ok; warn: da guardare, non blocca; fail: blocca; confirm: blocca
 * finché non c'è la dichiarazione esplicita indicata in `declaration` (poi
 * pass con `declared`); skip: non applicabile adesso (es. probe prima
 * dell'inizializzazione).
 */
export const PREFLIGHT_CHECK_STATUSES = ['pass', 'warn', 'fail', 'confirm', 'skip'] as const;
export type PreflightCheckStatus = (typeof PREFLIGHT_CHECK_STATUSES)[number];

export interface PreflightCheck {
  code: PreflightCheckCode;
  status: PreflightCheckStatus;
  /** Testo per il wizard. */
  message: string;
  /** Dettaglio strutturato (versione, elenco delle collezioni mancanti, diff d'identità...). */
  detail?: Record<string, unknown>;
  /** Cosa fare (es. il comando curl da lanciare sull'host per SERVICE_PUBLIC_401). */
  remedy?: string | null;
  /** Dichiarazione che sblocca un controllo 'confirm'. */
  declaration?: DeclarationKey | null;
  /** true se il controllo è passato grazie a una dichiarazione. */
  declared?: boolean;
}

// ─── Verifica (design §13.7) ───────────────────────────────

export const VERIFY_DIFF_CODES = {
  V1: ['LEDGER_ETAG_MISMATCH', 'LEDGER_TARGET_MISSING', 'TARGET_UNTRACKED', 'LEDGER_INTENT_PENDING', 'COLLECTION_MISSING'],
  V2: ['CONTENT_MISMATCH', 'TARGET_UNPARSABLE', 'PLAN_TARGET_MISSING'],
  V3: ['OCCURRENCE_MISSING', 'OCCURRENCE_EXTRA', 'OCCURRENCE_TIME_DIFF', 'OCCURRENCE_STATUS_DIFF', 'OCCURRENCE_ALLDAY_DIFF'],
  V4: ['BUSY_MISSING', 'BUSY_EXTRA'],
  V5: ['FEED_UID_MISSING', 'FEED_UID_EXTRA', 'FEED_INSTANCES_DIFF'],
} as const satisfies Record<VerifyLevel, readonly string[]>;
export type VerifyDiffCode = (typeof VERIFY_DIFF_CODES)[VerifyLevel][number];

/**
 * Motivi che rendono una differenza ATTESA (gialla, da accettare): fuori da
 * questo elenco la differenza è inattesa (rossa) e blocca il cutover.
 */
export const EXPECTED_DIFF_REASONS = [
  /** Override orfano convertito in evento singolo (V3, V5). */
  'ORPHAN_CONVERTED',
  /** UNTIL "fino al" riallineato (V3, V4). */
  'UNTIL_REALIGNED',
  /** Eccezione DST riallineata (V3, V4, V5; differenza ammessa 5 dei contratti). */
  'DST_REALIGNED',
  /** Override cancellato soppresso nel feed come EXDATE (V5). */
  'CANCELLED_OVERRIDE_SUPPRESSED',
  /** Override pubblicato con l'UID del master (V5; differenza ammessa 1). */
  'OVERRIDE_UID_MASTER',
  /** Proiezione rigenerata dalla prenotazione (V2, V3, V5). */
  'BOOKING_REGENERATED',
  /** BOOKING_DRIFT (V3, V4). */
  'BOOKING_DRIFT',
  /** Iscrizione risincronizzata dal feed (V4 con le iscrizioni). */
  'SUBSCRIPTION_RESYNCED',
  /** Busy delle iscrizioni se si abilitasse "blocca" (V4 con le iscrizioni). */
  'SUBSCRIPTION_BLOCKING_IMPACT',
  /** Evento non-proiezione spostato fuori da Prenotazioni (V3, V5). */
  'NON_PROJECTION_MOVED',
  /** RRULE non valida migrata come evento singolo (V3, V4). */
  'INVALID_RRULE_SINGLE',
  /** Master cancellato non migrato (V3, V5). */
  'CANCELLED_MASTER_SKIPPED',
  /** BYDAY misto: unione RFC 5545 invece dell'intersezione del legacy (V3, V4). */
  'MIXED_BYDAY',
  /** All-day ambiguo normalizzato con la regola +12 h (V3). */
  'ALLDAY_NORMALIZED',
  /** Festività duplicata non migrata (V3, V5). */
  'DUPLICATE_HOLIDAY_SKIPPED',
  /**
   * DTSTART fuori dalla regola riallineato alla prima occorrenza legacy (V5:
   * il feed legacy, espanso secondo RFC 5545, ha l'istanza del vecchio DTSTART
   * e, con COUNT, una in meno alla fine).
   */
  'DTSTART_REALIGNED',
  /**
   * F4: riga legacy scritta dalla proiezione inversa con un degrado che cambia
   * le occorrenze (durata zero portata a una durata positiva, TRANSP o STATUS
   * resi come tentative) e risorsa di Radicale invariata dalla ri-baseline del
   * rollback (V3, V5; contratto f4-modules §5.3).
   */
  'REVERSE_DEGRADED',
] as const;
export type ExpectedDiffReason = (typeof EXPECTED_DIFF_REASONS)[number];

/** green: nessuna differenza; yellow: solo differenze attese; red: almeno una inattesa. */
export const VERIFY_COLORS = ['green', 'yellow', 'red'] as const;
export type VerifyColor = (typeof VERIFY_COLORS)[number];

/** Colore di un insieme di differenze (design §13.7). */
export function verifyColorOf(diffs: ReadonlyArray<{ expected: boolean }>): VerifyColor {
  if (diffs.length === 0) return 'green';
  return diffs.some((d) => !d.expected) ? 'red' : 'yellow';
}

/** Colore peggiore fra più colori. */
export function worstColor(colors: Iterable<VerifyColor>): VerifyColor {
  let out: VerifyColor = 'green';
  for (const c of colors) {
    if (c === 'red') return 'red';
    if (c === 'yellow') out = 'yellow';
  }
  return out;
}

/** Un calendario è accettabile per il cutover se verde, o giallo con tutte le differenze accettate. */
export function verdictAcceptable(verdict: Pick<CalendarVerdict, 'color' | 'accepted'>): boolean {
  return verdict.color === 'green' || (verdict.color === 'yellow' && verdict.accepted);
}

export interface VerifyDiffDetail {
  /** Motivo della differenza attesa (null = inattesa). */
  reason: ExpectedDiffReason | null;
  /**
   * sha256 di (livello, codice, calendario, chiave legacy, motivo, valori
   * legacy e destinazione canonici): l'accettazione di una differenza
   * identica si riporta sui run di verifica successivi (contratto §8.4).
   */
  signature: string;
  uid?: string | null;
  /** UID pubblicato nel feed (V5). */
  published_uid?: string | null;
  recurrence_key?: string | null;
  window?: { from: string; to: string } | null;
  /**
   * Solo V4: variante del confronto. Le differenze 'with_subscriptions' sono
   * informative (expected = true, severity 'info'): non entrano nel colore
   * dei calendari né nell'accettazione (contratto §8.2).
   */
  variant?: 'without_subscriptions' | 'with_subscriptions';
  /** Valori legacy e destinazione, senza dati personali (istanti, etag, fingerprint, conteggi). */
  legacy?: unknown;
  target?: unknown;
  message?: string | null;
}

/** Una differenza della verifica (una riga 'diff' del run). */
export interface VerifyDiff {
  level: VerifyLevel;
  code: VerifyDiffCode;
  expected: boolean;
  calendar_id: string | null;
  collection_name: string | null;
  href: string | null;
  legacy_key: LegacyKey | null;
  detail: VerifyDiffDetail;
}

// ─── Conferme digitate e dichiarazioni ─────────────────────

/** Frasi da digitare per le azioni che scrivono (confronto esatto, maiuscole comprese). */
export const MIGRATION_CONFIRMATIONS = Object.freeze({
  initialize: 'INIZIALIZZA RADICALE',
  createCollections: 'CREA COLLEZIONI',
  archive: 'IMPORTA ARCHIVIO',
  identityReassign: 'RIASSEGNA IDENTITÀ',
  apply: 'APPLICA',
  force: 'FORZA',
  accept: 'ACCETTA',
  shadowOn: 'ATTIVA SHADOW',
  declare: 'CONFERMO',
  /** F4: mostrate nel wizard, rifiutate dalle route in F3. */
  cutover: 'PASSA A RADICALE',
  rollback: 'TORNA A POSTGRES',
  /** F4: chiusura della finestra di rollback (finalize, design §13.13). */
  finalize: 'CHIUDI LA FINESTRA',
  /** F4: annullamento di un cutover non ancora oltre il passo d'epoch (ritorno a postgres). */
  cutoverAbort: 'ANNULLA IL PASSAGGIO',
  /** F4: rollback anche con l'anteprima cambiata o con la sync finale non riuscita (design §13.12, parità informativa). */
  rollbackEmergency: 'ROLLBACK DI EMERGENZA',
} as const);

/**
 * Dichiarazioni esplicite del wizard (calendar_backend_state.migration_declarations):
 * - phase0: volume radicale_data della Fase 0 (decisione 7);
 * - remote_mode_accepted: remote mode del campanello accettata (VOLUME_WATCH);
 * - public_401_verified: 401 di caldes-svc/caldes-probe sull'URL pubblico verificato dall'host (SERVICE_PUBLIC_401);
 * - backup_verified: backup coordinato verificato a mano (BACKUP_RECENT), valido 24 ore;
 * - device_matrix: esito della matrice device (decisioni su strict_preconditions e TRANSP degli all-day).
 */
export const DECLARATION_KEYS = ['phase0', 'remote_mode_accepted', 'public_401_verified', 'backup_verified', 'device_matrix'] as const;
export type DeclarationKey = (typeof DECLARATION_KEYS)[number];

/** Dichiarazioni che tolgono un controllo di sicurezza: richiedono MIGRATION_CONFIRMATIONS.declare. */
export const WAIVER_DECLARATIONS: ReadonlySet<DeclarationKey> = new Set<DeclarationKey>([
  'remote_mode_accepted', 'public_401_verified', 'backup_verified',
]);

export type Phase0Status = 'absent' | 'archived' | 'present_not_imported';

export interface DeclarationValues {
  phase0: { status: Phase0Status; note?: string | null; archive_run_id?: string | null };
  remote_mode_accepted: { reason: string };
  public_401_verified: { method: 'curl' | 'browser' | 'other'; note?: string | null };
  backup_verified: { note?: string | null };
  device_matrix: {
    result: 'passed' | 'failed';
    /** Decisione documentata per [storage] strict_preconditions di Radicale (rischi.md). */
    strict_preconditions: boolean;
    /** Regola TRANSP degli all-day creati dai device (decisione 6). */
    allday_transp_rule: 'opaque_blocks' | 'never_block';
    devices: Array<'ios' | 'macos' | 'davx5' | 'thunderbird'>;
    notes?: string | null;
  };
}

export interface Declaration<K extends DeclarationKey = DeclarationKey> {
  value: DeclarationValues[K];
  at: string;
  by: string;
}

export type MigrationDeclarations = { [K in DeclarationKey]?: Declaration<K> };

/** Ultimo backup coordinato registrato da scripts/backup-calendar-stack.sh (calendar_backend_state.last_stack_backup). */
export interface LastStackBackup {
  id: string;
  at: string;
  complete: boolean;
  volume_id: string | null;
  epoch: number | null;
  manifest_sha256: string | null;
}

// ─── Stato del backend con le colonne della 165 ────────────

export interface MigrationBackendState extends CalendarBackendState {
  shadow_enabled: boolean;
  shadow_since: Date | null;
  cutover_at: Date | null;
  cutover_by: string | null;
  rollback_until: Date | null;
  finalized_at: Date | null;
  api_min_version: number;
  last_stack_backup: LastStackBackup | null;
  migration_declarations: MigrationDeclarations;
}

/** Colonne da leggere per normalizeMigrationState() (SELECT esplicito, mai *). */
export const MIGRATION_STATE_COLUMNS = Object.freeze([
  'mode', 'write_freeze', 'volume_id', 'epoch', 'credential_epoch', 'policy_version',
  'restore_guard_until', 'rebuild_required',
  'shadow_enabled', 'shadow_since', 'cutover_at', 'cutover_by', 'rollback_until', 'finalized_at',
  'api_min_version', 'last_stack_backup', 'migration_declarations',
] as const);

/**
 * Riga di calendar_backend_state (colonne di MIGRATION_STATE_COLUMNS) →
 * stato validato. Lancia ControlPlaneFormatError (da normalizeBackendState)
 * per le colonne della 162 e MigrationError('INTERNAL') per quelle della 165
 * fuori contratto.
 */
export function normalizeMigrationState(row: Record<string, unknown>): MigrationBackendState {
  const base = normalizeBackendState(row);
  const date = (v: unknown, name: string): Date | null => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    if (!Number.isFinite(d.getTime())) throw new MigrationError('INTERNAL', `calendar_backend_state.${name} non è una data`);
    return d;
  };
  const shadow = row.shadow_enabled;
  if (typeof shadow !== 'boolean') throw new MigrationError('INTERNAL', 'calendar_backend_state.shadow_enabled non booleano');
  const apiMin = typeof row.api_min_version === 'number' ? row.api_min_version : Number(row.api_min_version);
  if (!Number.isInteger(apiMin) || apiMin < 0) throw new MigrationError('INTERNAL', 'calendar_backend_state.api_min_version non valido');
  const declarations = row.migration_declarations;
  if (declarations === null || typeof declarations !== 'object' || Array.isArray(declarations)) {
    throw new MigrationError('INTERNAL', 'calendar_backend_state.migration_declarations non è un oggetto');
  }
  const backup = row.last_stack_backup;
  if (backup !== null && backup !== undefined && (typeof backup !== 'object' || Array.isArray(backup))) {
    throw new MigrationError('INTERNAL', 'calendar_backend_state.last_stack_backup non è un oggetto');
  }
  return {
    ...base,
    shadow_enabled: shadow,
    shadow_since: date(row.shadow_since, 'shadow_since'),
    cutover_at: date(row.cutover_at, 'cutover_at'),
    cutover_by: row.cutover_by === null || row.cutover_by === undefined ? null : String(row.cutover_by),
    rollback_until: date(row.rollback_until, 'rollback_until'),
    finalized_at: date(row.finalized_at, 'finalized_at'),
    api_min_version: apiMin,
    last_stack_backup: (backup ?? null) as LastStackBackup | null,
    migration_declarations: declarations as MigrationDeclarations,
  };
}

/** Stato in cui la F3 ammette scritture dello strumento (apply, shadow, init, archivio, identità). */
export function migrationWritesAllowed(state: Pick<CalendarBackendState, 'mode'>): boolean {
  return state.mode === 'postgres';
}

// ─── Esecuzione dei run ─────────────────────────────────────

/**
 * Contesto che l'esecutore (runs.ts, ROUTES) passa alla funzione del modulo
 * che esegue un run. L'esecutore tiene già il lock cal-migration, ha portato
 * il run a 'running' e gestisce battito, lease, annullamento ed esito.
 */
export interface MigrationRunContext<P = Record<string, unknown>> {
  readonly runId: string;
  readonly kind: MigrationRunKind;
  readonly trigger: MigrationRunTrigger;
  /** cal_migration_runs.requested_by (admin:<id>, system:shadow...): attore di audit e ledger. */
  readonly actor: string;
  readonly params: P;
  readonly planRunId: string | null;
  readonly planHash: string | null;
  /** 1 alla prima esecuzione, > 1 alla ripresa dopo un riavvio (le funzioni devono essere idempotenti). */
  readonly attempt: number;
  /** Annullamento richiesto dall'admin o arresto dell'API. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Pool principale (nessuna transazione lunga attorno all'I/O verso Radicale). */
  readonly db: Db;
  /** Avanzamento (scritto al più ogni MIGRATION_LIMITS.progressWriteIntervalMs, aggiorna il battito). */
  progress(update: MigrationProgress): Promise<void>;
  /** Righe del run, in ordine; restituisce gli id (int8 come stringa). */
  addItems(items: readonly MigrationItemInput[]): Promise<string[]>;
  /** Lancia MigrationError('CANCELLED') se il run è stato annullato. */
  throwIfCancelled(): void;
}

export type MigrationRunHandler<P = Record<string, unknown>, S extends object = object> =
  (ctx: MigrationRunContext<P>) => Promise<S>;

// ─── Serializer e piano (condivisi da SERIALIZE, APPLY, SHADOW) ─────

/** Un calendario visto dallo strumento (sidecar più colonne legacy), con l'esclusione dal piano. */
export interface MigrationCalendar {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  timezone: string;
  sort_order: number;
  is_default: boolean;
  is_system: boolean;
  blocks_availability: boolean;
  ics_feed_enabled: boolean;
  collection_name: string | null;
  role: CalendarRole;
  origin: CalendarOrigin;
  lifecycle: CalendarLifecycle;
  device_visible: boolean;
  /** Nel piano: attivo, nome di collezione valido, né sidecar d'iscrizione né archivio. */
  included: boolean;
  excluded_reason: CalendarExclusion | null;
}

/** Collezione che l'inizializzazione crea o verifica (init.ts è l'unico punto di MKCOL e MKCALENDAR). */
export interface PlannedCollection {
  calendar_id: string | null;
  collection_name: string;
  /** calendar: calendario del piano; subscription: sub-* di un'iscrizione visibile; archive: archivio della Fase 0; system: _canary. */
  kind: 'calendar' | 'subscription' | 'archive' | 'system';
  role: CalendarRole | null;
}

/**
 * apply: tabella del design §13.6 (conflitti su qualsiasi cambiamento della
 * destinazione); shadow: patch per campo sull'oggetto corrente con CAS dei
 * soli campi toccati (design §13.8, contratto §9.3).
 */
export type PlanMode = 'apply' | 'shadow';

/** Id da preassegnare in cal_object_ids prima della scrittura (ids.reserveObjectId). */
export interface ReservedObjectId {
  /** '' per la risorsa, altrimenti la recurrence key dell'override. */
  recurrence_key: string;
  /** Id legacy del master o dell'override (stabile per list_events e MCP). */
  id: string;
  legacy_event_id: string | null;
}

/** Un oggetto prodotto dal serializer (design §13.5). */
export interface SerializedObject {
  legacy_key: LegacyKey;
  kind: LedgerKind;
  calendar_id: string;
  collection_name: string;
  /** href voluto: quello già noto (ledger vivo o cal_object_ids), altrimenti deterministico. */
  href: string;
  uid: string;
  /** Testo canonico (serializeObject di calendar-core). */
  ics: string;
  /** semanticFingerprint del testo. */
  fingerprint: string;
  legacy_snapshot: LegacySnapshot;
  legacy_hash: string;
  legacy_event_id: string | null;
  /** cal_object_ids.legacy_uid (UID del feed legacy, anche con '@'). */
  legacy_uid: string | null;
  object_ids: ReservedObjectId[];
  anomalies: AnomalyCode[];
  expected_reasons: ExpectedDiffReason[];
  /** Titolo per l'anteprima; null per le proiezioni (dati personali). */
  summary: string | null;
}

/** Sorgente non migrata (azione skip). */
export interface SkippedSource {
  legacy_key: LegacyKey;
  kind: LedgerKind;
  calendar_id: string;
  collection_name: string | null;
  code: SkipCode;
  legacy_event_id: string | null;
  summary: string | null;
}

export interface SerializationResult {
  serializer_version: number;
  objects: SerializedObject[];
  skipped: SkippedSource[];
  anomalies: AnomalyRecord[];
}

/** Stato della destinazione per un href (PROPFIND getetag più multiget dove serve). */
export interface TargetObject {
  calendar_id: string;
  collection_name: string;
  href: string;
  etag: string | null;
  uid: string | null;
  fingerprint: string | null;
  /** Testo, se letto (adozione, patch, V2). */
  raw: string | null;
}

/** Un oggetto del piano (design §13.6): una riga 'object' del run d'anteprima. */
export interface PlanItem {
  legacy_key: LegacyKey;
  kind: LedgerKind;
  calendar_id: string;
  collection_name: string;
  href: string;
  action: PlanAction;
  code: ConflictCode | SkipCode | null;
  /** Oggetto voluto (null per delete e per i salti senza uscita). */
  source: SerializedObject | null;
  ledger: LedgerRow | null;
  target: TargetObject | null;
  /** Update come patch per campo sull'oggetto corrente (righe adopted o derived, design §13.8). */
  patch: boolean;
  /** UID trovato a un altro href (adopt o UID_AT_OTHER_HREF). */
  other_href: string | null;
  /** Campi cambiati (update e patch), per il dettaglio. */
  fields: string[];
}

/** Dettaglio di una riga 'object' (cal_migration_items.detail) del piano e dell'apply. */
export interface ObjectItemDetail {
  kind: LedgerKind;
  uid: string | null;
  summary: string | null;
  legacy_event_id: string | null;
  legacy_hash: string | null;
  previous_legacy_hash: string | null;
  planned_fingerprint: string | null;
  target_etag: string | null;
  target_fingerprint: string | null;
  written_etag: string | null;
  patch: boolean;
  other_href: string | null;
  fields: string[];
  anomalies: AnomalyCode[];
  /** Solo apply. */
  etag_after?: string | null;
  http_status?: number | null;
  error?: string | null;
}

// ─── Riassunti dei run ──────────────────────────────────────

export interface PreflightSummary {
  checks: PreflightCheck[];
  /** Codici dei controlli che bloccano (fail o confirm). */
  blocking: PreflightCheckCode[];
  ready: boolean;
  identity: IdentityStatus;
  /** Volume vuoto e stato non inizializzato: il passo 1 propone "Inizializza Radicale". */
  can_initialize: boolean;
  /** Collezioni del piano (e sub-* delle iscrizioni visibili) che mancano su Radicale. */
  missing_collections: string[];
  radicale: { configured: boolean; reachable: boolean | null; version: string | null };
  watch_mode: 'mount' | 'remote' | 'off';
}

export interface InitSummary {
  action: 'initialize' | 'create_missing';
  volume_id: string;
  epoch: number;
  collections: CollectionProvisioning[];
  canary: CanaryProvisioning;
}

export interface ArchiveSummary {
  calendar_id: string;
  collection_name: string;
  created_collection: boolean;
  total: number;
  imported: number;
  /** Già presenti con lo stesso contenuto (412 su If-None-Match: seconda esecuzione). */
  unchanged: number;
  invalid: number;
  duplicates: number;
}

export type IdentityReassignDirection = 'volume_to_pg' | 'pg_to_volume';

export interface IdentityReassignSummary {
  direction: IdentityReassignDirection;
  before: { pg_volume_id: string | null; pg_epoch: number; marker_volume_id: string | null; marker_epoch: number | null };
  after: { volume_id: string; epoch: number };
  /** Righe del ledger marcate da rivalidare. */
  ledger_revalidation: number;
}

export interface InventoryCounts {
  rows: number;
  singles_timed: number;
  singles_all_day: number;
  series: number;
  overrides_modified: number;
  /** Override cancellati: diventano EXDATE. */
  overrides_cancelled: number;
  exdates: number;
  projections: number;
  holidays_system: number;
  closures: number;
  non_projection_in_bookings: number;
}

export type CalendarExclusion = 'subscription_sidecar' | 'archive' | 'collection_name_invalid' | 'not_active';

export interface CalendarInventory {
  calendar_id: string;
  slug: string;
  name: string;
  collection_name: string | null;
  role: CalendarRole;
  origin: string;
  is_system: boolean;
  blocks_availability: boolean;
  included: boolean;
  excluded_reason: CalendarExclusion | null;
  counts: InventoryCounts;
  anomalies: Partial<Record<AnomalyCode, number>>;
}

export interface SubscriptionImpact {
  subscription_id: string;
  name: string;
  target_calendar_id: string;
  enabled: boolean;
  blocks_availability: boolean;
  device_visible: boolean;
  sidecar_calendar_id: string | null;
  collection_name: string | null;
  collection_exists: boolean | null;
  events_legacy: number;
  events_index: number | null;
  last_index_pull_at: string | null;
  /** Impatto di "blocca disponibilità" sulle prossime 4 settimane (SUBSCRIPTION_BLOCKING_IMPACT). */
  impact: {
    weeks: number;
    busy_hours_per_week: number;
    /** Slot pubblici persi a settimana, per tipo di prenotazione attivo (slug). */
    slots_lost_per_week: Record<string, number>;
  } | null;
}

export interface InventorySummary {
  generated_at: string;
  calendars: CalendarInventory[];
  totals: InventoryCounts;
  anomalies: Partial<Record<AnomalyCode, number>>;
  subscriptions: SubscriptionImpact[];
  app_passwords: { active: number; non_canonical: number; reserved: number };
  /** Stima della durata dell'apply (design §13.4). */
  estimate: { objects: number; writes_upper_bound: number; seconds: number };
}

export interface PlanCalendarCounts {
  calendar_id: string;
  collection_name: string;
  counts: Record<PlanAction, number>;
}

export interface PlanSummary {
  generated_at: string;
  plan_hash: string;
  serializer_version: number;
  options: MigrationOptions;
  scope: MigrationScope;
  totals: Record<PlanAction, number>;
  writes: number;
  conflicts: Partial<Record<ConflictCode, number>>;
  skips: Partial<Record<SkipCode, number>>;
  calendars: PlanCalendarCounts[];
  anomalies: Partial<Record<AnomalyCode, number>>;
  revalidation_pending: number;
  estimate_seconds: number;
  /**
   * Anteprima leggibile per il wizard (design §13.4), costruita da
   * plan.buildPlanPreview e salvata nel riassunto del run 'plan'; assente nei
   * piani calcolati per lo shadow o per l'apply.
   */
  preview?: PlanPreview;
}

export interface ApplySummary {
  plan_hash: string;
  expected_plan_hash: string | null;
  totals: Record<ApplyOutcome, number>;
  writes: { create: number; update: number; delete: number };
  conflicts: Partial<Record<ConflictCode, number>>;
  failed: number;
  adopted: number;
  forced: number;
  duration_ms: number;
  /** Nessuna scrittura necessaria: criterio "seconda esecuzione al 100% noop" (design §13.6). */
  zero_writes: boolean;
}

export interface VerifyLevelVerdict {
  color: VerifyColor;
  diffs: number;
  expected: number;
  unexpected: number;
}

export interface CalendarVerdict {
  calendar_id: string;
  collection_name: string;
  slug: string;
  color: VerifyColor;
  /** Tutte le differenze attese accettate (sempre true per un verde). */
  accepted: boolean;
  levels: Partial<Record<VerifyLevel, VerifyLevelVerdict>>;
}

export interface VerifySummary {
  generated_at: string;
  levels: VerifyLevel[];
  overall: VerifyColor;
  /** Verde, o giallo con tutto accettato, per ogni calendario. */
  acceptable: boolean;
  calendars: CalendarVerdict[];
  /** V4 è globale: senza iscrizioni deve essere verde, con le iscrizioni è informativa. */
  v4: { from: string; to: string; without_subscriptions: VerifyColor; with_subscriptions: VerifyColor } | null;
  totals: { diffs: number; expected: number; unexpected: number; accepted: number };
}

export interface MigrationRunSummaryByKind {
  preflight: PreflightSummary;
  init: InitSummary;
  archive: ArchiveSummary;
  identity: IdentityReassignSummary;
  inventory: InventorySummary;
  plan: PlanSummary;
  apply: ApplySummary;
  verify: VerifySummary;
  // F4 (contratto f4-modules §2-§7).
  cutover: CutoverSummary;
  rollback_preview: RollbackPreviewSummary;
  rollback: RollbackSummary;
  rebaseline: RebaselineSummary;
  finalize: FinalizeSummary;
}

export type MigrationRunSummary = MigrationRunSummaryByKind[keyof MigrationRunSummaryByKind];

// ─── Parametri dei run (cal_migration_runs.params) ─────────

export interface MigrationScope {
  /** Calendari (id) da considerare; assente o vuoto = tutti quelli inclusi. */
  calendar_ids?: string[];
}

export interface PreflightParams { probe_public_url: boolean }
export interface InitParams {
  action: 'initialize' | 'create_missing';
  /**
   * Journal dell'inizializzazione (crash-resistente): UUID del volume scelto
   * e salvato PRIMA della MKCOL, così una ripresa riconosce il proprio marker
   * invece di trattarlo come un volume estraneo.
   */
  volume_id?: string;
}
export interface ArchiveParams {
  /** File caricato (0600, cartella privata), cancellato a fine run. */
  upload_path: string;
  upload_sha256: string;
  original_name: string;
}
export interface IdentityParams {
  direction: IdentityReassignDirection;
  expected: { pg_volume_id: string | null; pg_epoch: number; marker_volume_id: string | null; marker_epoch: number | null };
}
export interface InventoryParams { scope: MigrationScope }
export interface PlanParams { scope: MigrationScope; options: MigrationOptions }
export interface ApplyParams {
  scope: MigrationScope;
  options: MigrationOptions;
  expected_plan_hash: string | null;
  /** Righe 'object' del run d'anteprima da forzare (id). */
  force_item_ids: string[];
  /** Conflitti da forzare in blocco (es. REVALIDATION_REQUIRED dopo un ripristino). */
  force_codes: ConflictCode[];
  /**
   * Verifica da accodare a fine apply riuscito (giro notturno dello shadow:
   * apply completo più V1-V5): l'esecutore crea il run nella stessa
   * transazione che chiude l'apply.
   */
  follow_up_verify: VerifyParams | null;
}
export interface VerifyParams {
  scope: MigrationScope;
  levels: VerifyLevel[];
  /** Giorni di V4 (180, o 14 per il giro orario dello shadow). */
  v4_days: number;
}

// ─── API REST: richieste ────────────────────────────────────

export interface PreflightRequest { probe_public_url?: boolean }
export interface InitRequest { action: 'initialize' | 'create_missing'; confirm: string }
export interface IdentityReassignRequest { direction: IdentityReassignDirection; confirm: string; expected: IdentityParams['expected'] }
export interface InventoryRequest { scope?: MigrationScope }
export interface PlanRequest { scope?: MigrationScope; options?: Partial<MigrationOptions> }
export interface ApplyRequest {
  plan_run_id: string;
  /** Hash del piano visto nell'anteprima: l'apply lo ricalcola e si ferma (PLAN_CHANGED) se diverso. */
  expect_plan_hash?: string | null;
  force_item_ids?: string[];
  force_codes?: ConflictCode[];
  confirm: string;
  /** Obbligatoria se force_item_ids o force_codes non sono vuoti. */
  confirm_force?: string;
}
export interface VerifyRequest { scope?: MigrationScope; levels?: VerifyLevel[]; v4_days?: number }
export interface AcceptDiffsRequest { item_ids?: string[]; calendar_id?: string; all_expected?: boolean; confirm: string }
export interface ShadowRequest { enabled: boolean; confirm?: string }
export interface DeclarationRequest<K extends DeclarationKey = DeclarationKey> { key: K; value: DeclarationValues[K]; confirm?: string }
export interface SubscriptionFlagsRequest { blocks_availability?: boolean; device_visible?: boolean }

// ─── API REST: risposte ─────────────────────────────────────

export interface MigrationRunView<K extends MigrationRunKind = MigrationRunKind> {
  id: string;
  kind: K;
  status: MigrationRunStatus;
  trigger: MigrationRunTrigger;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  progress: MigrationProgress | Record<string, never>;
  summary: (K extends keyof MigrationRunSummaryByKind ? MigrationRunSummaryByKind[K] : Record<string, unknown>) | null;
  error: { code: MigrationRunErrorCode | string; message: string } | null;
  plan_run_id: string | null;
  plan_hash: string | null;
  attempts: number;
  cancel_requested: boolean;
}

/** Risposta di ogni POST che crea un run: 202 (nuovo) o 200 con replayed=true (stessa chiave d'idempotenza). */
export interface RunCreatedResponse { run: MigrationRunView; replayed: boolean }

export interface MigrationItemView {
  id: string;
  seq: number;
  item_type: MigrationItemType;
  calendar_id: string | null;
  collection_name: string | null;
  href: string | null;
  legacy_key: string | null;
  action: PlanAction | null;
  outcome: ApplyOutcome | null;
  code: string | null;
  level: VerifyLevel | null;
  severity: ItemSeverity;
  expected: boolean | null;
  detail: Record<string, unknown>;
  forced: boolean;
  accepted_at: string | null;
  accepted_by: string | null;
}

export interface RunItemsResponse { items: MigrationItemView[]; next_cursor: string | null; total: number }

export interface RunsListResponse { runs: MigrationRunView[]; next_cursor: string | null }

export interface AcceptDiffsResponse { accepted: number; calendars: CalendarVerdict[]; acceptable: boolean }

export interface IdentityDiffView {
  status: IdentityStatus;
  pg: { mode: BackendMode; volume_id: string | null; epoch: number };
  volume: {
    principal_exists: boolean | null;
    marker: { volume_id: string; epoch: number } | null;
    /** Collezioni presenti sotto il principal con le dead prop e il numero di item. */
    collections: Array<{ name: string; calendar_id_prop: string | null; role_prop: string | null; items: number | null }>;
    read_error: string | null;
  };
  ledger: { live: number; with_target_etag: number };
  allowed: IdentityReassignDirection[];
  /** Spiegazione per il wizard (design §13.3: volume di un altro stack, della Fase 0 o ripristinato). */
  explanation: string;
}

export interface ShadowStateResponse {
  shadow_enabled: boolean;
  shadow_since: string | null;
  /** Apply completo accodato all'attivazione per recuperare le scritture precedenti. */
  catch_up_run: MigrationRunView | null;
}

export interface ParityView {
  shadow_enabled: boolean;
  shadow_since: string | null;
  /** Inizio della serie verde corrente (dopo l'ultimo giro non verde), null se l'ultimo giro non è verde. */
  green_since: string | null;
  days_green: number;
  required_days: number;
  satisfied: boolean;
  /**
   * Ultimo giro notturno. `green` è la regola della parità (verifica accettabile:
   * verde, o gialla con le differenze accettate); null finché la verifica del
   * giro non è conclusa.
   */
  last_nightly: { apply_run_id: string | null; verify_run_id: string | null; color: VerifyColor | null; green: boolean | null; finished_at: string | null } | null;
  last_hourly: { run_id: string; color: VerifyColor; finished_at: string } | null;
  recent: Array<{ run_id: string; kind: 'apply' | 'verify'; trigger: MigrationRunTrigger; finished_at: string; color: VerifyColor | null; writes: number | null; conflicts: number | null }>;
  queue: { pending: number; running: number; dead: number; oldest_pending_at: string | null };
  open_conflicts: number;
}

export interface SubscriptionMigrationView extends SubscriptionImpact {
  /** Righe legacy dell'iscrizione per il conteggio dell'anteprima. */
  url_host: string | null;
}

export interface SubscriptionFlagsResponse {
  subscription: SubscriptionMigrationView;
  /** device_visible senza la collezione sub-*: serve "Crea collezioni mancanti" (POST /init). */
  collection_missing: boolean;
}

// ─── Wizard a 6 passi (design §13.13) ──────────────────────

export const WIZARD_STEP_IDS = ['prerequisiti', 'anteprima', 'applica', 'verifica', 'shadow', 'passaggio'] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export const WIZARD_STEP_TITLES: Readonly<Record<WizardStepId, string>> = Object.freeze({
  prerequisiti: 'Prerequisiti e inizializzazione',
  anteprima: 'Anteprima e opzioni',
  applica: 'Applica',
  verifica: 'Verifica',
  shadow: 'Shadow e prova sui device',
  passaggio: 'Passaggio',
});

/**
 * locked: passo precedente non concluso; todo: da fare; running: run in
 * corso; done: concluso; attention: concluso con qualcosa da guardare
 * (conflitti, differenze gialle da accettare, anteprima vecchia);
 * blocked: c'è un blocco (controllo fallito, verifica rossa); disabled: non
 * disponibile in questa fase (passaggio in F3).
 */
export const WIZARD_STEP_STATUSES = ['locked', 'todo', 'running', 'done', 'attention', 'blocked', 'disabled'] as const;
export type WizardStepStatus = (typeof WIZARD_STEP_STATUSES)[number];

export const WIZARD_ACTION_IDS = [
  'preflight', 'initialize', 'create_collections', 'archive', 'declare', 'identity_reassign',
  'inventory', 'plan', 'apply', 'verify', 'accept', 'shadow_on', 'shadow_off', 'cutover',
  // F4 (contratto f4-modules §10.3).
  'cutover_abort', 'transition_resume', 'rollback_preview', 'rollback', 'finalize', 'rebaseline', 'export_v2',
] as const;
export type WizardActionId = (typeof WIZARD_ACTION_IDS)[number];

export interface WizardAction {
  id: WizardActionId;
  enabled: boolean;
  /** Perché è disabilitata (in italiano). */
  reason: string | null;
  /** Frase da digitare, se l'azione scrive. */
  confirm: string | null;
}

export interface WizardStepView {
  id: WizardStepId;
  index: number;
  title: string;
  status: WizardStepStatus;
  summary: string;
  blocking: string[];
  last_run_id: string | null;
  actions: WizardAction[];
}

export interface CutoverCriterion {
  /**
   * F3: verify_acceptable, shadow_parity, device_matrix, backup_recent,
   * no_open_conflicts. F4 (contratto f4-modules §3.2): backup_fresh (meno di
   * 2 ore), identity_ok, control_plane, probe, no_revalidation,
   * archive_readonly, no_active_transition.
   */
  id:
    | 'verify_acceptable' | 'shadow_parity' | 'device_matrix' | 'backup_recent' | 'no_open_conflicts'
    | 'backup_fresh' | 'identity_ok' | 'control_plane' | 'probe' | 'no_revalidation' | 'archive_readonly'
    | 'no_active_transition';
  label: string;
  ok: boolean;
  detail: string | null;
}

export interface CutoverAvailability {
  /** In F3 sempre false; dalla F4 true quando tutti i criteri sono soddisfatti e il mode è postgres. */
  available: boolean;
  phase: 'F4';
  reason: string;
  criteria: CutoverCriterion[];
}

export interface MigrationStateView {
  contract_version: typeof MIGRATION_CONTRACT_VERSION;
  phase: typeof MIGRATION_PHASE;
  backend: {
    mode: BackendMode;
    shadow_enabled: boolean;
    shadow_since: string | null;
    volume_id: string | null;
    epoch: number;
    policy_version: number;
    restore_guard_until: string | null;
    rebuild_required: boolean;
    api_min_version: number;
    cutover_at: string | null;
    rollback_until: string | null;
    finalized_at: string | null;
  };
  identity: { status: IdentityStatus; checked_at: string | null; detail: string | null };
  radicale: { configured: boolean; watch_mode: 'mount' | 'remote' | 'off'; canary: { ok: boolean; reason: string | null } | null };
  declarations: MigrationDeclarations;
  last_stack_backup: LastStackBackup | null;
  active_run: MigrationRunView | null;
  last_runs: Partial<Record<MigrationRunKind, MigrationRunView>>;
  ledger: { live: number; pending_intents: number; revalidation_pending: number };
  shadow_queue: { pending: number; running: number; dead: number };
  wizard: { current_step: WizardStepId; steps: WizardStepView[] };
  cutover: CutoverAvailability;
  /** F4: transizione attiva o ultima conclusa (contratto f4-modules §10.2). Facoltativo finché il gruppo UI non lo valorizza. */
  transition?: TransitionView | null;
  /** F4: finestra di rollback dopo il cutover (null in mode postgres). */
  rollback_window?: RollbackWindowView | null;
  /** F4: salute della proiezione inversa (null fuori da mode radicale). */
  reverse_projection?: ReverseProjectionHealthView | null;
}

// ─── Errori dell'API ────────────────────────────────────────

/** Codici di errore delle route con lo stato HTTP (corpo `{ error, code, details? }`). */
export const MIGRATION_ERROR_STATUS = Object.freeze({
  VALIDATION_FAILED: 400,
  CONFIRMATION_REQUIRED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  RUN_NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  MIGRATION_BUSY: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PRECONDITION_FAILED: 409,
  RUN_NOT_ACTIVE: 409,
  NOT_ACCEPTABLE: 409,
  PHASE_NOT_AVAILABLE: 409,
  PLAN_CHANGED: 409,
  CANCELLED: 409,
  /** F4: un'altra transizione è attiva (details.transition: TransitionView). */
  TRANSITION_IN_PROGRESS: 409,
  RADICALE_NOT_CONFIGURED: 503,
  CALENDAR_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const);
export type MigrationErrorCode = keyof typeof MIGRATION_ERROR_STATUS;

/** Corpo d'errore delle route di migrazione. */
export interface MigrationErrorBody {
  error: string;
  code: MigrationErrorCode;
  details?: Record<string, unknown>;
}

/**
 * Errore dello strumento: le route lo traducono in `{ error, code, details }`
 * con lo stato di MIGRATION_ERROR_STATUS; l'esecutore dei run ne usa il codice
 * come error_code quando è anche un MigrationRunErrorCode.
 */
export class MigrationError extends Error {
  readonly status: number;
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MigrationError';
    this.status = MIGRATION_ERROR_STATUS[code];
  }

  toBody(): MigrationErrorBody {
    return this.details ? { error: this.message, code: this.code, details: this.details } : { error: this.message, code: this.code };
  }
}

export function isMigrationError(err: unknown): err is MigrationError {
  return err instanceof MigrationError;
}

/**
 * Motivi di PRECONDITION_FAILED (details.reasons), condivisi da route e
 * moduli perché il wizard li traduca e li mostri accanto all'azione.
 */
export const PRECONDITION_REASONS = [
  'MODE_NOT_POSTGRES',
  'IDENTITY_NOT_OK',
  'IDENTITY_NOT_UNINITIALIZED',
  'PRINCIPAL_EXISTS',
  'PREFLIGHT_REQUIRED',
  'PREFLIGHT_BLOCKING',
  'COLLECTIONS_MISSING',
  'PLAN_REQUIRED',
  'PLAN_STALE',
  'APPLY_REQUIRED',
  'APPLY_CONFLICTS',
  'VERIFY_REQUIRED',
  'VERIFY_RED',
  'REVALIDATION_PENDING',
  'SHADOW_ALREADY',
  /** Scrittura che richiede lo shadow acceso (assertMigrationWritable con requireShadow). */
  'SHADOW_DISABLED',
  'IDENTITY_DIFF_CHANGED',
  'RUN_KIND_NOT_VERIFY',
  // F4 (contratto f4-modules §9.2).
  /** Rollback e finalize richiedono mode radicale. */
  'MODE_NOT_RADICALE',
  /** Un'altra transizione è attiva (anche ferma, da riprendere). */
  'TRANSITION_ACTIVE',
  /** Ripresa o annullamento richiesti senza una transizione attiva di quel tipo. */
  'NO_ACTIVE_TRANSITION',
  /** Annullamento del cutover dopo il passo d'epoch: resta solo il rollback. */
  'TRANSITION_NOT_ABORTABLE',
  /** Finestra di rollback scaduta (rollback_until passato). */
  'ROLLBACK_WINDOW_EXPIRED',
  /** Finalize prima dei 14 giorni dal cutover. */
  'FINALIZE_TOO_EARLY',
  /** Parità dello shadow non soddisfatta (7 giorni, o verifica dopo il rollback per un nuovo cutover). */
  'SHADOW_PARITY_REQUIRED',
  /** Matrice device non dichiarata o fallita. */
  'DEVICE_MATRIX_REQUIRED',
  /** Backup coordinato di più di 2 ore (cutover) o assente. */
  'BACKUP_TOO_OLD',
  /** Conflitti aperti dello shadow o del ledger. */
  'OPEN_CONFLICTS',
  /** Proiezione inversa con REVERSE_FAILED aperti. */
  'REVERSE_FAILED_OPEN',
  /** Job del calendario in dead letter. */
  'DEAD_JOBS',
  /** Salute del calendario non verde. */
  'HEALTH_NOT_GREEN',
  /** Rollback senza un'anteprima riuscita. */
  'PREVIEW_REQUIRED',
  /** Anteprima del rollback più vecchia del limite. */
  'PREVIEW_STALE',
  /** Password di caldes-probe assente: la quiescenza non è verificabile. */
  'PROBE_UNAVAILABLE',
  /** Control-plane non attivo nel processo: lo stato non arriverebbe ai device. */
  'CONTROL_PLANE_UNAVAILABLE',
  /** Archivio della Fase 0 scrivibile dai device dopo il cutover (questione aperta 1 della F3). */
  'ARCHIVE_DEVICE_WRITABLE',
] as const;
export type PreconditionReason = (typeof PRECONDITION_REASONS)[number];

// ─── Utilità pure ───────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conteggio a zero per ogni azione del piano. */
export function emptyActionCounts(): Record<PlanAction, number> {
  return { create: 0, update: 0, delete: 0, noop: 0, adopt: 0, skip: 0, conflict: 0 };
}

/** Conteggio a zero per ogni esito dell'apply. */
export function emptyOutcomeCounts(): Record<ApplyOutcome, number> {
  return { done: 0, adopted: 0, noop: 0, skipped: 0, conflict: 0, failed: 0, forced: 0 };
}

/** Conteggio a zero delle righe dell'inventario. */
export function emptyInventoryCounts(): InventoryCounts {
  return {
    rows: 0, singles_timed: 0, singles_all_day: 0, series: 0, overrides_modified: 0, overrides_cancelled: 0,
    exdates: 0, projections: 0, holidays_system: 0, closures: 0, non_projection_in_bookings: 0,
  };
}

/** true se `value` è una frase di conferma esatta. */
export function confirmationMatches(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value === expected;
}

// ─── F4: transizioni, proiezione inversa, rollback, finalize ─────────────────
//
// Contratto docs/calendar-radicale/contracts/f4-modules.md. Sezione aggiunta
// dalla fondazione della F4: i quattro gruppi (CUTOVER, REVERSE, ROLLBACK, UI)
// importano da qui codici, passi, parametri, riassunti e DTO; un campo nuovo
// passa da un aggiornamento del contratto.

/** SQLSTATE della guardia 166 su calendar_events (scrittura fuori da mode postgres senza caldes.reverse_sync). */
export const CALENDAR_EVENTS_GUARD_SQLSTATE = 'CD166' as const;

/** GUC degli scrittori privilegiati di calendar_events (proiezione inversa, erasure GDPR, delete di un calendario). */
export const REVERSE_SYNC_GUC = 'caldes.reverse_sync' as const;

/** Run della F4 (CHECK della 165): li creano le route del gruppo UI. */
export const F4_RUN_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>([
  'cutover', 'rollback_preview', 'rollback', 'rebaseline', 'finalize',
]);

/** Run della F4 che scrivono: conferma digitata e chiave d'idempotenza obbligatorie. */
export const F4_WRITING_RUN_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>([
  'cutover', 'rollback', 'rebaseline', 'finalize',
]);

/** Transizioni di stato journalizzate (cal_migration_transitions.kind). */
export const TRANSITION_KINDS = ['cutover', 'rollback', 'finalize'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** active: in corso o da riprendere; completed; aborted: tornata al mode di partenza prima del passo d'epoch. */
export const TRANSITION_STATUSES = ['active', 'completed', 'aborted'] as const;
export type TransitionStatus = (typeof TRANSITION_STATUSES)[number];

/** started: in corso o interrotto da un crash; done; skipped; failed: ultimo tentativo fallito (la ripresa lo ripete). */
export const JOURNAL_STEP_STATUSES = ['started', 'done', 'skipped', 'failed'] as const;
export type JournalStepStatus = (typeof JOURNAL_STEP_STATUSES)[number];

/** Passi del cutover nell'ordine (design §13.10, contratto f4-modules §3.1). */
export const CUTOVER_STEPS = [
  'preflight', 'freeze', 'quiesce', 'delta_apply', 'delta_verify', 'epoch',
  'control_plane', 'index_sync', 'reverse_start', 'bookings_reconcile', 'unfreeze', 'smoke',
] as const;
export type CutoverStep = (typeof CUTOVER_STEPS)[number];

/** Passi del rollback nell'ordine (design §13.12, contratto f4-modules §5.1). */
export const ROLLBACK_STEPS = [
  'preflight', 'freeze', 'quiesce', 'index_sync', 'reverse_final', 'rebaseline', 'epoch', 'control_plane', 'cleanup',
] as const;
export type RollbackStep = (typeof ROLLBACK_STEPS)[number];

/** Passi del finalize nell'ordine (design §13.13, contratto f4-modules §5.4). */
export const FINALIZE_STEPS = ['preflight', 'stop_reverse', 'state', 'legacy_finalize'] as const;
export type FinalizeStep = (typeof FINALIZE_STEPS)[number];

/** Passo d'annullamento (cutover e rollback, solo prima del passo d'epoch): ritorno al mode di partenza. */
export const TRANSITION_ABORT_STEP = 'abort' as const;

/** Passi dopo i quali una transizione non si annulla più (il passo d'epoch ha cambiato il marker e lo stato). */
export const POINT_OF_NO_RETURN_STEP = 'epoch' as const;

/** Mode di partenza, mode intermedio (scritture sospese), mode d'arrivo e mode dell'annullamento. */
export const TRANSITION_MODES: Readonly<Record<TransitionKind, { from: BackendMode; via: BackendMode | null; to: BackendMode; abort_to: BackendMode | null }>> = Object.freeze({
  cutover: { from: 'postgres', via: 'cutover', to: 'radicale', abort_to: 'postgres' },
  rollback: { from: 'radicale', via: 'rollback', to: 'postgres', abort_to: 'radicale' },
  finalize: { from: 'radicale', via: null, to: 'finalized', abort_to: null },
});

export const F4_LIMITS = Object.freeze({
  /** Finestra di rollback di default dopo il cutover (design §1 invariante 6). */
  rollbackWindowDays: 30,
  /** Finestra minima e massima ammessa dalla richiesta di cutover. */
  rollbackWindowMinDays: 14,
  rollbackWindowMaxDays: 90,
  /** Finalize possibile dopo almeno 14 giorni dal cutover (design §13.13). */
  finalizeMinDays: 14,
  /** Backup coordinato richiesto dal cutover: meno di 2 ore (design §13.10 passo 1). */
  cutoverBackupMaxAgeMinutes: 120,
  /** Anteprima del rollback più vecchia di così: da rigenerare. */
  rollbackPreviewMaxAgeMinutes: 60,
  /** Attesa minima dopo la scrittura della policy (oltre il ricontrollo di 1 s dei plugin, design §13.9). */
  quiescencePolicyGraceMs: 2_000,
  /** PUT del probe su _canary: fino a 10 tentativi, a 1 s l'uno dall'altro. */
  quiescenceProbeAttempts: 10,
  quiescenceProbeIntervalMs: 1_000,
  /** stat delle collezioni: due letture consecutive uguali a 1 s di distanza, al più 30 giri. */
  quiescenceStatIntervalMs: 1_000,
  quiescenceStatMaxRounds: 30,
  /** Attesa del gate cal-write esclusivo (scritture in corso). */
  exclusiveGateTimeoutMs: 30_000,
  /** Margine delle prenotazioni riaccodate a fine cutover (scritture a cavallo del freeze). */
  bookingsReconcileMarginMs: 5 * 60_000,
  /** Tentativi del passo d'epoch con Radicale irraggiungibile prima di fallire il run (stato resta frozen). */
  epochRetryAttempts: 5,
});

/** Esito della quiescenza (journal del passo 'quiesce'). */
export interface QuiescenceReport {
  /** Gate cal-write: attesa delle scritture in corso. */
  gate: { drained_ms: number };
  /** Policy dopo il giro del control-plane: mode atteso 'frozen'. */
  policy: { mode: 'shadow' | 'live' | 'frozen' | null; version: number | null; reasons: string[]; written_at: string | null };
  /** Attesa dopo la policy (≥ quiescencePolicyGraceMs). */
  waited_ms: number;
  /** PUT del probe su _canary: tentativi e stato finale (403 atteso). */
  probe: { attempts: number; status: number };
  /** stat delle collezioni: sorgente, giri fino a due letture uguali, collezioni osservate. */
  stat: { source: 'mount' | 'remote'; rounds: number; collections: number };
  finished_at: string;
}

/** Passo del journal (DTO, cal_migration_journal). */
export interface JournalStepView {
  step: string;
  seq: number;
  status: JournalStepStatus;
  attempts: number;
  run_id: string | null;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error: string | null;
  data: Record<string, unknown>;
}

/** Transizione (DTO, cal_migration_transitions con i passi). */
export interface TransitionView {
  id: string;
  kind: TransitionKind;
  status: TransitionStatus;
  from_mode: BackendMode;
  target_mode: BackendMode;
  run_id: string | null;
  epoch_before: number;
  epoch_after: number | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  outcome_code: string | null;
  outcome: string | null;
  data: Record<string, unknown>;
  steps: JournalStepView[];
  /** Primo passo non concluso nell'ordine del tipo (null se concluso tutto). */
  next_step: string | null;
  /** Attiva senza un run in corso: si riprende dal wizard. */
  resumable: boolean;
  /** Attiva e prima del passo d'epoch: si può annullare (cutover e rollback). */
  abortable: boolean;
}

/** Finestra di rollback (DTO del wizard dopo il cutover). */
export interface RollbackWindowView {
  cutover_at: string;
  cutover_by: string | null;
  rollback_until: string | null;
  /** Giorni interi residui (0 a finestra scaduta). */
  days_left: number;
  expired: boolean;
  /** Primo istante in cui il finalize è ammesso (cutover + finalizeMinDays). */
  finalize_available_at: string;
  finalize_ready: boolean;
  finalize_blockers: PreconditionReason[];
}

// ─── F4: proiezione inversa (design §13.11) ──────────────────

/**
 * Classi dei degradi della proiezione inversa (cal_migration_items.code con
 * item_type 'degradation', cal_migration_reverse_state.degradations):
 * - REPR_LOSS_VALARM, REPR_LOSS_ATTENDEE: allarmi e invitati non rappresentabili in PG (restano nel volume);
 * - REPR_LOSS_PROPERTY: altre proprietà senza colonna legacy (X-*, CATEGORIES, CLASS, ...);
 * - SEMANTIC_EXPANDED: risorsa espansa in occorrenze singole derivate (caldes_derived);
 * - SEMANTIC_TRANSP: TRANSP:TRANSPARENT reso come status 'tentative' (non blocca nemmeno nel legacy);
 * - SANITIZED_UID, SANITIZED_DURATION, SANITIZED_SUMMARY, SANITIZED_STATUS: valori adattati ai vincoli legacy;
 * - REVERSE_FAILED: upsert non riuscito (mai un job fallito in silenzio).
 */
export const DEGRADATION_CLASSES = [
  'REPR_LOSS_VALARM',
  'REPR_LOSS_ATTENDEE',
  'REPR_LOSS_PROPERTY',
  'SEMANTIC_EXPANDED',
  'SEMANTIC_TRANSP',
  'SANITIZED_UID',
  'SANITIZED_DURATION',
  'SANITIZED_SUMMARY',
  'SANITIZED_STATUS',
  'REVERSE_FAILED',
] as const;
export type DegradationClass = (typeof DEGRADATION_CLASSES)[number];

/** Degrado di una risorsa (cal_migration_reverse_state.degradations): mai dati personali. */
export interface DegradationRecord {
  class: DegradationClass;
  recurrence_key?: string | null;
  detail?: Record<string, unknown>;
}

/** Stato della proiezione di una risorsa (cal_migration_reverse_state.status). */
export const REVERSE_STATE_STATUSES = ['projected', 'degraded', 'failed', 'removed'] as const;
export type ReverseStateStatus = (typeof REVERSE_STATE_STATUSES)[number];

/** Riga di calendar_events scritta per una risorsa (cal_migration_reverse_state.rows). */
export interface ReverseRowRef {
  id: string;
  recurrence_key: string;
  role: 'master' | 'override' | 'derived' | 'projection';
}

/** Esito di una passata della proiezione inversa (completa o per collezione). */
export interface ReverseApplySummary {
  objects: number;
  projected: number;
  degraded: number;
  failed: number;
  removed: number;
  unchanged: number;
  rows: { inserted: number; updated: number; deleted: number };
  by_class: Partial<Record<DegradationClass, number>>;
  duration_ms: number;
}

/** Salute della proiezione inversa (DTO del wizard dopo il cutover). */
export interface ReverseProjectionHealthView {
  /** mode radicale e rollback_until nel futuro. */
  active: boolean;
  until: string | null;
  objects: number;
  by_status: Record<ReverseStateStatus, number>;
  by_class: Partial<Record<DegradationClass, number>>;
  derived_rows: number;
  last_projected_at: string | null;
  queue: { pending: number; running: number; dead: number };
}

/**
 * Gruppo di righe derivate (caldes_derived) di una risorsa espansa dalla
 * proiezione inversa: base della ri-baseline e del conflitto DERIVED_EDITED
 * (membro dell'unione LegacySnapshot, contratto f4-modules §5.6).
 */
export interface LegacyDerivedSnapshot {
  v: 1;
  kind: 'derived';
  calendar: CalendarSnapshot;
  /** cal_object_ids.id della risorsa (recurrence_key ''). */
  object_id: string;
  /** Righe derivate ordinate per start_time e id. */
  rows: LegacyEventRowSnapshot[];
}

// ─── F4: smoke del cutover (design §13.10 passo 7) ───────────

/** SLOTS (slot pubblici), BOOKING_ROLLBACK (createBooking in tx annullata), FEED (feed per token), MCP_READ (tool in lettura), NO_SIDE_EFFECTS (nessuna prenotazione, job, email o workflow residuo). */
export const SMOKE_CHECK_CODES = ['SLOTS', 'BOOKING_ROLLBACK', 'FEED', 'MCP_READ', 'NO_SIDE_EFFECTS'] as const;
export type SmokeCheckCode = (typeof SMOKE_CHECK_CODES)[number];

export interface SmokeCheck {
  code: SmokeCheckCode;
  ok: boolean;
  ms: number;
  /** Testo in italiano senza dati personali. */
  detail: string | null;
}

export interface SmokeReport {
  ok: boolean;
  started_at: string;
  finished_at: string;
  checks: SmokeCheck[];
}

// ─── F4: parametri, richieste e riassunti dei run ────────────

export interface CutoverParams {
  /** start: nuova transizione; resume: riprende quella attiva; abort: annulla quella attiva (solo prima di 'epoch'). */
  action: 'start' | 'resume' | 'abort';
  /** Giorni della finestra di rollback (F4_LIMITS.rollbackWindowMinDays..rollbackWindowMaxDays). */
  rollback_window_days: number;
  /** Verifica completa (V1-V5) di riferimento dei criteri, vista dall'utente. */
  verify_run_id: string | null;
}

export interface RollbackPreviewParams { scope: MigrationScope }

export interface RollbackParams {
  action: 'start' | 'resume' | 'abort';
  /** Run rollback_preview confermato dall'utente. */
  preview_run_id: string | null;
  /** preview_hash dell'anteprima: dopo la quiescenza si ricalcola e, se diverso, il rollback si annulla (salvo emergenza). */
  expect_preview_hash: string | null;
  /** Rollback di emergenza: prosegue con l'anteprima cambiata o con la sync finale non riuscita (design §13.12). */
  emergency: boolean;
}

export interface RebaselineParams {
  scope: MigrationScope;
  /** rollback: passo del rollback; manual: run di riparazione dal wizard (solo mode postgres). */
  reason: 'rollback' | 'manual';
}

export interface FinalizeParams { action: 'start' | 'resume' }

export interface CutoverRequest {
  confirm: string;
  rollback_window_days?: number;
  verify_run_id?: string | null;
}
export interface CutoverAbortRequest { confirm: string }
export interface TransitionResumeRequest { confirm: string }
export interface RollbackPreviewRequest { scope?: MigrationScope }
export interface RollbackRequest {
  preview_run_id: string;
  expect_preview_hash?: string | null;
  confirm: string;
  emergency?: boolean;
  /** Obbligatoria con emergency: MIGRATION_CONFIRMATIONS.rollbackEmergency. */
  confirm_emergency?: string;
}
export interface FinalizeRequest { confirm: string }
export interface RebaselineRequest { scope?: MigrationScope; confirm: string }

export interface CutoverSummary {
  transition_id: string;
  outcome: 'completed' | 'aborted';
  abort_reason: string | null;
  epoch_before: number;
  epoch_after: number | null;
  rollback_until: string | null;
  quiescence: QuiescenceReport | null;
  delta: ApplySummary | null;
  verify: VerifySummary | null;
  reverse: ReverseApplySummary | null;
  bookings_reconciled: number;
  /** Smoke non riusciti non annullano il cutover: il wizard propone il rollback. */
  smoke: SmokeReport | null;
  steps: JournalStepView[];
}

export interface RollbackPreviewSummary {
  /** sha256 del JSON canonico di (oggetti, righe previste, degradi per oggetto, REVERSE_FAILED), ordinati. */
  preview_hash: string;
  generated_at: string;
  cutover_at: string | null;
  rollback_until: string | null;
  /** Cambiamenti dal cutover (versioni dell'indice), per origine. */
  changes_since_cutover: {
    created: number;
    updated: number;
    deleted: number;
    by_actor: Partial<Record<'device' | 'admin' | 'mcp' | 'agent' | 'system' | 'booking' | 'other', number>>;
  };
  objects: number;
  derived_rows: number;
  by_class: Partial<Record<DegradationClass, number>>;
  reverse_failed: number;
  /** Busy legacy dopo il rollback identico a quello di Radicale sull'orizzonte (null se non calcolato). */
  busy_identical: boolean | null;
  calendars: Array<{ calendar_id: string; collection_name: string; objects: number; degraded: number; failed: number; derived_rows: number }>;
}

export interface RebaselineSummary {
  /** Righe del ledger considerate. */
  rows: number;
  /** Righe riallineate (href reale, legacy_snapshot e hash correnti, etag corrente, adopted). */
  rebaselined: number;
  /** Righe nuove (oggetti creati nella finestra: device, admin, MCP). */
  created: number;
  /** Righe ritirate (risorsa e sorgente sparite). */
  retired: number;
  /** Righe tolte dal ledger (risorsa senza righe legacy, es. REVERSE_FAILED): oggetto non tracciato, mai cancellato dal piano. */
  untracked: number;
  derived: number;
  adopted: number;
  skipped: number;
  duration_ms: number;
}

export interface RollbackSummary {
  transition_id: string;
  outcome: 'completed' | 'aborted';
  abort_reason: string | null;
  emergency: boolean;
  preview_hash: string | null;
  final_preview_hash: string | null;
  epoch_before: number;
  epoch_after: number | null;
  quiescence: QuiescenceReport | null;
  index_sync: { collections: number; failed: number } | null;
  reverse: ReverseApplySummary | null;
  rebaseline: RebaselineSummary | null;
  steps: JournalStepView[];
}

export interface FinalizeSummary {
  transition_id: string;
  finalized_at: string;
  /** calendar_finalize_legacy() (migrazione 167, F7) eseguita; false se non ancora disponibile. */
  legacy_finalized: boolean;
  legacy_note: string | null;
  reverse_jobs_dropped: number;
  steps: JournalStepView[];
}

// ─── F4: export v2 del calendario (design §16.2) ─────────────

/** manifest.json dello zip dell'export v2: un .ics per collezione. */
export interface CalendarExportManifest {
  format: 'caldes-calendar-export';
  version: 2;
  generated_at: string;
  backend_mode: BackendMode;
  volume_id: string | null;
  epoch: number;
  principal: string;
  collections: Array<{
    calendar_id: string;
    collection_name: string;
    name: string;
    role: CalendarRole;
    /** Percorso nello zip (`collections/<collection_name>.ics`). */
    file: string;
    objects: number;
    sha256: string;
  }>;
  skipped: Array<{ calendar_id: string; collection_name: string | null; reason: string }>;
}
