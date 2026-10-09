/**
 * Riallineamento delle eccezioni delle serie salvate prima del fix DST
 * (commit d046006, deploy della migrazione 158). Fase F0 del passaggio del
 * calendario a Radicale: docs/calendar-radicale/piano.md (F0, attività 2),
 * design.md §13.4 (anomalia DST_SHIFTED_EXCEPTION) e §14.
 *
 * Il difetto. Prima di d046006 expandRRule ripeteva l'ora UTC del DTSTART:
 * una serie creata a settembre alle 09:00 di Roma (07:00Z, ora legale) a
 * novembre cadeva alle 07:00Z, cioè alle 08:00 di Roma. Le eccezioni create
 * allora (override con recurrence_id, cancellati o modificati, ed elementi di
 * exdates del master) hanno salvato quell'istante. Oggi l'espansione è in ora
 * locale e l'occorrenza di novembre cade alle 08:00Z: l'eccezione non combacia
 * più, l'occorrenza eliminata "risorge" e l'override modificato si duplica
 * (orfano più occorrenza della serie). Vale anche al contrario: serie creata
 * d'inverno, eccezione estiva salvata un'ora dopo.
 *
 * Criterio (lo stesso della query 19b di scripts/sql/calendar-inventory.sql,
 * più le verifiche sulla griglia reale):
 *  1. master con RRULE, timed e all-day; eccezioni = recurrence_id dei suoi
 *     override più gli elementi di exdates. Un all-day salvato a mezzanotte di
 *     Roma ha lo stesso difetto (la vecchia griglia ripeteva le 22:00Z o le
 *     23:00Z del DTSTART, la nuova cade sempre a mezzanotte di Roma) e la
 *     stessa correzione; i casi che non tornano finiscono fra le saltate;
 *  2. un'eccezione che è già un'occorrenza dell'espansione attuale è allineata
 *     e non viene mai toccata (comprese tutte quelle create dopo il fix);
 *  3. firma DST: stessa ora UTC del DTSTART ma ora locale di Roma diversa (cioè
 *     offset di Roma diverso fra DTSTART ed eccezione). Senza firma l'eccezione è
 *     fuori griglia per altri motivi (serie spostata, orfani): contata, non toccata;
 *  4. valore corretto = eccezione + (offset del DTSTART − offset dell'eccezione),
 *     cioè l'ora locale del DTSTART nello stesso giorno della vecchia griglia;
 *     si usa solo se è davvero un'occorrenza dell'espansione attuale;
 *  5. saltate e segnalate, mai modificate: serie in calendari con fuso diverso
 *     da Europe/Rome, serie importate da iscrizioni ICS (sola lettura, riscritte
 *     dal sync), valori non verificabili o non validi, override che andrebbero
 *     sulla stessa occorrenza di un altro override.
 * La griglia è quella di expandRRule (src/lib/calendar/rrule.ts) con il fuso di
 * listOccurrences, che non lo passa (default Europe/Rome): "allineata" significa
 * esattamente "combacia in listOccurrences", nel feed e negli slot.
 *
 * Cosa cambia: solo recurrence_id degli override ed elementi di exdates (un
 * elemento il cui valore corretto è già presente viene rimosso). start_time ed
 * end_time degli override restano quelli salvati: se un override modificato è
 * rimasto all'ora della vecchia griglia il report lo segnala nelle note.
 *
 * Uso (da apps/api; senza .env serve DATABASE_URL nell'ambiente):
 *   pnpm calendar:fix-dst                                   dry-run: report, nessuna scrittura
 *   pnpm calendar:fix-dst -- --calendar lavoro              solo i calendari indicati (ripetibile)
 *   pnpm calendar:fix-dst -- --json                         report JSON su stdout
 *   pnpm calendar:fix-dst -- --out dst-report.json          salva anche il report JSON
 *   pnpm calendar:fix-dst -- --apply --expect-plan <hash>   applica in una transazione
 *
 * --apply ricalcola il piano dentro la transazione con le righe bloccate (FOR
 * UPDATE), aggiorna le righe e scrive in audit_logs una riga per ogni riga
 * modificata: action 'UPDATE' (il CHECK audit_logs_action_check ammette solo
 * INSERT/UPDATE/DELETE/EXPORT/IMPORT), request_id = run_id, motivo e valori
 * nei metadata. Il trigger audit_calendar_events aggiunge la sua riga con la
 * riga completa. Con --expect-plan (l'impronta stampata dal dry-run) si rifiuta
 * senza modifiche, exit 3, se il piano è cambiato nel frattempo. Dalla CLI
 * --expect-plan è obbligatorio con --apply: si applica solo un piano visto nel
 * dry-run (con lo stesso filtro --calendar). Idempotente: dopo l'apply le
 * eccezioni sono allineate e un nuovo run non trova nulla.
 *
 * Il report JSON di --out contiene titoli e uid delle serie: viene scritto con
 * permessi 0600, come quello dell'inventario.
 *
 * In produzione l'immagine dell'API contiene già scripts/ (il Dockerfile copia
 * apps/api/scripts): dopo il deploy di questi commit si esegue nel container,
 * da /app/apps/api, `pnpm exec tsx scripts/fix-dst-exceptions.ts` (dry-run) e
 * poi lo stesso comando con --apply --expect-plan <impronta>. Solo con
 * un'immagine precedente a questi commit va copiato il file (docker cp
 * apps/api/scripts/fix-dst-exceptions.ts <api>:/app/apps/api/scripts/);
 * altrimenti si sovrascriverebbe la versione dell'immagine con quella del
 * proprio checkout. In alternativa, da un checkout con DATABASE_URL verso il
 * database.
 *
 * Exit code: 0 ok, 1 errore, 2 uso errato (anche --apply senza --expect-plan),
 * 3 piano diverso da --expect-plan.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatInTimeZone, getTimezoneOffset } from 'date-fns-tz';
import type postgres from 'postgres';
import { jsonb, sql } from '../src/db';
import { expandRRule, validateRRule } from '../src/lib/calendar/rrule';

/** Fuso della griglia: listOccurrences chiama expandRRule senza timezone (default Europe/Rome). */
export const EXPANSION_TZ = 'Europe/Rome';

/** Nome dello script nei metadata di audit_logs e nel report. */
export const SCRIPT_NAME = 'fix-dst-exceptions';

/** Codice dell'anomalia (design §13.4), usato come motivo delle correzioni. */
export const DST_REASON = 'DST_SHIFTED_EXCEPTION';

const AUDIT_ACTOR = 'system@fix-dst-exceptions';
const AUDIT_AGENT = 'scripts/fix-dst-exceptions.ts';

// ─── Tipi ───────────────────────────────

export type ExceptionKind = 'override' | 'exdate';

/** realign: nuovo valore; drop-duplicate: elemento di exdates il cui valore corretto è già presente. */
export type FixAction = 'realign' | 'drop-duplicate';

export type SkipReason =
  | 'NON_ROME_CALENDAR'
  | 'ICS_PULL_READ_ONLY'
  | 'NO_MATCHING_OCCURRENCE'
  | 'OVERRIDE_CONFLICT'
  | 'INVALID_VALUE';

/** legale→solare: DTSTART in ora legale, eccezione in ora solare (e viceversa). */
export type Direction = 'legale→solare' | 'solare→legale';

/** Master ricorrente come lo legge lo script (calendar_events + calendars). */
export interface MasterRow {
  id: string;
  uid: string;
  summary: string;
  calendar_slug: string;
  calendar_timezone: string;
  start_time: Date | string;
  rrule: string;
  exdates: unknown;
  source: string;
  status: string;
}

/** Override di un master (riga con recurrence_master_id). */
export interface OverrideRow {
  id: string;
  recurrence_master_id: string;
  recurrence_id: Date | string;
  start_time: Date | string;
  status: string;
}

interface ItemBase {
  kind: ExceptionKind;
  /** Riga da aggiornare: l'override, oppure il master per gli exdates. */
  event_id: string;
  master_id: string;
  master_uid: string;
  summary: string;
  calendar_slug: string;
  calendar_timezone: string;
  master_status: string;
  /** DTSTART del master (UTC) e la sua ora a Roma. */
  master_start: string;
  master_start_rome: string;
  /** Posizione nell'array exdates (null per gli override). */
  exdate_index: number | null;
  override_status: string | null;
  /** Valore salvato: ISO per gli override, l'elemento così com'è per gli exdates. */
  from: string;
  from_rome: string | null;
  /** Valore corretto (per le saltate: quello proposto, se verificato). */
  to: string | null;
  to_rome: string | null;
  direction: Direction | null;
  /** Spiegazione leggibile. */
  detail: string;
}

export interface DstChange extends ItemBase {
  action: FixAction;
  reason: typeof DST_REASON;
  to: string;
  to_rome: string;
  direction: Direction;
  /** Avviso per chi rivede il piano (override modificato rimasto all'ora vecchia). */
  note: string | null;
}

export interface DstSkip extends ItemBase {
  reason: SkipReason;
}

export interface DstSummary {
  masters_scanned: number;
  /** Master con RRULE non interpretabile: nessuna occorrenza, quindi nulla da riallineare. */
  masters_invalid_rrule: number;
  overrides_scanned: number;
  exdates_scanned: number;
  /** Eccezioni già sulla griglia attuale. */
  aligned: number;
  /** Fuori griglia senza la firma DST: non toccate (orfani, serie spostate). */
  other_mismatch: number;
  to_fix: { overrides: number; exdates: number; total: number };
  skipped: Partial<Record<SkipReason, number>>;
}

export interface DstPlan {
  summary: DstSummary;
  changes: DstChange[];
  skipped: DstSkip[];
  /** Impronta delle modifiche (per --expect-plan). */
  fingerprint: string;
}

export interface DstReport {
  script: typeof SCRIPT_NAME;
  mode: 'dry-run' | 'apply';
  run_id: string;
  generated_at: string;
  database: string;
  timezone: typeof EXPANSION_TZ;
  /** Filtro --calendar (null = tutti i calendari). */
  calendars: string[] | null;
  plan_fingerprint: string;
  summary: DstSummary;
  changes: DstChange[];
  skipped: DstSkip[];
  /** Solo con --apply. */
  applied: { updated_rows: number; audit_rows: number } | null;
}

export interface DstFixOptions {
  /** Limita ai calendari con questi slug (devono esistere). */
  calendarSlugs?: string[];
}

export interface DstApplyOptions extends DstFixOptions {
  /** Impronta attesa: se il piano ricalcolato è diverso, nessuna modifica. */
  expectPlan?: string;
}

/** Errore d'uso (calendario inesistente): exit 2. */
export class DstFixUsageError extends Error {
  code = 'DST_FIX_USAGE' as const;
  constructor(message: string) { super(message); }
}

/** Il piano ricalcolato in --apply non è quello approvato col dry-run: exit 3. */
export class DstPlanMismatchError extends Error {
  code = 'DST_PLAN_MISMATCH' as const;
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `Il piano è cambiato rispetto al dry-run (atteso ${expected}, ora ${actual}): nessuna modifica. ` +
      'Riesegui il dry-run e controlla il nuovo report.',
    );
  }
}

// ─── Tempo e griglia ───────────────────────────────

const SECONDS_PER_DAY = 86_400;

const toMs = (value: Date | string): number => (value instanceof Date ? value.getTime() : Date.parse(value));

/**
 * Chiave al secondo, come occurrenceKey di events.ts e normalizeIso di
 * rrule.ts: l'espansione tronca i millisecondi, i valori salvati no.
 */
const secondKey = (ms: number): number => Math.floor(ms / 1000);

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** Secondo del giorno in UTC. */
const utcSecondOfDay = (ms: number): number => ((secondKey(ms) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;

/** Offset di Roma (ms) in quell'istante: 1 h in ora solare, 2 h in ora legale. */
const romeOffset = (ms: number): number => getTimezoneOffset(EXPANSION_TZ, new Date(ms));

/** Formato compatto con i secondi solo se presenti (il JSON ha sempre l'ISO completo). */
function formatAt(ms: number, tz: string, suffix: string): string {
  const pattern = new Date(ms).getUTCSeconds() ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm';
  return `${formatInTimeZone(new Date(ms), tz, pattern)}${suffix}`;
}

const formatRome = (ms: number): string => formatAt(ms, EXPANSION_TZ, '');
const formatUtc = (ms: number): string => formatAt(ms, 'UTC', 'Z');

/** L'istante è un'occorrenza del master nell'espansione attuale (stessa funzione di listOccurrences)? */
function isOccurrence(master: MasterRow, ms: number): boolean {
  const start = secondKey(ms) * 1000;
  const hits = expandRRule({
    rrule: master.rrule,
    masterStartIso: isoOf(toMs(master.start_time)),
    fromIso: isoOf(start),
    toIso: isoOf(start + 999),
    limit: 10,
  });
  return hits.some((iso) => secondKey(Date.parse(iso)) === secondKey(start));
}

type Evaluation =
  | { status: 'aligned' }
  | { status: 'other' }
  | { status: 'candidate'; to: number | null; direction: Direction };

/**
 * Classifica un'eccezione rispetto alla griglia attuale (passi 2-4 del
 * criterio in testa al file). `to` è null se il valore corretto calcolato non
 * è un'occorrenza della serie (es. BYDAY valutato sul giorno UTC dal codice vecchio).
 */
function evaluate(master: MasterRow, ms: number): Evaluation {
  if (isOccurrence(master, ms)) return { status: 'aligned' };
  const masterMs = toMs(master.start_time);
  const masterOffset = romeOffset(masterMs);
  const offset = romeOffset(ms);
  if (utcSecondOfDay(ms) !== utcSecondOfDay(masterMs) || offset === masterOffset) return { status: 'other' };
  const corrected = ms + (masterOffset - offset);
  return {
    status: 'candidate',
    to: isOccurrence(master, corrected) ? corrected : null,
    direction: masterOffset > offset ? 'legale→solare' : 'solare→legale',
  };
}

// ─── Piano (funzione pura) ───────────────────────────────

const SKIP_LABELS: Record<SkipReason, string> = {
  NON_ROME_CALENDAR: 'calendario con fuso diverso da Europe/Rome: da verificare a mano',
  ICS_PULL_READ_ONLY: 'serie di un\'iscrizione ICS: sola lettura, il sync la riscrive dal calendario di origine',
  NO_MATCHING_OCCURRENCE: 'il valore corretto calcolato non è un\'occorrenza della serie: da verificare a mano',
  OVERRIDE_CONFLICT: 'esiste già un altro override per l\'occorrenza corretta: da unire o eliminare a mano',
  INVALID_VALUE: 'valore non interpretabile come data: lasciato com\'è',
};

/**
 * Calcola il piano di correzione per i master con RRULE (timed e all-day) e
 * i loro override. Non legge né scrive il database: dry-run e apply la chiamano
 * sulle righe lette (in apply, bloccate).
 */
export function planDstFix(masters: MasterRow[], overrides: OverrideRow[]): DstPlan {
  const summary: DstSummary = {
    masters_scanned: 0,
    masters_invalid_rrule: 0,
    overrides_scanned: 0,
    exdates_scanned: 0,
    aligned: 0,
    other_mismatch: 0,
    to_fix: { overrides: 0, exdates: 0, total: 0 },
    skipped: {},
  };
  const changes: DstChange[] = [];
  const skipped: DstSkip[] = [];

  const overridesByMaster = new Map<string, OverrideRow[]>();
  for (const ov of overrides) {
    const list = overridesByMaster.get(ov.recurrence_master_id) ?? [];
    list.push(ov);
    overridesByMaster.set(ov.recurrence_master_id, list);
  }

  for (const master of masters) {
    summary.masters_scanned += 1;
    const masterOverrides = overridesByMaster.get(master.id) ?? [];
    const exdates = Array.isArray(master.exdates) ? (master.exdates as unknown[]) : null;
    summary.overrides_scanned += masterOverrides.length;
    summary.exdates_scanned += exdates?.length ?? 0;

    const masterMs = toMs(master.start_time);
    // RRULE non interpretabile: listOccurrences non espande nulla, quindi
    // nessuna occorrenza può risorgere (e la griglia non è verificabile).
    // validateRRule non scrive log: expandRRule li scriverebbe su stdout.
    if (Number.isNaN(masterMs) || !validateRRule(master.rrule, isoOf(masterMs))) {
      summary.masters_invalid_rrule += 1;
      continue;
    }

    const base = {
      master_id: master.id,
      master_uid: master.uid,
      summary: master.summary,
      calendar_slug: master.calendar_slug,
      calendar_timezone: master.calendar_timezone,
      master_status: master.status,
      master_start: isoOf(masterMs),
      master_start_rome: formatRome(masterMs),
    };
    const skip = (item: Omit<DstSkip, keyof typeof base | 'detail'>, extra = ''): void => {
      summary.skipped[item.reason] = (summary.skipped[item.reason] ?? 0) + 1;
      skipped.push({ ...base, ...item, detail: `${SKIP_LABELS[item.reason]}${extra}` });
    };
    // Motivi di esclusione che valgono per tutta la serie, verificati solo
    // sulle eccezioni con la firma DST (così il report segnala i casi veri).
    const seriesSkip: SkipReason | null = master.source === 'ics_pull'
      ? 'ICS_PULL_READ_ONLY'
      : master.calendar_timezone !== EXPANSION_TZ ? 'NON_ROME_CALENDAR' : null;

    // ── Override: si sposta il recurrence_id ──
    const overrideCount = new Map<number, number>();
    for (const ov of masterOverrides) {
      const key = secondKey(toMs(ov.recurrence_id));
      overrideCount.set(key, (overrideCount.get(key) ?? 0) + 1);
    }
    const plannedOverrideTargets = new Set<number>();

    for (const ov of masterOverrides) {
      const ms = toMs(ov.recurrence_id);
      const verdict = evaluate(master, ms);
      if (verdict.status === 'aligned') { summary.aligned += 1; continue; }
      if (verdict.status === 'other') { summary.other_mismatch += 1; continue; }

      const item = {
        kind: 'override' as const,
        event_id: ov.id,
        exdate_index: null,
        override_status: ov.status,
        from: isoOf(ms),
        from_rome: formatRome(ms),
        to: verdict.to === null ? null : isoOf(verdict.to),
        to_rome: verdict.to === null ? null : formatRome(verdict.to),
        direction: verdict.direction,
      };
      if (seriesSkip) { skip({ ...item, reason: seriesSkip }, seriesSkip === 'NON_ROME_CALENDAR' ? ` (${master.calendar_timezone})` : ''); continue; }
      if (verdict.to === null) { skip({ ...item, reason: 'NO_MATCHING_OCCURRENCE' }); continue; }
      const target = secondKey(verdict.to);
      if (overrideCount.has(target) || plannedOverrideTargets.has(target)) {
        const other = masterOverrides.find((o) => o.id !== ov.id && secondKey(toMs(o.recurrence_id)) === target);
        skip({ ...item, reason: 'OVERRIDE_CONFLICT' }, other ? ` (override ${other.id})` : '');
        continue;
      }
      plannedOverrideTargets.add(target);

      // L'orario di un override modificato è un dato dell'utente: non si
      // tocca, ma se è rimasto quello della vecchia griglia lo si segnala.
      const stayedOnOldGrid = ov.status !== 'cancelled' && secondKey(toMs(ov.start_time)) === secondKey(ms);
      summary.to_fix.overrides += 1;
      changes.push({
        ...base,
        ...item,
        to: isoOf(verdict.to),
        to_rome: formatRome(verdict.to),
        action: 'realign',
        reason: DST_REASON,
        detail: `recurrence_id ${formatUtc(ms)} (${formatRome(ms)} Roma) → ${formatUtc(verdict.to)} (${formatRome(verdict.to)} Roma)`,
        note: stayedOnOldGrid
          ? `override modificato ancora alle ${formatRome(ms).slice(11)} di Roma del ${formatRome(ms).slice(0, 10)} ` +
            `(ora della vecchia griglia): lo script non ne cambia l'orario; se va riportato alle ` +
            `${formatRome(verdict.to).slice(11)} della serie, spostalo dall'admin`
          : null,
      });
    }

    // ── Exdates: si sostituisce l'elemento nell'array JSONB ──
    if (!exdates) {
      skip({
        kind: 'exdate',
        event_id: master.id,
        exdate_index: null,
        override_status: null,
        from: JSON.stringify(master.exdates) ?? 'null',
        from_rome: null,
        to: null,
        to_rome: null,
        direction: null,
        reason: 'INVALID_VALUE',
      }, ' (exdates non è un array JSON)');
      continue;
    }
    const exdateKeys = new Set<number>();
    for (const raw of exdates) {
      const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
      if (!Number.isNaN(ms)) exdateKeys.add(secondKey(ms));
    }
    const plannedExdateTargets = new Set<number>();

    exdates.forEach((raw, index) => {
      const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
      const common = {
        kind: 'exdate' as const,
        event_id: master.id,
        exdate_index: index,
        override_status: null,
        from: typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'null',
      };
      if (Number.isNaN(ms)) {
        skip({ ...common, from_rome: null, to: null, to_rome: null, direction: null, reason: 'INVALID_VALUE' });
        return;
      }
      const verdict = evaluate(master, ms);
      if (verdict.status === 'aligned') { summary.aligned += 1; return; }
      if (verdict.status === 'other') { summary.other_mismatch += 1; return; }

      const item = {
        ...common,
        from_rome: formatRome(ms),
        to: verdict.to === null ? null : isoOf(verdict.to),
        to_rome: verdict.to === null ? null : formatRome(verdict.to),
        direction: verdict.direction,
      };
      if (seriesSkip) { skip({ ...item, reason: seriesSkip }, seriesSkip === 'NON_ROME_CALENDAR' ? ` (${master.calendar_timezone})` : ''); return; }
      if (verdict.to === null) { skip({ ...item, reason: 'NO_MATCHING_OCCURRENCE' }); return; }

      const target = secondKey(verdict.to);
      // Valore corretto già presente: l'elemento spostato non esclude nulla
      // (non è sulla griglia), quindi rimuoverlo non cambia l'espansione.
      const duplicate = exdateKeys.has(target) || plannedExdateTargets.has(target);
      plannedExdateTargets.add(target);
      summary.to_fix.exdates += 1;
      changes.push({
        ...base,
        ...item,
        to: isoOf(verdict.to),
        to_rome: formatRome(verdict.to),
        action: duplicate ? 'drop-duplicate' : 'realign',
        reason: DST_REASON,
        detail: duplicate
          ? `exdate ${formatUtc(ms)} (${formatRome(ms)} Roma) rimosso: ${formatUtc(verdict.to)} (${formatRome(verdict.to)} Roma) è già presente`
          : `exdate ${formatUtc(ms)} (${formatRome(ms)} Roma) → ${formatUtc(verdict.to)} (${formatRome(verdict.to)} Roma)`,
        note: null,
      });
    });
  }

  const order = (a: ItemBase, b: ItemBase): number =>
    a.calendar_slug.localeCompare(b.calendar_slug)
    || a.master_start.localeCompare(b.master_start)
    || a.master_id.localeCompare(b.master_id)
    || a.kind.localeCompare(b.kind)
    || a.from.localeCompare(b.from)
    || (a.exdate_index ?? -1) - (b.exdate_index ?? -1);
  changes.sort(order);
  skipped.sort(order);
  summary.to_fix.total = summary.to_fix.overrides + summary.to_fix.exdates;

  return { summary, changes, skipped, fingerprint: planFingerprint(changes) };
}

/** Impronta delle modifiche, indipendente dall'ordine e dal run. */
export function planFingerprint(changes: DstChange[]): string {
  const canonical = changes
    .map((c) => JSON.stringify([c.event_id, c.kind, c.action, c.exdate_index, c.from, c.to]))
    .sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

// ─── Database ───────────────────────────────

/**
 * Connessione della transazione. Il tipo TransactionSql di postgres-js perde
 * la firma del tagged template (Omit su Sql), per questo src/ usa `tx: any`:
 * qui lo si riporta una volta sola al tipo di `sql`, che a runtime coincide
 * per le query (begin/end non vanno usati dentro la transazione).
 */
type Tx = typeof sql;
const asTx = (trx: postgres.TransactionSql): Tx => trx as unknown as Tx;

async function currentDatabase(tx: Tx): Promise<string> {
  const [row] = await tx<Array<{ db: string }>>`SELECT current_database() AS db`;
  return row.db;
}

/** Valida il filtro --calendar: uno slug inesistente è quasi sempre un refuso. */
async function resolveCalendarSlugs(tx: Tx, slugs?: string[]): Promise<string[] | null> {
  if (!slugs || slugs.length === 0) return null;
  const unique = [...new Set(slugs)];
  const found = await tx<Array<{ slug: string }>>`SELECT slug FROM calendars WHERE slug = ANY(${unique}::text[])`;
  const known = new Set(found.map((r) => r.slug));
  const missing = unique.filter((s) => !known.has(s));
  if (missing.length) throw new DstFixUsageError(`Calendari inesistenti: ${missing.join(', ')}`);
  return unique.sort();
}

/**
 * Master con RRULE, timed e all-day (stesso criterio di listOccurrences: rrule
 * non vuota, nessun recurrence_master_id) e i loro override. Con `lock` le
 * righe restano bloccate fino alla fine della transazione.
 */
async function loadRows(tx: Tx, calendarSlugs: string[] | null, lock: boolean): Promise<{ masters: MasterRow[]; overrides: OverrideRow[] }> {
  const masters = await tx<MasterRow[]>`
    SELECT e.id, e.uid, e.summary, c.slug AS calendar_slug, c.timezone AS calendar_timezone,
           e.start_time, e.rrule, e.exdates, e.source, e.status
    FROM calendar_events e
    JOIN calendars c ON c.id = e.calendar_id
    WHERE e.recurrence_master_id IS NULL
      AND e.rrule IS NOT NULL AND e.rrule <> ''
      ${calendarSlugs ? tx`AND c.slug = ANY(${calendarSlugs}::text[])` : tx``}
    ORDER BY c.slug, e.start_time, e.id
    ${lock ? tx`FOR UPDATE OF e` : tx``}
  `;
  if (masters.length === 0) return { masters: [], overrides: [] };
  const overrides = await tx<OverrideRow[]>`
    SELECT id, recurrence_master_id, recurrence_id, start_time, status
    FROM calendar_events
    WHERE recurrence_master_id = ANY(${masters.map((m) => m.id)}::uuid[])
    ORDER BY recurrence_master_id, recurrence_id, id
    ${lock ? tx`FOR UPDATE` : tx``}
  `;
  return { masters: [...masters], overrides: [...overrides] };
}

function buildReport(opts: {
  mode: DstReport['mode'];
  runId: string;
  database: string;
  calendars: string[] | null;
  plan: DstPlan;
  applied: DstReport['applied'];
}): DstReport {
  return {
    script: SCRIPT_NAME,
    mode: opts.mode,
    run_id: opts.runId,
    generated_at: new Date().toISOString(),
    database: opts.database,
    timezone: EXPANSION_TZ,
    calendars: opts.calendars,
    plan_fingerprint: opts.plan.fingerprint,
    summary: opts.plan.summary,
    changes: opts.plan.changes,
    skipped: opts.plan.skipped,
    applied: opts.applied,
  };
}

/** Dry-run: legge in uno snapshot coerente (repeatable read, sola lettura) e non scrive nulla. */
export async function buildDstFixReport(opts: DstFixOptions = {}): Promise<DstReport> {
  const runId = randomUUID();
  return sql.begin('isolation level repeatable read read only', async (trx) => {
    const tx = asTx(trx);
    const database = await currentDatabase(tx);
    const calendars = await resolveCalendarSlugs(tx, opts.calendarSlugs);
    const rows = await loadRows(tx, calendars, false);
    const plan = planDstFix(rows.masters, rows.overrides);
    return buildReport({ mode: 'dry-run', runId, database, calendars, plan, applied: null });
  }) as Promise<DstReport>;
}

/** Nuovo array exdates: elementi riallineati al loro posto, duplicati rimossi, il resto invariato. */
function rewriteExdates(before: unknown[], changes: DstChange[]): unknown[] {
  const byIndex = new Map(changes.map((c) => [c.exdate_index, c]));
  return before.flatMap((value, index) => {
    const change = byIndex.get(index);
    if (!change) return [value];
    return change.action === 'realign' ? [change.to] : [];
  });
}

async function writeAudit(tx: Tx, entry: {
  runId: string;
  fingerprint: string;
  recordId: string;
  field: 'recurrence_id' | 'exdates';
  oldValue: unknown;
  newValue: unknown;
  changes: DstChange[];
}): Promise<void> {
  const first = entry.changes[0];
  // Niente titoli o descrizioni nei metadata (possono contenere dati personali).
  const metadata = {
    script: SCRIPT_NAME,
    run_id: entry.runId,
    plan_fingerprint: entry.fingerprint,
    reason: DST_REASON,
    master_id: first.master_id,
    calendar_slug: first.calendar_slug,
    changes: entry.changes.map((c) => ({
      kind: c.kind,
      action: c.action,
      exdate_index: c.exdate_index,
      from: c.from,
      to: c.to,
      from_rome: c.from_rome,
      to_rome: c.to_rome,
      direction: c.direction,
    })),
  };
  await tx`
    INSERT INTO audit_logs (
      user_id, user_email, user_role, action, table_name, record_id,
      old_data, new_data, changed_fields, user_agent, request_id, metadata
    ) VALUES (
      ${null}, ${AUDIT_ACTOR}, ${'system'}, ${'UPDATE'}, ${'calendar_events'}, ${entry.recordId},
      ${jsonb({ [entry.field]: entry.oldValue })}, ${jsonb({ [entry.field]: entry.newValue })},
      ${[entry.field]}, ${AUDIT_AGENT}, ${entry.runId}, ${jsonb(metadata)}
    )
  `;
}

/**
 * Apply: in una sola transazione blocca le righe, ricalcola il piano (con
 * --expect-plan deve essere quello approvato), aggiorna e scrive l'audit.
 * Qualsiasi errore annulla tutto.
 */
export async function applyDstFix(opts: DstApplyOptions = {}): Promise<DstReport> {
  const runId = randomUUID();
  return sql.begin(async (trx) => {
    const tx = asTx(trx);
    // Le righe del calendario sono bloccate solo per la durata dell'apply:
    // meglio fallire che restare in coda dietro una transazione appesa.
    await tx`SET LOCAL lock_timeout = '10s'`;
    const database = await currentDatabase(tx);
    const calendars = await resolveCalendarSlugs(tx, opts.calendarSlugs);
    const rows = await loadRows(tx, calendars, true);
    const plan = planDstFix(rows.masters, rows.overrides);
    if (opts.expectPlan !== undefined && opts.expectPlan !== plan.fingerprint) {
      throw new DstPlanMismatchError(opts.expectPlan, plan.fingerprint);
    }

    let updatedRows = 0;
    let auditRows = 0;

    for (const change of plan.changes.filter((c) => c.kind === 'override')) {
      const updated = await tx`
        UPDATE calendar_events SET recurrence_id = ${change.to}::timestamptz
        WHERE id = ${change.event_id}::uuid
          AND date_trunc('milliseconds', recurrence_id) = ${change.from}::timestamptz
        RETURNING id
      `;
      if (updated.length !== 1) throw new Error(`Override ${change.event_id} cambiato durante l'apply: annullato`);
      updatedRows += 1;
      await writeAudit(tx, {
        runId, fingerprint: plan.fingerprint, recordId: change.event_id,
        field: 'recurrence_id', oldValue: change.from, newValue: change.to, changes: [change],
      });
      auditRows += 1;
    }

    const exdateChanges = new Map<string, DstChange[]>();
    for (const change of plan.changes.filter((c) => c.kind === 'exdate')) {
      const list = exdateChanges.get(change.event_id) ?? [];
      list.push(change);
      exdateChanges.set(change.event_id, list);
    }
    const mastersById = new Map(rows.masters.map((m) => [m.id, m]));
    for (const [masterId, changes] of exdateChanges) {
      const before = mastersById.get(masterId)?.exdates as unknown[];
      const after = rewriteExdates(before, changes);
      const updated = await tx`
        UPDATE calendar_events SET exdates = ${jsonb(after)}
        WHERE id = ${masterId}::uuid AND exdates = ${jsonb(before)}
        RETURNING id
      `;
      if (updated.length !== 1) throw new Error(`Exdates del master ${masterId} cambiati durante l'apply: annullato`);
      updatedRows += 1;
      await writeAudit(tx, {
        runId, fingerprint: plan.fingerprint, recordId: masterId,
        field: 'exdates', oldValue: before, newValue: after, changes,
      });
      auditRows += 1;
    }

    return buildReport({
      mode: 'apply', runId, database, calendars, plan,
      applied: { updated_rows: updatedRows, audit_rows: auditRows },
    });
  }) as Promise<DstReport>;
}

// ─── Report leggibile ───────────────────────────────

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function cellAt(iso: string | null, rome: string | null): string {
  if (!iso) return '-';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return truncate(iso, 30);
  return `${formatUtc(ms)} (${rome?.slice(11) ?? ''} Roma)`;
}

function outcome(item: DstChange | DstSkip): string {
  if ('action' in item) return item.action === 'realign' ? `riallinea (${item.direction})` : 'rimuovi: valore corretto già presente';
  const reason: Record<SkipReason, string> = {
    NON_ROME_CALENDAR: `saltata: fuso ${item.calendar_timezone}`,
    ICS_PULL_READ_ONLY: 'saltata: iscrizione ICS',
    NO_MATCHING_OCCURRENCE: 'saltata: nessuna occorrenza corretta',
    OVERRIDE_CONFLICT: 'saltata: conflitto con un altro override',
    INVALID_VALUE: 'saltata: valore non valido',
  };
  return reason[item.reason];
}

function itemRows(items: Array<DstChange | DstSkip>): string[][] {
  return items.map((item, i) => [
    String(i + 1),
    item.kind === 'override' ? `override${item.override_status === 'cancelled' ? ' (cancellato)' : ''}` : `exdate[${item.exdate_index ?? '-'}]`,
    item.calendar_slug,
    truncate(item.summary, 32),
    cellAt(item.from, item.from_rome),
    cellAt(item.to, item.to_rome),
    outcome(item),
  ]);
}

/** Report per il terminale: riepilogo, tabelle di modifiche e saltate, note e comando per applicare. */
export function formatDstReport(report: DstReport): string {
  const s = report.summary;
  const skippedTotal = Object.values(s.skipped).reduce((a, b) => a + (b ?? 0), 0);
  const headers = (target: string): string[] => ['#', 'Tipo', 'Calendario', 'Serie', 'Valore salvato', target, 'Esito'];
  const out: string[] = [
    `Eccezioni DST (${SCRIPT_NAME}) · ${report.mode === 'apply' ? 'APPLY' : 'DRY-RUN: nessuna modifica scritta'}`,
    `Database: ${report.database} · calendari: ${report.calendars ? report.calendars.join(', ') : 'tutti'} · griglia: ${report.timezone} · run ${report.run_id}`,
    `Serie analizzate: ${s.masters_scanned} (override ${s.overrides_scanned}, exdates ${s.exdates_scanned}; RRULE non valide: ${s.masters_invalid_rrule})`,
    `Già allineate: ${s.aligned} · da correggere: ${s.to_fix.total} (override ${s.to_fix.overrides}, exdates ${s.to_fix.exdates}) · ` +
      `saltate: ${skippedTotal} · fuori griglia per altri motivi (non toccate): ${s.other_mismatch}`,
    '',
  ];

  if (report.changes.length) {
    out.push(report.mode === 'apply' ? 'Corrette:' : 'Da correggere:', renderTable(headers('Valore corretto'), itemRows(report.changes)), '');
  } else {
    out.push('Nessuna eccezione da riallineare.', '');
  }
  if (report.skipped.length) {
    out.push('Saltate (non modificate, da verificare):', renderTable(headers('Valore proposto'), itemRows(report.skipped)), '');
    for (const [i, item] of report.skipped.entries()) out.push(`  ${i + 1}. ${item.detail}`);
    out.push('');
  }
  const notes = report.changes.filter((c) => c.note);
  if (notes.length) {
    out.push('Note:');
    for (const c of notes) out.push(`  - ${c.calendar_slug} · ${truncate(c.summary, 40)}: ${c.note}`);
    out.push('');
  }

  if (report.mode === 'apply' && report.applied) {
    out.push(
      `Applicato: ${report.applied.updated_rows} righe aggiornate, ${report.applied.audit_rows} righe in audit_logs ` +
      `(request_id = ${report.run_id}).`,
    );
  } else if (report.changes.length) {
    const filter = report.calendars ? report.calendars.map((c) => ` --calendar ${c}`).join('') : '';
    out.push(
      `Impronta del piano: ${report.plan_fingerprint}`,
      `Per applicare: pnpm calendar:fix-dst -- --apply --expect-plan ${report.plan_fingerprint}${filter}`,
    );
  }
  return out.join('\n').trimEnd();
}

// ─── CLI ───────────────────────────────

const USAGE = `Uso: tsx scripts/fix-dst-exceptions.ts [opzioni]

Riallinea le eccezioni delle serie (recurrence_id ed exdates) salvate prima del
fix DST (d046006). Senza --apply è un dry-run: stampa il report e non scrive nulla.

Opzioni:
  --apply                 applica le correzioni in una transazione, con audit_logs
  --expect-plan <hash>    obbligatoria con --apply: l'impronta stampata dal dry-run;
                          rifiuta se il piano ricalcolato è diverso
  --calendar <slug>       limita ai calendari indicati (ripetibile)
  --json                  stampa il report in JSON invece della tabella
  --out <file>            salva anche il report JSON nel file
  -h, --help              mostra questo aiuto`;

function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; detail?: string };
  return [e.message || e.code || String(err), e.detail].filter(Boolean).join(' · ');
}

/**
 * Esegue la CLI e restituisce l'exit code (non chiama process.exit). Alla fine
 * chiude il pool di src/db: non va chiamata in-process da chi usa ancora `sql`
 * (i test usano buildDstFixReport e applyDstFix, oppure lanciano lo script).
 */
export async function main(argv: string[]): Promise<number> {
  let values: { apply?: boolean; 'expect-plan'?: string; calendar?: string[]; json?: boolean; out?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      // pnpm può inoltrare il separatore '--' allo script.
      args: argv.filter((a) => a !== '--'),
      options: {
        apply: { type: 'boolean' },
        'expect-plan': { type: 'string' },
        calendar: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
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
  if (values['expect-plan'] !== undefined && !values.apply) {
    console.error('--expect-plan va usato insieme ad --apply.');
    return 2;
  }
  // Si applica solo un piano rivisto: senza impronta un --apply lanciato con
  // un filtro --calendar diverso da quello del dry-run (o senza dry-run)
  // modificherebbe righe che nessuno ha visto.
  if (values.apply && !values['expect-plan']) {
    console.error(
      '--apply richiede --expect-plan <impronta>: esegui prima il dry-run (stesse opzioni, senza --apply), ' +
      'controlla il report e ripeti con --apply --expect-plan <impronta stampata dal dry-run>.',
    );
    return 2;
  }

  try {
    const options = { calendarSlugs: values.calendar };
    const report = values.apply
      ? await applyDstFix({ ...options, expectPlan: values['expect-plan'] })
      : await buildDstFixReport(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) {
      // Titoli e uid delle serie: solo il proprietario. `mode` vale solo per un
      // file nuovo, chmod anche per uno che esisteva già.
      const out = resolve(values.out);
      writeFileSync(out, json, { mode: 0o600 });
      chmodSync(out, 0o600);
    }
    process.stdout.write(values.json ? json : `${formatDstReport(report)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof DstFixUsageError) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof DstPlanMismatchError) {
      console.error(err.message);
      return 3;
    }
    console.error(`Errore: ${describeError(err)}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
