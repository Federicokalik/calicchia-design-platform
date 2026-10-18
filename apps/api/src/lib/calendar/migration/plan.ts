/**
 * Piano della migrazione a Radicale (fase F3 del piano; design §13.4-§13.6,
 * §13.8; contratto docs/calendar-radicale/contracts/f3-modules.md §4, §6.2 e
 * §7.2).
 *
 * Confronta, per ogni chiave legacy, l'oggetto voluto dal serializer (S), le
 * righe vive del ledger (L) e lo stato di Radicale (T, letto con PROPFIND
 * getetag e, dove serve, con calendar-multiget) e decide un'azione: create,
 * update, delete, noop, adopt, skip o conflict (tabella del contratto §7.2,
 * in modo `apply` o `shadow`). `computePlan` è pura; `buildPlan` legge
 * sorgente, ledger e destinazione e la chiama (anteprima, apply, shadow);
 * `runPlan` è il run d'anteprima del wizard: una riga 'object' per item e una
 * riga 'anomaly' per anomalia, più un riassunto leggibile per calendario con
 * conteggi, esempi, anomalie e opzioni (design §13.4).
 *
 * Il piano non scrive mai né su Radicale né sul ledger: l'esecuzione è di
 * apply.ts (protocollo delle righe d'intento, contratto §4.3).
 *
 * Convenzioni dei PlanItem che apply.ts e shadow.ts leggono:
 *  - `code` di un'azione di scrittura (create, update, delete) con un codice
 *    di CONFLICT_CODES = item FORZATO ("forza" per item o per codice): esito
 *    `forced`, riga con forced = true; con un codice di SKIP_CODES su una
 *    delete = motivo della cancellazione (sorgente saltata);
 *  - `ledger.intent_op` non nullo e azione diversa da `adopt` = intento mai
 *    applicato (il GET della destinazione lo ha escluso): apply lo azzera o lo
 *    sostituisce con l'intento nuovo; `adopt` con un intento pendente =
 *    adozione dell'intento (transazione 2 senza richiesta), con
 *    `intent_op = 'delete'` = ritiro della riga;
 *  - `other_href` non nullo: l'UID dell'oggetto vive a quell'href (adozione
 *    di quell'href, o scrittura forzata lì con If-Match di `target.etag`);
 *  - `patch` = update come patch per campo sull'oggetto corrente
 *    (patchFromLegacyDiff fra ledger.legacy_snapshot e source.legacy_snapshot;
 *    con lo snapshot redatto dall'erasure GDPR, patchTowardSnapshot senza base);
 *  - `target.etag` = If-Match di update e delete; per una create
 *    If-None-Match: *.
 */

import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import { createHash } from 'node:crypto';
import { INDEX_LIMITS } from '../index-model';
import { collectionPath, isValidObjectName, objectPath, type RadicaleClient } from '../radicale/client';
import { DAV_PROPS, type Multistatus } from '../radicale/dav-xml';
import { isRadicaleError } from '../radicale/errors';
import type { Db } from '../radicale/policy';
import { radicaleRuntime } from '../radicale/sync';
import {
  buildObjectFromSnapshot,
  canonicalJson,
  type LegacySource,
  loadLegacySource,
  patchFromLegacyDiff,
  patchTowardSnapshot,
  resolveMoveTarget,
  serializeLegacy,
} from './serialize';
import { computeSubscriptionImpacts, loadMigrationCalendars } from './inventory';
import {
  ANOMALY_DEFINITIONS,
  type AnomalyCode,
  type AnomalyRecord,
  type ConflictCode,
  CONFLICT_CODES,
  DEFAULT_MIGRATION_OPTIONS,
  emptyActionCounts,
  FORCEABLE_CONFLICTS,
  isWriteAction,
  type ItemSeverity,
  type LedgerRow,
  type LegacyKey,
  MIGRATION_LIMITS,
  type MigrationCalendar,
  MigrationError,
  type MigrationItemInput,
  type MigrationOptions,
  type MigrationRunContext,
  type MigrationScope,
  type ObjectItemDetail,
  type PlanAction,
  type PlanCalendarCounts,
  type PlanItem,
  type PlanMode,
  type PlanParams,
  type PlanSummary,
  resolveMigrationOptions,
  type SerializationResult,
  type SerializedObject,
  type SkipCode,
  type SkippedSource,
  type SubscriptionImpact,
  type TargetObject,
} from './types';

// ─── Tipi del contratto ───────────────────────────────

export interface TargetCollection {
  calendar_id: string;
  collection_name: string;
  exists: boolean;
  objects: ReadonlyMap<string, TargetObject>;
  /**
   * Collezione presente con un'altra dead prop calendar-id (o senza): per
   * l'inizializzazione è un conflitto "mai toccata" (contratto §6.1), quindi
   * per il piano non è utilizzabile (COLLECTION_MISSING, mai forzabile).
   * Valore: la calendar-id trovata ('' se assente). Assente o null = la
   * collezione è del calendario (o non si è letta la proprietà).
   */
  foreign?: string | null;
}
export interface TargetSnapshot { read_at: Date; collections: ReadonlyMap<string, TargetCollection> }
export interface PlanInput {
  mode: PlanMode;
  serialization: SerializationResult;
  /** Righe vive del ledger delle collezioni nell'ambito (e, per lo shadow, delle chiavi dell'ambito). */
  ledger: readonly LedgerRow[];
  target: TargetSnapshot;
  /** Le cancellazioni (fonte sparita) si calcolano solo dentro l'ambito. */
  scope: { calendarIds: ReadonlySet<string>; legacyKeys: ReadonlySet<LegacyKey> | null };
  force: PlanForce;
}

/**
 * "Forza" per item (chiavi planItemKey) o per codice. Con `preview` (apply
 * legato a un run d'anteprima) la forza vale SOLO per i conflitti mostrati
 * nell'anteprima: chiave presente, stesso codice e stesso etag della
 * destinazione di allora. Un conflitto nato dopo (per esempio fra due
 * tentativi dello stesso run) o con la destinazione cambiata di nuovo resta un
 * conflitto: mai sovrascrivere modifiche che l'utente non ha visto.
 */
export interface PlanForce {
  itemKeys: ReadonlySet<string>;
  codes: ReadonlySet<ConflictCode>;
  preview?: ReadonlyMap<string, { code: string | null; target_etag: string | null }>;
}

const CONFLICT_CODE_SET: ReadonlySet<string> = new Set<string>(CONFLICT_CODES);

/** Ordine delle azioni nel piano e nelle righe del run (adozioni, scritture, cancellazioni per ultime). */
const ACTION_ORDER: Readonly<Record<PlanAction, number>> = Object.freeze({
  adopt: 0, create: 1, update: 2, delete: 3, conflict: 4, noop: 5, skip: 6,
});

// ─── Chiavi e hash ───────────────────────────────

/** Chiave stabile di un item fra anteprima e apply ("forza"): `${calendar_id}/${href}#${legacy_key}`. */
export function planItemKey(item: Pick<PlanItem, 'calendar_id' | 'href' | 'legacy_key'>): string {
  return `${item.calendar_id}/${item.href}#${item.legacy_key}`;
}

/** sha256 del JSON canonico delle tuple (calendar_id, href, legacy_key, action, code, legacy_hash, fingerprint voluto, etag della destinazione), ordinate. */
export function planHash(items: readonly PlanItem[]): string {
  const tuples = items
    .map((i) => canonicalJson([
      i.calendar_id,
      i.href,
      i.legacy_key,
      i.action,
      i.code,
      i.source?.legacy_hash ?? null,
      i.source?.fingerprint ?? null,
      i.target?.etag ?? null,
    ]))
    .sort();
  return createHash('sha256').update(`[${tuples.join(',')}]`, 'utf8').digest('hex');
}

/** Il master di una riga `detached` (legacy_snapshot.master_id), se noto. */
function detachedMasterOf(l: Pick<LedgerRow, 'kind' | 'legacy_snapshot'>): string | null {
  if (l.kind !== 'detached' || !l.legacy_snapshot || l.legacy_snapshot.kind !== 'detached') return null;
  return l.legacy_snapshot.master_id ?? null;
}

// ─── Piano (puro) ───────────────────────────────

type Decision = Omit<PlanItem, 'legacy_key' | 'kind' | 'calendar_id' | 'collection_name' | 'href' | 'source' | 'ledger' | 'target'> & {
  target?: TargetObject | null;
  /** Azione di scrittura sospesa da REVALIDATION_REQUIRED (la esegue "forza"). */
  pending?: PlanAction | null;
  /** Oggetto all'altro href (UID_AT_OTHER_HREF / adozione). */
  otherTarget?: TargetObject | null;
};

interface PlanState {
  input: PlanInput;
  ledgerByCalHref: ReadonlyMap<string, LedgerRow>;
  /** Azione sospesa delle righe REVALIDATION_REQUIRED, per "forza". */
  pending: Map<PlanItem, PlanAction>;
  others: Map<PlanItem, TargetObject>;
}

function decision(action: PlanAction, extra: Partial<Decision> = {}): Decision {
  return { action, code: null, patch: false, other_href: null, fields: [], ...extra };
}

/** Riga 17: una scrittura su una riga da rivalidare diventa conflitto (mai una sovrascrittura). */
function guardRevalidation(d: Decision, l: LedgerRow | null): Decision {
  if (!l || !l.revalidate_reason || !isWriteAction(d.action)) return d;
  return { ...d, action: 'conflict', code: 'REVALIDATION_REQUIRED', pending: d.action };
}

/**
 * Riga scritta dallo strumento: etag o fingerprint dell'ultima scrittura
 * registrati. Una PUT riuscita senza ETag leggibile (risposta senza ETag e
 * PROPFIND fallito) lascia written_etag NULL ma written_fingerprint (e
 * written_at) valorizzati: la riga resta "scritta" e il confronto passa dal
 * fingerprint, così una fonte sparita produce una delete e non un ritiro che
 * lascerebbe l'oggetto orfano sui device.
 */
function isWritten(l: Pick<LedgerRow, 'written_etag' | 'written_fingerprint'> | null): boolean {
  return l !== null && (l.written_etag !== null || l.written_fingerprint !== null);
}

/** Collezione utilizzabile dal piano: esiste ed è del calendario (calendar-id uguale). */
function usableCollection(coll: TargetCollection | undefined): coll is TargetCollection {
  return Boolean(coll && coll.exists && (coll.foreign === undefined || coll.foreign === null));
}

/** Snapshot redatto dall'erasure GDPR su una riga scritta (legacy_snapshot NULL): la scrittura è una cancellazione dovuta. */
function isRedacted(l: LedgerRow | null): boolean {
  return l !== null && l.legacy_snapshot === null && isWritten(l);
}

type IntentOutcome = 'adopt' | 'stale' | { conflict: ConflictCode };

/** Riga 1 e §4.3: esito di un intento pendente dal GET della destinazione. */
function resolveIntent(l: LedgerRow, t: TargetObject | null): IntentOutcome {
  if (l.intent_op === 'delete') {
    if (!t) return 'adopt';
    if (l.intent_etag !== null && t.etag === l.intent_etag) return 'stale';
    return { conflict: 'TARGET_NEWER' };
  }
  if (t && t.fingerprint !== null && t.fingerprint === l.intent_fingerprint) return 'adopt';
  if (!t) return 'stale';
  if (t.fingerprint !== null && l.written_fingerprint !== null && t.fingerprint === l.written_fingerprint) return 'stale';
  return { conflict: 'UNTRACKED_TARGET' };
}

/**
 * UID dell'oggetto voluto a un altro href della stessa collezione: fra gli
 * oggetti letti (UID noto) e fra le righe vive del ledger di altre chiavi con
 * quell'UID (oggetti tracciati di cui non si è letto il contenuto). Radicale
 * rifiuterebbe la PUT con no-uid-conflict e il ledger ammette un solo UID vivo
 * per collezione: meglio un conflitto pianificato che un errore dell'apply.
 */
function uidElsewhere(state: PlanState, coll: TargetCollection, s: SerializedObject): TargetObject | null {
  for (const t of coll.objects.values()) {
    if (t.href !== s.href && t.uid !== null && t.uid === s.uid) return t;
  }
  for (const l of state.ledgerByCalHref.values()) {
    if (l.calendar_id !== s.calendar_id || l.href === s.href || l.legacy_key === s.legacy_key || l.uid !== s.uid) continue;
    const t = coll.objects.get(l.href);
    if (t) return t;
  }
  return null;
}

/** Campi cambiati fra lo snapshot scritto e quello voluto (dettaglio dell'anteprima). */
function changedFields(l: LedgerRow, s: SerializedObject, now: Date): string[] {
  const prev = l.legacy_snapshot;
  if (!prev || prev.kind !== s.legacy_snapshot.kind || prev.kind === 'archive') return [];
  try {
    const base = buildObjectFromSnapshot(prev, { now }).object;
    const tz = s.legacy_snapshot.kind === 'archive' ? 'Europe/Rome' : s.legacy_snapshot.calendar.timezone;
    return patchFromLegacyDiff(base, prev, s.legacy_snapshot, { tz, now }).fields;
  } catch {
    return [];
  }
}

/**
 * Shadow, righe 7 e 10: patch per campo sull'oggetto corrente. Con la
 * destinazione invariata i conflitti del CAS non contano (è l'oggetto
 * scritto dallo strumento); con la destinazione cambiata un campo toccato e
 * cambiato anche lì è BOTH_CHANGED.
 */
function shadowUpdate(s: SerializedObject, l: LedgerRow, t: TargetObject, targetChanged: boolean, now: Date): Decision {
  const prev = l.legacy_snapshot;
  const wanted = s.legacy_snapshot;
  if (wanted.kind === 'archive' || (prev && prev.kind !== wanted.kind) || !t.raw) {
    return targetChanged ? decision('conflict', { code: 'BOTH_CHANGED' }) : guardRevalidation(decision('update', { fields: changedFields(l, s, now) }), l);
  }
  const parsed = parseCalendarObject(t.raw);
  if (!parsed.ok) return targetChanged ? decision('conflict', { code: 'BOTH_CHANGED' }) : guardRevalidation(decision('update'), l);
  try {
    const tz = wanted.calendar.timezone;
    if (!prev) {
      // Snapshot redatto dall'erasure GDPR: patch senza base verso l'oggetto voluto (i campi del piano
      // prendono il valore del legacy, la cancellazione è dovuta; VALARM, ATTENDEE e X-* restano).
      // Niente REVALIDATION_REQUIRED: la patch tocca solo i campi del piano verso il legacy autorevole,
      // con If-Match dell'etag appena letto, e nome e telefono non devono restare sui device in attesa
      // di un "forza" (la riga si smarca alla scrittura riuscita).
      const toward = patchTowardSnapshot(parsed.value, wanted, { tz, now });
      if (!toward.changed) return decision('adopt');
      return decision('update', { patch: true, fields: toward.fields });
    }
    const patch = patchFromLegacyDiff(parsed.value, prev, wanted, { tz, now });
    if (targetChanged && patch.conflicts.length > 0) {
      return decision('conflict', { code: 'BOTH_CHANGED', fields: [...new Set(patch.conflicts.map((c) => c.field))].sort() });
    }
    if (!patch.changed) {
      if (targetChanged) return decision('noop');
      // Destinazione invariata (è lo scritto) ma la patch dallo snapshot non cambia nulla: si adotta solo
      // se i campi del piano coincidono davvero con l'oggetto voluto; altrimenti la base ricostruita non
      // rappresenta lo scritto (per esempio una minimizzazione dei 24 mesi) e serve la patch senza base.
      const toward = patchTowardSnapshot(parsed.value, wanted, { tz, now });
      if (!toward.changed) return decision('adopt');
      return guardRevalidation(decision('update', { patch: true, fields: toward.fields }), l);
    }
    return guardRevalidation(decision('update', { patch: true, fields: patch.fields }), l);
  } catch {
    return targetChanged ? decision('conflict', { code: 'BOTH_CHANGED' }) : guardRevalidation(decision('update'), l);
  }
}

/**
 * F4 (contratto f4-modules §5.6, riga nuova della tabella f3 §7.2): sorgente
 * `derived` (righe derivate dalla proiezione inversa di una risorsa espansa).
 * Le righe derivate non ricostruiscono la regola: mai una scrittura.
 * Riga viva con lo stesso hash e la risorsa al suo posto → noop (adopt se
 * l'etag è cambiato con lo stesso contenuto o se la riga va solo
 * riallineata); hash diverso, nessuna riga del ledger o risorsa sparita →
 * conflict:DERIVED_EDITED (forzabile: "mantieni la risorsa di Radicale",
 * ledger riallineato senza scrivere; la modifica in PG si perde).
 */
function decideDerived(state: PlanState, s: SerializedObject, l: LedgerRow | null): Decision {
  const coll = state.input.target.collections.get(s.calendar_id);
  const t = coll?.objects.get(s.href) ?? null;
  if (!coll || !coll.exists) return decision('conflict', { code: 'COLLECTION_MISSING', target: null });
  if (!t) return decision('conflict', { code: 'DERIVED_EDITED', target: null });
  if (l && l.intent_op) return decision('conflict', { code: 'UNTRACKED_TARGET', target: t });
  if (!l || l.written_etag === null) return decision('conflict', { code: 'DERIVED_EDITED', target: t });
  const hashSame = l.legacy_hash !== null && l.legacy_hash === s.legacy_hash;
  if (!hashSame) return decision('conflict', { code: 'DERIVED_EDITED', target: t });
  const etagSame = t.etag !== null && t.etag === l.written_etag;
  if (etagSame) return decision('noop', { target: t });
  const fpSame = t.fingerprint !== null && l.written_fingerprint !== null && t.fingerprint === l.written_fingerprint;
  if (fpSame) return decision('adopt', { target: t });
  // La risorsa è cambiata su Radicale dopo la ri-baseline (non dovrebbe accadere in mode postgres):
  // le righe derivate restano quelle di prima, la decisione è dell'admin.
  return decision('conflict', { code: 'DERIVED_EDITED', target: t });
}

/** Righe 1-11 e 17 per una chiave con l'oggetto voluto S (e la riga L della stessa collezione, se c'è). */
function decideSource(state: PlanState, s: SerializedObject, l: LedgerRow | null): Decision {
  if (s.legacy_snapshot.kind === 'derived') return decideDerived(state, s, l);
  const { mode, target } = state.input;
  const now = target.read_at;
  const coll = target.collections.get(s.calendar_id);
  const t = coll?.objects.get(s.href) ?? null;

  if (l && l.intent_op) {
    const outcome = resolveIntent(l, t);
    if (outcome === 'adopt') return decision('adopt', { target: t });
    if (outcome !== 'stale') return decision('conflict', { code: outcome.conflict, target: t });
  }
  if (!usableCollection(coll)) return decision('conflict', { code: 'COLLECTION_MISSING', target: null });

  const written = isWritten(l);
  if (!written) {
    if (!t) {
      const other = uidElsewhere(state, coll, s);
      if (other) {
        const tracked = state.ledgerByCalHref.get(`${s.calendar_id}|${other.href}`);
        if (!tracked && other.fingerprint !== null && other.fingerprint === s.fingerprint) {
          return decision('adopt', { other_href: other.href, otherTarget: other, target: null });
        }
        return decision('conflict', { code: 'UID_AT_OTHER_HREF', other_href: other.href, otherTarget: other, target: null });
      }
      return guardRevalidation(decision('create', { target: null }), l);
    }
    if (t.fingerprint !== null && t.fingerprint === s.fingerprint) return decision('adopt', { target: t });
    return decision('conflict', { code: 'UNTRACKED_TARGET', target: t });
  }

  const row = l as LedgerRow;
  if (!t) return decision('conflict', { code: 'DELETED_IN_TARGET', target: null });
  const hashSame = row.legacy_hash !== null && row.legacy_hash === s.legacy_hash;
  const etagSame = t.etag !== null && t.etag === row.written_etag;
  const fpSame = !etagSame && t.fingerprint !== null && row.written_fingerprint !== null && t.fingerprint === row.written_fingerprint;
  if (etagSame || fpSame) {
    if (hashSame) return etagSame ? decision('noop', { target: t }) : decision('adopt', { target: t });
    // Sorgente cambiata ma contenuto voluto identico a quello scritto: si registra lo snapshot nuovo senza scrivere.
    if (row.written_fingerprint !== null && s.fingerprint === row.written_fingerprint) return decision('adopt', { target: t });
    if (mode === 'shadow') return { ...shadowUpdate(s, row, t, false, now), target: t };
    // Patch per campo sulle righe adottate o derivate (§4.4: mai la riscrittura completa); senza lo
    // snapshot precedente (redatto dall'erasure GDPR, legacy_hash NULL = "sorgente da riscrivere") la
    // patch è senza base, verso l'oggetto voluto (apply.ts, patchTowardSnapshot), e non aspetta la
    // rivalidazione: la cancellazione dei dati redatti è dovuta e tocca solo i campi del piano.
    if (isRedacted(row)) return { ...decision('update', { patch: true, fields: changedFields(row, s, now) }), target: t };
    const patch = row.adopted || row.derived;
    return { ...guardRevalidation(decision('update', { patch, fields: changedFields(row, s, now) }), row), target: t };
  }
  // Destinazione cambiata fuori dallo strumento: se ha già il contenuto voluto la si adotta.
  if (t.fingerprint !== null && t.fingerprint === s.fingerprint) return decision('adopt', { target: t });
  if (hashSame) return mode === 'shadow' ? decision('noop', { target: t }) : decision('conflict', { code: 'TARGET_NEWER', target: t });
  if (mode === 'shadow') return { ...shadowUpdate(s, row, t, true, now), target: t };
  return decision('conflict', { code: 'BOTH_CHANGED', target: t, fields: changedFields(row, s, now) });
}

/** Righe 12-15 per una riga viva L senza oggetto voluto in quella collezione (fonte sparita, salto o spostamento). */
function decideGone(state: PlanState, l: LedgerRow, reason: SkipCode | null): Decision {
  const coll = state.input.target.collections.get(l.calendar_id);
  const t = coll?.objects.get(l.href) ?? null;
  if (l.intent_op) {
    const outcome = resolveIntent(l, t);
    if (outcome === 'adopt') return decision('adopt', { target: t, code: reason });
    if (outcome !== 'stale') return decision('conflict', { code: outcome.conflict, target: t });
  }
  if (!usableCollection(coll)) return decision('conflict', { code: 'COLLECTION_MISSING', target: null });
  if (!isWritten(l) || !t) return decision('adopt', { target: t, code: reason });
  const same = (t.etag !== null && t.etag === l.written_etag)
    || (t.fingerprint !== null && l.written_fingerprint !== null && t.fingerprint === l.written_fingerprint);
  if (same) return guardRevalidation(decision('delete', { target: t, code: reason }), l);
  return decision('conflict', { code: 'TARGET_NEWER', target: t });
}

function inKeyScope(scope: PlanInput['scope'], key: LegacyKey, detachedMaster: string | null): boolean {
  if (scope.legacyKeys === null) return true;
  if (scope.legacyKeys.has(key)) return true;
  return detachedMaster !== null && scope.legacyKeys.has(`event:${detachedMaster}` as LegacyKey);
}

/** Una riga viva si tocca (cancellazione, ritiro) solo dentro l'ambito: calendario e, per lo shadow, chiave. */
function ledgerInScope(scope: PlanInput['scope'], l: LedgerRow): boolean {
  if (!scope.calendarIds.has(l.calendar_id)) return false;
  return inKeyScope(scope, l.legacy_key, detachedMasterOf(l));
}

function sourceMasterOf(s: SerializedObject | SkippedSource): string | null {
  if (s.kind !== 'detached') return null;
  if ('legacy_snapshot' in s && s.legacy_snapshot.kind === 'detached') return s.legacy_snapshot.master_id;
  return null;
}

/**
 * Applica "forza" (FORCEABLE_CONFLICTS, per item o per codice): il conflitto
 * diventa la scrittura del contenuto del piano con il codice originale
 * (marcatura di forzato per apply.ts). COLLECTION_MISSING non si forza mai.
 */
function applyForce(state: PlanState, item: PlanItem): PlanItem {
  const { force } = state.input;
  if (item.action !== 'conflict' || !item.code || !CONFLICT_CODE_SET.has(item.code)) return item;
  const code = item.code as ConflictCode;
  if (!FORCEABLE_CONFLICTS.has(code)) return item;
  const key = planItemKey(item);
  if (!force.codes.has(code) && !force.itemKeys.has(key)) return item;
  if (force.preview) {
    const seen = force.preview.get(key);
    if (!seen || seen.code !== code || (seen.target_etag ?? null) !== (item.target?.etag ?? null)) return item;
  }
  switch (code) {
    case 'TARGET_NEWER':
    case 'BOTH_CHANGED':
    case 'UNTRACKED_TARGET':
      if (item.source) return { ...item, action: item.target ? 'update' : 'create', patch: false };
      return item.target ? { ...item, action: 'delete' } : { ...item, action: 'adopt' };
    case 'DELETED_IN_TARGET':
      return item.source ? { ...item, action: 'create', patch: false, target: null } : item;
    case 'UID_AT_OTHER_HREF': {
      const other = state.others.get(item) ?? null;
      if (!item.source || !other) return item;
      return { ...item, action: 'update', patch: false, target: other, other_href: other.href };
    }
    case 'REVALIDATION_REQUIRED': {
      const pending = state.pending.get(item);
      return pending ? { ...item, action: pending } : item;
    }
    case 'DERIVED_EDITED':
      // "Mantieni la risorsa di Radicale": nessuna scrittura, il ledger si riallinea allo snapshot corrente.
      return item.source && item.target ? { ...item, action: 'adopt', patch: false } : item;
    default:
      return item;
  }
}

/** Pura: tabella del §7.2. */
export function computePlan(input: PlanInput): PlanItem[] {
  const live = input.ledger.filter((l) => l.deleted_at === null);
  const ledgerByKey = new Map<string, LedgerRow[]>();
  const ledgerByCalHref = new Map<string, LedgerRow>();
  for (const l of live) {
    const list = ledgerByKey.get(l.legacy_key) ?? [];
    list.push(l);
    ledgerByKey.set(l.legacy_key, list);
    ledgerByCalHref.set(`${l.calendar_id}|${l.href}`, l);
  }
  const state: PlanState = { input, ledgerByCalHref, pending: new Map(), others: new Map() };
  const objectsByKey = new Map(input.serialization.objects.map((o) => [o.legacy_key, o]));
  const skippedByKey = new Map(input.serialization.skipped.map((s) => [s.legacy_key, s]));
  const keys = [...new Set<string>([...objectsByKey.keys(), ...skippedByKey.keys(), ...ledgerByKey.keys()])].sort() as LegacyKey[];

  const items: PlanItem[] = [];
  const push = (base: Omit<PlanItem, 'action' | 'code' | 'patch' | 'other_href' | 'fields' | 'target'>, d: Decision, fallbackTarget: TargetObject | null): void => {
    const item: PlanItem = {
      ...base,
      action: d.action,
      code: d.code,
      target: d.target === undefined ? fallbackTarget : d.target,
      patch: d.patch,
      other_href: d.other_href,
      fields: d.fields,
    };
    if (d.pending) state.pending.set(item, d.pending);
    if (d.otherTarget) state.others.set(item, d.otherTarget);
    items.push(item);
  };

  for (const key of keys) {
    const s = objectsByKey.get(key) ?? null;
    const skip = skippedByKey.get(key) ?? null;
    const ls = ledgerByKey.get(key) ?? [];
    if (s && inKeyScope(input.scope, key, sourceMasterOf(s))) {
      const primary = ls.find((l) => l.calendar_id === s.calendar_id) ?? null;
      const t = input.target.collections.get(s.calendar_id)?.objects.get(s.href) ?? null;
      push(
        { legacy_key: key, kind: s.kind, calendar_id: s.calendar_id, collection_name: s.collection_name, href: s.href, source: s, ledger: primary },
        decideSource(state, s, primary),
        t,
      );
      // Riga 15: la stessa chiave viva in un'altra collezione (spostamento) → delete lì, dopo la create.
      for (const l of ls) {
        if (l === primary || !ledgerInScope(input.scope, l)) continue;
        const t2 = input.target.collections.get(l.calendar_id)?.objects.get(l.href) ?? null;
        push({ legacy_key: key, kind: l.kind, calendar_id: l.calendar_id, collection_name: l.collection_name, href: l.href, source: null, ledger: l }, decideGone(state, l, null), t2);
      }
      continue;
    }
    if (s) continue; // oggetto fuori dall'ambito delle chiavi (letto solo per contesto, es. altre festività)
    const relevant = ls.filter((l) => ledgerInScope(input.scope, l));
    if (skip && inKeyScope(input.scope, key, sourceMasterOf(skip)) && relevant.length === 0 && ls.length === 0) {
      // Riga 16: salto senza righe vive.
      push(
        { legacy_key: key, kind: skip.kind, calendar_id: skip.calendar_id, collection_name: skip.collection_name ?? '', href: '', source: null, ledger: null },
        decision('skip', { code: skip.code }),
        null,
      );
      continue;
    }
    for (const l of relevant) {
      const t = input.target.collections.get(l.calendar_id)?.objects.get(l.href) ?? null;
      push({ legacy_key: key, kind: l.kind, calendar_id: l.calendar_id, collection_name: l.collection_name, href: l.href, source: null, ledger: l }, decideGone(state, l, skip?.code ?? null), t);
    }
  }

  const forced = items.map((item) => {
    const out = applyForce(state, item);
    if (out !== item) {
      const pending = state.pending.get(item);
      if (pending) state.pending.set(out, pending);
    }
    return out;
  });
  return forced.sort((a, b) =>
    a.collection_name.localeCompare(b.collection_name)
    || ACTION_ORDER[a.action] - ACTION_ORDER[b.action]
    || a.href.localeCompare(b.href)
    || a.legacy_key.localeCompare(b.legacy_key)
    || a.calendar_id.localeCompare(b.calendar_id));
}

// ─── Lettura della destinazione ───────────────────────────────

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MigrationError('CANCELLED', 'Lettura di Radicale interrotta');
}

function targetFromData(calendarId: string, collectionName: string, name: string, etag: string | null, data: string | null): TargetObject {
  let uid: string | null = null;
  let fingerprint: string | null = null;
  if (data !== null) {
    const parsed = parseCalendarObject(data);
    if (parsed.ok) {
      uid = parsed.value.uid;
      fingerprint = semanticFingerprint(parsed.value);
    }
  }
  return { calendar_id: calendarId, collection_name: collectionName, href: name, etag, uid, fingerprint, raw: data };
}

async function multigetInto(
  client: RadicaleClient,
  principal: string,
  collection: { calendar_id: string; collection_name: string },
  names: readonly string[],
  objects: Map<string, TargetObject>,
  signal?: AbortSignal,
): Promise<void> {
  const path = collectionPath(principal, collection.collection_name);
  for (let i = 0; i < names.length; i += INDEX_LIMITS.multigetBatch) {
    throwIfAborted(signal);
    const batch = names.slice(i, i + INDEX_LIMITS.multigetBatch);
    const got = await client.calendarMultiget(path, batch.map((n) => objectPath(principal, collection.collection_name, n)));
    for (const obj of got.objects) {
      if (!obj.name || !isValidObjectName(obj.name)) continue;
      objects.set(obj.name, targetFromData(collection.calendar_id, collection.collection_name, obj.name, obj.etag ?? objects.get(obj.name)?.etag ?? null, obj.data));
    }
    for (const missing of got.missing) {
      const name = (() => {
        const last = missing.split('/').filter(Boolean).pop() ?? '';
        try {
          return decodeURIComponent(last);
        } catch {
          return last;
        }
      })();
      objects.delete(name); // sparito fra PROPFIND e multiget (o mai esistito)
    }
  }
}

/** PROPFIND getetag (Depth:1) per collezione; multiget solo degli href per cui needContent è vero. */
export async function readTargetSnapshot(
  client: RadicaleClient,
  principal: string,
  collections: ReadonlyArray<{ calendar_id: string; collection_name: string }>,
  opts: {
    needContent: (calendarId: string, href: string, etag: string | null) => boolean;
    signal?: AbortSignal;
    /**
     * Facoltativo (shadow): legge solo questi href per collezione, con un
     * multiget, senza PROPFIND della collezione. Un href assente risulta
     * assente; una collezione che non esiste risulta `exists: false`.
     */
    only?: ReadonlyMap<string, ReadonlySet<string>>;
  },
): Promise<TargetSnapshot> {
  const out = new Map<string, TargetCollection>();
  const seen = new Set<string>();
  for (const c of collections) {
    if (seen.has(c.calendar_id)) continue;
    seen.add(c.calendar_id);
    throwIfAborted(opts.signal);
    const objects = new Map<string, TargetObject>();
    const only = opts.only?.get(c.calendar_id);
    const path = collectionPath(principal, c.collection_name);
    const self = decodeURIComponent(path).replace(/\/+$/, '');
    /** Dead prop calendar-id della collezione (risposta della collezione stessa) → null se è del calendario. */
    const foreignOf = (ms: Multistatus): string | null => {
      const entry = ms.responses.find((r) => r.path.replace(/\/+$/, '') === self);
      const found = entry?.text(DAV_PROPS.calendarId)?.trim() ?? '';
      return found.toLowerCase() === c.calendar_id.toLowerCase() ? null : found;
    };
    if (opts.only) {
      const names = [...(only ?? [])].filter((n) => isValidObjectName(n)).sort();
      let foreign: string | null;
      try {
        // Esistenza e calendar-id della collezione (anche con gli href da leggere: una collezione estranea non si tocca).
        foreign = foreignOf(await client.propfind(path, { props: [DAV_PROPS.resourcetype, DAV_PROPS.calendarId], depth: 0 }));
        if (names.length && foreign === null) await multigetInto(client, principal, c, names, objects, opts.signal);
      } catch (err) {
        if (isRadicaleError(err, 'not_found')) {
          out.set(c.calendar_id, { calendar_id: c.calendar_id, collection_name: c.collection_name, exists: false, objects: new Map() });
          continue;
        }
        throw err;
      }
      out.set(c.calendar_id, { calendar_id: c.calendar_id, collection_name: c.collection_name, exists: true, objects, foreign });
      continue;
    }

    let ms: Multistatus;
    try {
      ms = await client.propfind(path, { props: [DAV_PROPS.getetag, DAV_PROPS.resourcetype, DAV_PROPS.calendarId], depth: 1 });
    } catch (err) {
      if (isRadicaleError(err, 'not_found')) {
        out.set(c.calendar_id, { calendar_id: c.calendar_id, collection_name: c.collection_name, exists: false, objects: new Map() });
        continue;
      }
      throw err;
    }
    const foreign = foreignOf(ms);
    for (const entry of ms.responses) {
      if (entry.path.replace(/\/+$/, '') === self) continue;
      if (entry.status !== null && entry.status !== 200) continue;
      const type = entry.element(DAV_PROPS.resourcetype);
      if (type && type.children.length > 0) continue; // sotto-collezioni (non previste)
      const name = entry.name;
      if (!name || !isValidObjectName(name)) continue;
      objects.set(name, targetFromData(c.calendar_id, c.collection_name, name, entry.text(DAV_PROPS.getetag), null));
    }
    const toRead = [...objects.values()].filter((t) => opts.needContent(c.calendar_id, t.href, t.etag)).map((t) => t.href).sort();
    await multigetInto(client, principal, c, toRead, objects, opts.signal);
    out.set(c.calendar_id, { calendar_id: c.calendar_id, collection_name: c.collection_name, exists: true, objects, foreign });
  }
  return { read_at: new Date(), collections: out };
}

// ─── Piano completo ───────────────────────────────

interface PlanBuild {
  items: PlanItem[];
  serialization: SerializationResult;
  hash: string;
  target: TargetSnapshot;
  source: LegacySource;
  /** Calendari inclusi dell'ambito (cancellazioni). */
  calendarIds: ReadonlySet<string>;
  /** Ambito effettivo (effectivePlanScope); vuoto per lo shadow per chiavi. */
  scope: MigrationScope;
}

type BuildPlanOptions = {
  db: Db;
  client: RadicaleClient;
  principal: string;
  mode: PlanMode;
  scope: MigrationScope;
  options: MigrationOptions;
  legacyKeys?: readonly LegacyKey[];
  force?: PlanInput['force'];
  now: Date;
  signal?: AbortSignal;
};

/**
 * Ambito effettivo di un piano limitato ad alcuni calendari. Gli spostamenti
 * della decisione 8 legano il calendario Prenotazioni alle loro destinazioni
 * (quella scelta adesso e quelle di spostamenti già scritti, dal ledger): un
 * ambito che ne contiene uno li comprende tutti, altrimenti un evento spostato
 * risulterebbe "sparito" da una parte (delete) senza essere creato dall'altra.
 * Senza calendar_ids l'ambito è già completo. Sola lettura.
 */
export async function effectivePlanScope(db: Db, scope: MigrationScope, options: MigrationOptions): Promise<MigrationScope> {
  const requested = normalizeScope(scope);
  if (!requested.calendar_ids?.length) return requested;
  const calendars = await loadMigrationCalendars(db);
  const bookingIds = calendars.filter((c) => c.included && c.role === 'bookings').map((c) => c.id);
  if (bookingIds.length === 0) return requested;
  const linked = new Set<string>(bookingIds);
  const target = resolveMoveTarget(calendars, options);
  if (target && options.bookings_move_event_ids.length > 0) linked.add(target.id);
  const past = await db<Array<{ id: string }>>`
    SELECT DISTINCT l.calendar_id::text AS id
    FROM cal_migration_ledger l
    JOIN calendar_events e
      ON e.id::text = CASE WHEN l.kind = 'event' THEN substr(l.legacy_key, 7)
                           WHEN l.kind = 'detached' THEN l.legacy_snapshot->>'master_id' END
    WHERE l.deleted_at IS NULL AND l.kind IN ('event', 'detached')
      AND e.calendar_id = ANY(${bookingIds}::uuid[]) AND l.calendar_id <> e.calendar_id
  `;
  for (const r of past) linked.add(String(r.id).toLowerCase());
  const ids = new Set(requested.calendar_ids);
  if (![...linked].some((id) => ids.has(id))) return requested;
  for (const id of linked) ids.add(id);
  return { calendar_ids: [...ids].sort() };
}

async function buildPlanStages(opts: BuildPlanOptions, onPhase?: (phase: 'read-target' | 'compute') => Promise<void>): Promise<PlanBuild> {
  const keyMode = opts.legacyKeys !== undefined;
  const scopeIn = keyMode ? undefined : await effectivePlanScope(opts.db, opts.scope, opts.options);
  const source = await loadLegacySource(opts.db, { scope: scopeIn, legacyKeys: opts.legacyKeys, now: opts.now });
  throwIfAborted(opts.signal);
  const serialization = serializeLegacy(source, opts.options, { now: opts.now });
  const calendarIds = new Set(source.calendars.filter((c) => c.included).map((c) => c.id));
  const legacyKeys = keyMode ? new Set<LegacyKey>(opts.legacyKeys) : null;
  const scope: PlanInput['scope'] = { calendarIds, legacyKeys };
  const ledger = source.ledger.filter((l) => l.deleted_at === null);

  // Collezioni da leggere: quelle degli oggetti voluti e delle righe vive dell'ambito.
  const collections = new Map<string, string>();
  const calById = new Map(source.calendars.map((c) => [c.id, c]));
  if (!keyMode) {
    for (const c of source.calendars) if (c.included && c.collection_name) collections.set(c.id, c.collection_name);
  }
  const sByCalHref = new Map<string, SerializedObject>();
  const only = new Map<string, Set<string>>();
  const want = (calendarId: string, collection: string, href: string): void => {
    if (!collections.has(calendarId)) collections.set(calendarId, collection);
    const set = only.get(calendarId) ?? new Set<string>();
    if (href) set.add(href);
    only.set(calendarId, set);
  };
  for (const s of serialization.objects) {
    if (legacyKeys && !inKeyScope(scope, s.legacy_key, sourceMasterOf(s))) continue;
    sByCalHref.set(`${s.calendar_id}|${s.href}`, s);
    want(s.calendar_id, s.collection_name, s.href);
  }
  for (const l of ledger) {
    if (!ledgerInScope(scope, l)) continue;
    const name = calById.get(l.calendar_id)?.collection_name || l.collection_name;
    want(l.calendar_id, name, l.href);
  }
  for (const s of serialization.skipped) {
    if (legacyKeys && inKeyScope(scope, s.legacy_key, sourceMasterOf(s)) && s.collection_name) want(s.calendar_id, s.collection_name, '');
  }

  const ledgerByCalHref = new Map(ledger.map((l) => [`${l.calendar_id}|${l.href}`, l]));
  const needContent = (calendarId: string, href: string, etag: string | null): boolean => {
    const l = ledgerByCalHref.get(`${calendarId}|${href}`);
    if (!l) return true; // non tracciato: UID e fingerprint per l'adozione (righe 4 e 5)
    if (l.intent_op) return true; // riga 1
    if (etag === null || etag !== l.written_etag) return true; // riga 8
    const s = sByCalHref.get(`${calendarId}|${href}`);
    if (!s || s.legacy_hash === l.legacy_hash) return false;
    return opts.mode === 'shadow' || l.adopted || l.derived; // patch per campo sull'oggetto corrente
  };

  await onPhase?.('read-target');
  const target = await readTargetSnapshot(
    opts.client,
    opts.principal,
    [...collections.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([calendar_id, collection_name]) => ({ calendar_id, collection_name })),
    { needContent, signal: opts.signal, only: keyMode ? only : undefined },
  );
  throwIfAborted(opts.signal);
  await onPhase?.('compute');
  const items = computePlan({
    mode: opts.mode,
    serialization,
    ledger,
    target,
    scope,
    force: opts.force ?? { itemKeys: new Set(), codes: new Set() },
  });
  return { items, serialization, hash: planHash(items), target, source, calendarIds, scope: scopeIn ?? {} };
}

/** Sorgente, ledger e destinazione letti, piano calcolato: usata da runPlan, runApply e dallo shadow. */
export async function buildPlan(opts: { db: Db; client: RadicaleClient; principal: string; mode: PlanMode; scope: MigrationScope; options: MigrationOptions; legacyKeys?: readonly LegacyKey[]; force?: PlanInput['force']; now: Date; signal?: AbortSignal }):
  Promise<{ items: PlanItem[]; serialization: SerializationResult; hash: string; target: TargetSnapshot }> {
  const built = await buildPlanStages(opts);
  return { items: built.items, serialization: built.serialization, hash: built.hash, target: built.target };
}

// ─── Riassunto e anteprima leggibile ───────────────────────────────

/** Conteggi di un piano (puri): totali per azione, scritture, conflitti, salti e per calendario. */
export function planCounts(items: readonly PlanItem[]): Pick<PlanSummary, 'totals' | 'writes' | 'conflicts' | 'skips' | 'calendars'> {
  const totals = emptyActionCounts();
  const conflicts: PlanSummary['conflicts'] = {};
  const skips: PlanSummary['skips'] = {};
  const byCalendar = new Map<string, PlanCalendarCounts>();
  for (const item of items) {
    totals[item.action] += 1;
    if (item.action === 'conflict' && item.code && CONFLICT_CODE_SET.has(item.code)) {
      const c = item.code as ConflictCode;
      conflicts[c] = (conflicts[c] ?? 0) + 1;
    }
    if (item.action === 'skip' && item.code) {
      const c = item.code as SkipCode;
      skips[c] = (skips[c] ?? 0) + 1;
    }
    const cal = byCalendar.get(item.calendar_id) ?? { calendar_id: item.calendar_id, collection_name: item.collection_name, counts: emptyActionCounts() };
    if (!cal.collection_name && item.collection_name) cal.collection_name = item.collection_name;
    cal.counts[item.action] += 1;
    byCalendar.set(item.calendar_id, cal);
  }
  return {
    totals,
    writes: totals.create + totals.update + totals.delete,
    conflicts,
    skips,
    calendars: [...byCalendar.values()].sort((a, b) => a.collection_name.localeCompare(b.collection_name) || a.calendar_id.localeCompare(b.calendar_id)),
  };
}

export interface PlanPreviewExample {
  legacy_key: string;
  href: string;
  /** Titolo dell'evento (null per le proiezioni delle prenotazioni). */
  summary: string | null;
  code: string | null;
}

export interface PlanPreviewCalendar {
  calendar_id: string;
  slug: string;
  name: string;
  collection_name: string | null;
  role: string;
  included: boolean;
  excluded_reason: string | null;
  /** Oggetti che il serializer vuole nella collezione. */
  objects: number;
  counts: Record<PlanAction, number>;
  /** Al più 5 esempi per azione. */
  examples: Partial<Record<PlanAction, PlanPreviewExample[]>>;
  anomalies: Partial<Record<AnomalyCode, number>>;
}

export interface PlanPreviewAnomaly {
  code: AnomalyCode;
  severity: ItemSeverity;
  blocking: boolean;
  option: keyof MigrationOptions | null;
  description: string;
  count: number;
  /** Al più 5 esempi, senza dati personali. */
  examples: Array<{ calendar_id: string | null; legacy_key: string | null; detail: Record<string, unknown> }>;
}

export interface PlanPreviewOption {
  key: keyof MigrationOptions;
  value: unknown;
  default: unknown;
  label: string;
  /** Oggetti o anomalie interessati dall'opzione. */
  affected: number;
}

/** Anteprima leggibile per il wizard (design §13.4), salvata in PlanSummary.preview. */
export interface PlanPreview {
  calendars: PlanPreviewCalendar[];
  anomalies: PlanPreviewAnomaly[];
  options: PlanPreviewOption[];
  /** Anomalie bloccanti presenti (l'apply le rifiuta finché non sono risolte in PG). */
  blocking: AnomalyCode[];
  /** Eventi non di prenotazione nel calendario Prenotazioni, spostabili uno per uno (decisione 8). */
  bookings_move_candidates: Array<{ event_id: string; summary: string | null; moved: boolean; target_calendar_id: string | null }>;
  /**
   * Iscrizioni ICS (decisione 5): mai copiate dal piano (le righe ics_pull non
   * entrano nel serializer, i sidecar sono esclusi). Per ognuna i flag attuali
   * e l'impatto di "blocca disponibilità" sulle prossime settimane, da
   * mostrare prima di attivarli (PATCH /subscriptions/:id, gruppo SHADOW).
   */
  subscriptions: SubscriptionImpact[];
  /** Default della decisione 5: nascosta ai device e non bloccante. */
  subscription_defaults: { blocks_availability: false; device_visible: false };
  /** Regole fisse del design §13.4 mostrate accanto alle opzioni (non modificabili dall'anteprima). */
  fixed_rules: Array<{ key: 'cancelled_masters' | 'subscriptions_not_copied'; label: string; affected: number }>;
}

const OPTION_LABELS: Readonly<Record<keyof MigrationOptions, string>> = Object.freeze({
  fix_until_admin_pattern: 'Correggi UNTIL "fino al" delle serie create dall\'admin (fine della giornata di Roma)',
  realign_dst_exceptions: 'Riallinea le eccezioni salvate prima della correzione dell\'ora legale',
  orphans: 'Override orfani: convertiti in eventi singoli (convert) o scartati (discard)',
  bookings_move_event_ids: 'Eventi non di prenotazione del calendario Prenotazioni da spostare (decisione 8)',
  bookings_move_target_calendar_id: 'Calendario di destinazione degli spostamenti (vuoto = calendario di default)',
});

const EXAMPLES_PER_GROUP = 5;

/** Anteprima leggibile: per calendario conteggi ed esempi, anomalie con descrizione ed esempi, opzioni con l'effetto. */
export function buildPlanPreview(
  items: readonly PlanItem[],
  serialization: SerializationResult,
  calendars: readonly MigrationCalendar[],
  options: MigrationOptions,
  subscriptions: readonly SubscriptionImpact[] = [],
): PlanPreview {
  const cals = new Map<string, PlanPreviewCalendar>();
  const ensure = (id: string, collectionName: string | null): PlanPreviewCalendar => {
    let entry = cals.get(id);
    if (!entry) {
      const cal = calendars.find((c) => c.id === id);
      entry = {
        calendar_id: id,
        slug: cal?.slug ?? '',
        name: cal?.name ?? '',
        collection_name: cal?.collection_name ?? collectionName,
        role: cal?.role ?? 'user',
        included: cal?.included ?? false,
        excluded_reason: cal?.excluded_reason ?? null,
        objects: 0,
        counts: emptyActionCounts(),
        examples: {},
        anomalies: {},
      };
      cals.set(id, entry);
    }
    return entry;
  };
  for (const cal of calendars) ensure(cal.id, cal.collection_name);
  for (const obj of serialization.objects) ensure(obj.calendar_id, obj.collection_name).objects += 1;
  for (const item of items) {
    const entry = ensure(item.calendar_id, item.collection_name || null);
    entry.counts[item.action] += 1;
    const list = entry.examples[item.action] ?? [];
    if (list.length < EXAMPLES_PER_GROUP) {
      list.push({
        legacy_key: item.legacy_key,
        href: item.href,
        summary: objectItemDetail(item).summary,
        code: item.code,
      });
      entry.examples[item.action] = list;
    }
  }

  const byCode = new Map<AnomalyCode, AnomalyRecord[]>();
  for (const a of serialization.anomalies) {
    const list = byCode.get(a.code) ?? [];
    list.push(a);
    byCode.set(a.code, list);
    if (a.calendar_id) {
      const entry = ensure(a.calendar_id, null);
      entry.anomalies[a.code] = (entry.anomalies[a.code] ?? 0) + 1;
    }
  }
  const anomalies: PlanPreviewAnomaly[] = [...byCode.entries()]
    .map(([code, list]) => ({
      code,
      severity: ANOMALY_DEFINITIONS[code].severity,
      blocking: ANOMALY_DEFINITIONS[code].blocking,
      option: ANOMALY_DEFINITIONS[code].option,
      description: ANOMALY_DEFINITIONS[code].description,
      count: list.length,
      examples: list.slice(0, EXAMPLES_PER_GROUP).map((a) => ({ calendar_id: a.calendar_id, legacy_key: a.legacy_key, detail: a.detail })),
    }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.code.localeCompare(b.code));

  const count = (code: AnomalyCode): number => byCode.get(code)?.length ?? 0;
  const moveCandidates = (byCode.get('NON_PROJECTION_IN_BOOKINGS') ?? []).map((a) => ({
    event_id: String(a.detail.event_id ?? ''),
    summary: typeof a.detail.summary === 'string' ? a.detail.summary : null,
    moved: a.detail.moved === true,
    target_calendar_id: typeof a.detail.target_calendar_id === 'string' ? a.detail.target_calendar_id : null,
  }));
  const moved = moveCandidates.filter((c) => c.moved).length;
  const optionEntries: PlanPreviewOption[] = (Object.keys(OPTION_LABELS) as Array<keyof MigrationOptions>).map((key) => ({
    key,
    value: options[key],
    default: DEFAULT_MIGRATION_OPTIONS[key],
    label: OPTION_LABELS[key],
    affected: key === 'fix_until_admin_pattern' ? count('UNTIL_ADMIN_PATTERN')
      : key === 'realign_dst_exceptions' ? count('DST_SHIFTED_EXCEPTION')
        : key === 'orphans' ? count('ORPHAN_OVERRIDE_NOT_IN_RULE')
          : moved,
  }));

  return {
    calendars: [...cals.values()].sort((a, b) => (a.collection_name ?? a.slug).localeCompare(b.collection_name ?? b.slug) || a.calendar_id.localeCompare(b.calendar_id)),
    anomalies,
    options: optionEntries,
    blocking: anomalies.filter((a) => a.blocking).map((a) => a.code),
    bookings_move_candidates: moveCandidates,
    subscriptions: [...subscriptions],
    subscription_defaults: { blocks_availability: false, device_visible: false },
    fixed_rules: [
      { key: 'cancelled_masters', label: 'Master cancellati: non migrati (quelli già scritti si tolgono dalla destinazione)', affected: count('CANCELLED_MASTER') },
      { key: 'subscriptions_not_copied', label: 'Iscrizioni ICS: mai copiate nel volume, flag per singola iscrizione (nascosta e non bloccante di default)', affected: subscriptions.length },
    ],
  };
}

// ─── Righe del run ───────────────────────────────

function severityOf(item: PlanItem): 'info' | 'warning' | 'error' {
  if (item.action === 'conflict') return item.code === 'COLLECTION_MISSING' ? 'error' : 'warning';
  if (item.action === 'skip' && item.code === 'INVALID_OBJECT') return 'error';
  return 'info';
}

/** Dettaglio di una riga 'object' (ObjectItemDetail): mai dati personali (niente titoli delle proiezioni). */
export function objectItemDetail(item: PlanItem): ObjectItemDetail {
  const s = item.source;
  const l = item.ledger;
  const t = item.target;
  return {
    kind: item.kind,
    uid: s?.uid ?? l?.uid ?? null,
    summary: item.kind === 'booking' ? null : s?.summary ?? (l?.legacy_snapshot?.kind === 'event' ? l.legacy_snapshot.master.summary : l?.legacy_snapshot?.kind === 'detached' ? l.legacy_snapshot.override.summary : null),
    legacy_event_id: s?.legacy_event_id ?? l?.legacy_event_id ?? null,
    legacy_hash: s?.legacy_hash ?? null,
    previous_legacy_hash: l?.legacy_hash ?? null,
    planned_fingerprint: s?.fingerprint ?? null,
    target_etag: t?.etag ?? null,
    target_fingerprint: t?.fingerprint ?? null,
    written_etag: l?.written_etag ?? null,
    patch: item.patch,
    other_href: item.other_href,
    fields: item.fields,
    anomalies: s?.anomalies ?? [],
  };
}

/** Riga 'object' del run d'anteprima (o dell'apply, senza esito). */
export function planItemRow(item: PlanItem): MigrationItemInput {
  return {
    item_type: 'object',
    calendar_id: item.calendar_id,
    collection_name: item.collection_name || null,
    href: item.href || null,
    legacy_key: item.legacy_key,
    action: item.action,
    code: item.code,
    severity: severityOf(item),
    detail: objectItemDetail(item) as unknown as Record<string, unknown>,
  };
}

/** Riga 'anomaly' del run. */
export function anomalyRow(a: AnomalyRecord): MigrationItemInput {
  return {
    item_type: 'anomaly',
    calendar_id: a.calendar_id,
    legacy_key: a.legacy_key,
    code: a.code,
    severity: a.severity,
    detail: a.detail,
  };
}

/** Ambito normalizzato: id UUID minuscoli, senza duplicati; vuoto = tutti i calendari inclusi. */
function normalizeScope(scope: MigrationScope | null | undefined): MigrationScope {
  const ids = (scope?.calendar_ids ?? [])
    .filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    .map((id) => id.toLowerCase());
  return ids.length ? { calendar_ids: [...new Set(ids)].sort() } : {};
}

const ITEMS_CHUNK = 500;

/** Run d'anteprima: righe 'object' (una per item, ObjectItemDetail) e 'anomaly', PlanSummary con plan_hash. */
export async function runPlan(ctx: MigrationRunContext<PlanParams>): Promise<PlanSummary & { preview: PlanPreview }> {
  const options = resolveMigrationOptions(ctx.params?.options ?? null);
  const scope = normalizeScope(ctx.params?.scope);
  const rt = radicaleRuntime();
  if (!rt.client) throw new MigrationError('RADICALE_NOT_CONFIGURED', 'Radicale non configurato: anteprima non disponibile');
  const now = new Date();
  await ctx.progress({ phase: 'read-legacy', message: 'Lettura dei calendari legacy' });
  ctx.throwIfCancelled();
  const built = await buildPlanStages(
    { db: ctx.db, client: rt.client, principal: rt.principal, mode: 'apply', scope, options, now, signal: ctx.signal },
    async (phase) => {
      ctx.throwIfCancelled();
      await ctx.progress(phase === 'read-target'
        ? { phase, message: 'Lettura delle collezioni di Radicale' }
        : { phase, message: 'Calcolo del piano' });
    },
  );
  ctx.throwIfCancelled();

  const rows: MigrationItemInput[] = [
    ...built.serialization.anomalies.map(anomalyRow),
    ...built.items.map(planItemRow),
  ];
  await ctx.progress({ phase: 'write-items', done: 0, total: rows.length, message: 'Salvataggio dell\'anteprima' });
  for (let i = 0; i < rows.length; i += ITEMS_CHUNK) {
    ctx.throwIfCancelled();
    await ctx.addItems(rows.slice(i, i + ITEMS_CHUNK));
    await ctx.progress({ phase: 'write-items', done: Math.min(rows.length, i + ITEMS_CHUNK), total: rows.length, message: 'Salvataggio dell\'anteprima' });
  }

  const counts = planCounts(built.items);
  // Calendari inclusi dell'ambito anche senza item: il wizard li mostra tutti.
  const calendars = [...counts.calendars];
  for (const cal of built.source.calendars) {
    if (cal.included && cal.collection_name && !calendars.some((c) => c.calendar_id === cal.id)) {
      calendars.push({ calendar_id: cal.id, collection_name: cal.collection_name, counts: emptyActionCounts() });
    }
  }
  calendars.sort((a, b) => a.collection_name.localeCompare(b.collection_name) || a.calendar_id.localeCompare(b.calendar_id));
  const anomalies: PlanSummary['anomalies'] = {};
  for (const a of built.serialization.anomalies) anomalies[a.code] = (anomalies[a.code] ?? 0) + 1;
  const revalidation = built.source.ledger.filter((l) => l.deleted_at === null && l.revalidate_reason !== null && built.calendarIds.has(l.calendar_id)).length;

  // Iscrizioni dei calendari dell'ambito con l'impatto dei flag (informativo: un errore non ferma l'anteprima).
  let subscriptions: SubscriptionImpact[] = [];
  try {
    const partial = Boolean(built.scope.calendar_ids?.length);
    subscriptions = (await computeSubscriptionImpacts(ctx.db, { now }))
      .filter((s) => !partial || built.calendarIds.has(s.target_calendar_id));
  } catch (err) {
    ctx.log.warn({ err }, 'impatto delle iscrizioni non calcolato: anteprima senza iscrizioni');
  }

  return {
    generated_at: now.toISOString(),
    plan_hash: built.hash,
    serializer_version: built.serialization.serializer_version,
    options,
    // Ambito effettivo (con i calendari legati dagli spostamenti della decisione 8).
    scope: built.scope,
    totals: counts.totals,
    writes: counts.writes,
    conflicts: counts.conflicts,
    skips: counts.skips,
    calendars,
    anomalies,
    revalidation_pending: revalidation,
    estimate_seconds: Math.ceil(counts.writes / MIGRATION_LIMITS.maxPutsPerSecond) + 1,
    preview: buildPlanPreview(built.items, built.serialization, built.source.calendars, options, subscriptions),
  };
}
