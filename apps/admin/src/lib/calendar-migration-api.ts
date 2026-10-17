/**
 * Client tipizzato dello strumento di migrazione del calendario a Radicale
 * (`/api/admin/calendar/migration`, fasi F3 e F4; contratti
 * docs/calendar-radicale/contracts/f3-modules.md §10 e §11 e
 * docs/calendar-radicale/contracts/f4-modules.md §6: passaggio, rollback,
 * chiusura della finestra, proiezione inversa, export v2).
 *
 * I DTO sono copiati da apps/api/src/lib/calendar/migration/types.ts: il
 * contratto è il JSON delle risposte, non il codice dell'API. Chiavi
 * snake_case, istanti ISO 8601 UTC, id delle righe come stringa.
 *
 * Gli errori dell'API hanno la forma `{ error, code, details? }`:
 * MigrationApiError conserva codice e dettagli (motivi delle precondizioni,
 * frase di conferma attesa, run in corso) perché il wizard li mostri accanto
 * all'azione. Stessa autenticazione di apiFetch (cookie e refresh del JWT).
 */

import { API_BASE, apiFetchRaw, refreshAdminSession, sessionState } from './api';
import { getStoredAdminLocale, toIntlLocale } from './i18n-storage';

const BASE = '/api/admin/calendar/migration';

// ─── DTO (copia di types.ts) ───────────────────────────────

export type MigrationRunKind =
  | 'preflight' | 'init' | 'archive' | 'identity' | 'inventory' | 'plan' | 'apply' | 'verify'
  | 'cutover' | 'rollback_preview' | 'rollback' | 'rebaseline' | 'finalize';
export type MigrationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type MigrationRunTrigger = 'admin' | 'schedule' | 'shadow' | 'restore' | 'system';
export type MigrationItemType = 'check' | 'anomaly' | 'object' | 'collection' | 'diff' | 'degradation';
export type PlanAction = 'create' | 'update' | 'delete' | 'noop' | 'adopt' | 'skip' | 'conflict';
export type ApplyOutcome = 'done' | 'adopted' | 'noop' | 'skipped' | 'conflict' | 'failed' | 'forced';
export type ItemSeverity = 'info' | 'warning' | 'error';
export type VerifyLevel = 'V1' | 'V2' | 'V3' | 'V4' | 'V5';
export type VerifyColor = 'green' | 'yellow' | 'red';
export type IdentityStatus = 'ok' | 'uninitialized' | 'mismatch' | 'unverified';
export type PreflightCheckStatus = 'pass' | 'warn' | 'fail' | 'confirm' | 'skip';
export type ConflictCode =
  | 'TARGET_NEWER' | 'BOTH_CHANGED' | 'UNTRACKED_TARGET' | 'DELETED_IN_TARGET' | 'UID_AT_OTHER_HREF'
  | 'COLLECTION_MISSING' | 'REVALIDATION_REQUIRED' | 'DERIVED_EDITED';
export type DeclarationKey = 'phase0' | 'remote_mode_accepted' | 'public_401_verified' | 'backup_verified' | 'device_matrix';
export type WizardStepId = 'prerequisiti' | 'anteprima' | 'applica' | 'verifica' | 'shadow' | 'passaggio';
export type WizardStepStatus = 'locked' | 'todo' | 'running' | 'done' | 'attention' | 'blocked' | 'disabled';
export type WizardActionId =
  | 'preflight' | 'initialize' | 'create_collections' | 'archive' | 'declare' | 'identity_reassign'
  | 'inventory' | 'plan' | 'apply' | 'verify' | 'accept' | 'shadow_on' | 'shadow_off' | 'cutover'
  | 'cutover_abort' | 'transition_resume' | 'rollback_preview' | 'rollback' | 'finalize' | 'rebaseline' | 'export_v2';
export type BackendMode = 'postgres' | 'cutover' | 'radicale' | 'rollback' | 'finalized';
export type TransitionKind = 'cutover' | 'rollback' | 'finalize';
export type TransitionStatus = 'active' | 'completed' | 'aborted';
export type JournalStepStatus = 'started' | 'done' | 'skipped' | 'failed';
export type DegradationClass =
  | 'REPR_LOSS_VALARM' | 'REPR_LOSS_ATTENDEE' | 'REPR_LOSS_PROPERTY' | 'SEMANTIC_EXPANDED' | 'SEMANTIC_TRANSP'
  | 'SANITIZED_UID' | 'SANITIZED_DURATION' | 'SANITIZED_SUMMARY' | 'SANITIZED_STATUS' | 'REVERSE_FAILED';
export type ReverseStateStatus = 'projected' | 'degraded' | 'failed' | 'removed';

export interface MigrationProgress {
  phase?: string;
  done?: number;
  total?: number;
  calendar_id?: string | null;
  message?: string | null;
}

export interface MigrationRunView<S = Record<string, unknown>> {
  id: string;
  kind: MigrationRunKind;
  status: MigrationRunStatus;
  trigger: MigrationRunTrigger;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  progress: MigrationProgress;
  summary: S | null;
  error: { code: string; message: string } | null;
  plan_run_id: string | null;
  plan_hash: string | null;
  attempts: number;
  cancel_requested: boolean;
}

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

export interface PreflightCheck {
  code: string;
  status: PreflightCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
  remedy?: string | null;
  declaration?: DeclarationKey | null;
  declared?: boolean;
}

export interface PreflightSummary {
  checks: PreflightCheck[];
  blocking: string[];
  ready: boolean;
  identity: IdentityStatus;
  can_initialize: boolean;
  missing_collections: string[];
  radicale: { configured: boolean; reachable: boolean | null; version: string | null };
  watch_mode: 'mount' | 'remote' | 'off';
}

export interface MigrationOptions {
  fix_until_admin_pattern: boolean;
  realign_dst_exceptions: boolean;
  orphans: 'convert' | 'discard';
  bookings_move_event_ids: string[];
  bookings_move_target_calendar_id: string | null;
}

export const DEFAULT_MIGRATION_OPTIONS: Readonly<MigrationOptions> = Object.freeze({
  fix_until_admin_pattern: true,
  realign_dst_exceptions: true,
  orphans: 'convert',
  bookings_move_event_ids: [],
  bookings_move_target_calendar_id: null,
});

export interface MigrationScope { calendar_ids?: string[] }

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
  impact: { weeks: number; busy_hours_per_week: number; slots_lost_per_week: Record<string, number> } | null;
}

export interface SubscriptionMigrationView extends SubscriptionImpact { url_host: string | null }
export interface SubscriptionFlagsResponse { subscription: SubscriptionMigrationView; collection_missing: boolean }

export interface PlanCalendarCounts { calendar_id: string; collection_name: string; counts: Record<PlanAction, number> }

/** Anteprima leggibile (PlanSummary.preview, plan.ts). */
export interface PlanPreview {
  calendars: Array<{
    calendar_id: string;
    slug: string;
    name: string;
    collection_name: string | null;
    role: string;
    included: boolean;
    excluded_reason: string | null;
    objects: number;
    counts: Record<PlanAction, number>;
    examples: Partial<Record<PlanAction, Array<{ legacy_key: string; href: string; summary: string | null; code: string | null }>>>;
    anomalies: Record<string, number>;
  }>;
  anomalies: Array<{
    code: string;
    severity: ItemSeverity;
    blocking: boolean;
    option: keyof MigrationOptions | null;
    description: string;
    count: number;
    examples: Array<{ calendar_id: string | null; legacy_key: string | null; detail: Record<string, unknown> }>;
  }>;
  options: Array<{ key: keyof MigrationOptions; value: unknown; default: unknown; label: string; affected: number }>;
  blocking: string[];
  bookings_move_candidates: Array<{ event_id: string; summary: string | null; moved: boolean; target_calendar_id: string | null }>;
  subscriptions: SubscriptionImpact[];
  subscription_defaults: { blocks_availability: false; device_visible: false };
  fixed_rules: Array<{ key: string; label: string; affected: number }>;
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
  skips: Record<string, number>;
  calendars: PlanCalendarCounts[];
  anomalies: Record<string, number>;
  revalidation_pending: number;
  estimate_seconds: number;
  preview?: PlanPreview;
}

export interface InventoryCounts {
  rows: number;
  singles_timed: number;
  singles_all_day: number;
  series: number;
  overrides_modified: number;
  overrides_cancelled: number;
  exdates: number;
  projections: number;
  holidays_system: number;
  closures: number;
  non_projection_in_bookings: number;
}

export interface InventorySummary {
  generated_at: string;
  calendars: Array<{
    calendar_id: string;
    slug: string;
    name: string;
    collection_name: string | null;
    role: string;
    origin: string;
    is_system: boolean;
    blocks_availability: boolean;
    included: boolean;
    excluded_reason: string | null;
    counts: InventoryCounts;
    anomalies: Record<string, number>;
  }>;
  totals: InventoryCounts;
  anomalies: Record<string, number>;
  subscriptions: SubscriptionImpact[];
  app_passwords: { active: number; non_canonical: number; reserved: number };
  estimate: { objects: number; writes_upper_bound: number; seconds: number };
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
  zero_writes: boolean;
  /** Estensioni di apply.ts (ApplyRunSummary). */
  attempt?: number;
  previous_attempt_writes?: number;
  calendars?: Array<{ calendar_id: string; collection_name: string; totals: Record<ApplyOutcome, number> }>;
}

export interface VerifyLevelVerdict { color: VerifyColor; diffs: number; expected: number; unexpected: number }

export interface CalendarVerdict {
  calendar_id: string;
  collection_name: string;
  slug: string;
  color: VerifyColor;
  accepted: boolean;
  levels: Partial<Record<VerifyLevel, VerifyLevelVerdict>>;
}

export interface VerifySummary {
  generated_at: string;
  levels: VerifyLevel[];
  overall: VerifyColor;
  acceptable: boolean;
  calendars: CalendarVerdict[];
  v4: { from: string; to: string; without_subscriptions: VerifyColor; with_subscriptions: VerifyColor } | null;
  totals: { diffs: number; expected: number; unexpected: number; accepted: number };
}

export interface AcceptDiffsResponse { accepted: number; calendars: CalendarVerdict[]; acceptable: boolean }

export interface IdentityDiffView {
  status: IdentityStatus;
  pg: { mode: string; volume_id: string | null; epoch: number };
  volume: {
    principal_exists: boolean | null;
    marker: { volume_id: string; epoch: number } | null;
    collections: Array<{ name: string; calendar_id_prop: string | null; role_prop: string | null; items: number | null }>;
    read_error: string | null;
  };
  ledger: { live: number; with_target_etag: number };
  allowed: Array<'volume_to_pg' | 'pg_to_volume'>;
  explanation: string;
}

export interface ShadowStateResponse { shadow_enabled: boolean; shadow_since: string | null; catch_up_run: MigrationRunView | null }

export interface ParityView {
  shadow_enabled: boolean;
  shadow_since: string | null;
  green_since: string | null;
  days_green: number;
  required_days: number;
  satisfied: boolean;
  /** `green`: verifica accettabile (verde, o gialla con le differenze accettate); null finché non è conclusa. */
  last_nightly: { apply_run_id: string | null; verify_run_id: string | null; color: VerifyColor | null; green: boolean | null; finished_at: string | null } | null;
  last_hourly: { run_id: string; color: VerifyColor; finished_at: string } | null;
  recent: Array<{ run_id: string; kind: 'apply' | 'verify'; trigger: MigrationRunTrigger; finished_at: string; color: VerifyColor | null; writes: number | null; conflicts: number | null }>;
  queue: { pending: number; running: number; dead: number; oldest_pending_at: string | null };
  open_conflicts: number;
}

export interface DeclarationValues {
  phase0: { status: 'absent' | 'archived' | 'present_not_imported'; note?: string | null; archive_run_id?: string | null };
  remote_mode_accepted: { reason: string };
  public_401_verified: { method: 'curl' | 'browser' | 'other'; note?: string | null };
  backup_verified: { note?: string | null };
  device_matrix: {
    result: 'passed' | 'failed';
    strict_preconditions: boolean;
    allday_transp_rule: 'opaque_blocks' | 'never_block';
    devices: Array<'ios' | 'macos' | 'davx5' | 'thunderbird'>;
    notes?: string | null;
  };
}

export interface Declaration<K extends DeclarationKey = DeclarationKey> { value: DeclarationValues[K]; at: string; by: string }
export type MigrationDeclarations = { [K in DeclarationKey]?: Declaration<K> };

export interface LastStackBackup { id: string; at: string; complete: boolean; volume_id: string | null; epoch: number | null; manifest_sha256: string | null }

export interface WizardAction { id: WizardActionId; enabled: boolean; reason: string | null; confirm: string | null }

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

export interface CutoverCriterion { id: string; label: string; ok: boolean; detail: string | null }
export interface CutoverAvailability { available: boolean; phase: 'F4'; reason: string; criteria: CutoverCriterion[] }

/** Passo del journal di una transizione (JournalStepView). */
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

/** Transizione (cutover, rollback, finalize) con il journal (TransitionView). */
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
  next_step: string | null;
  resumable: boolean;
  abortable: boolean;
}

export interface RollbackWindowView {
  cutover_at: string;
  cutover_by: string | null;
  rollback_until: string | null;
  days_left: number;
  expired: boolean;
  finalize_available_at: string;
  finalize_ready: boolean;
  finalize_blockers: string[];
}

export interface ReverseProjectionHealthView {
  active: boolean;
  until: string | null;
  objects: number;
  by_status: Record<ReverseStateStatus, number>;
  by_class: Partial<Record<DegradationClass, number>>;
  derived_rows: number;
  last_projected_at: string | null;
  queue: { pending: number; running: number; dead: number };
}

export interface SmokeCheck { code: string; ok: boolean; ms: number; detail: string | null }
export interface SmokeReport { ok: boolean; started_at: string; finished_at: string; checks: SmokeCheck[] }

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

export interface CutoverSummary {
  transition_id: string;
  outcome: 'completed' | 'aborted';
  abort_reason: string | null;
  epoch_before: number;
  epoch_after: number | null;
  rollback_until: string | null;
  delta: ApplySummary | null;
  reverse: ReverseApplySummary | null;
  bookings_reconciled: number;
  smoke: SmokeReport | null;
}

export interface RollbackPreviewSummary {
  preview_hash: string;
  generated_at: string;
  cutover_at: string | null;
  rollback_until: string | null;
  changes_since_cutover: { created: number; updated: number; deleted: number; by_actor: Partial<Record<string, number>> };
  objects: number;
  derived_rows: number;
  by_class: Partial<Record<DegradationClass, number>>;
  reverse_failed: number;
  busy_identical: boolean | null;
  calendars: Array<{ calendar_id: string; collection_name: string; objects: number; degraded: number; failed: number; derived_rows: number }>;
}

export interface RollbackSummary {
  transition_id: string;
  outcome: 'completed' | 'aborted';
  abort_reason: string | null;
  emergency: boolean;
  preview_hash: string | null;
  final_preview_hash: string | null;
}

export interface MigrationStateView {
  contract_version: number;
  phase: string;
  backend: {
    mode: string;
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
  /** F4: transizione attiva o ultima conclusa. */
  transition?: TransitionView | null;
  /** F4: finestra di rollback dopo il passaggio. */
  rollback_window?: RollbackWindowView | null;
  /** F4: salute della proiezione inversa (Radicale → Postgres). */
  reverse_projection?: ReverseProjectionHealthView | null;
}

// ─── Costanti del contratto ───────────────────────────────

/** Frasi da digitare (MIGRATION_CONFIRMATIONS di types.ts). */
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
  cutover: 'PASSA A RADICALE',
  rollback: 'TORNA A POSTGRES',
  finalize: 'CHIUDI LA FINESTRA',
  cutoverAbort: 'ANNULLA IL PASSAGGIO',
  rollbackEmergency: 'ROLLBACK DI EMERGENZA',
} as const);

/** Finestra di rollback proposta e limiti (F4_LIMITS di types.ts). */
export const F4_LIMITS = Object.freeze({
  rollbackWindowDays: 30,
  rollbackWindowMinDays: 14,
  rollbackWindowMaxDays: 90,
  finalizeMinDays: 14,
  rollbackPreviewMaxAgeMinutes: 60,
});

/** Passi delle transizioni nell'ordine (CUTOVER_STEPS, ROLLBACK_STEPS, FINALIZE_STEPS di types.ts). */
export const TRANSITION_STEPS: Readonly<Record<TransitionKind, readonly string[]>> = Object.freeze({
  cutover: ['preflight', 'freeze', 'quiesce', 'delta_apply', 'delta_verify', 'epoch', 'control_plane', 'index_sync', 'reverse_start', 'bookings_reconcile', 'unfreeze', 'smoke'],
  rollback: ['preflight', 'freeze', 'quiesce', 'index_sync', 'reverse_final', 'rebaseline', 'epoch', 'control_plane', 'cleanup'],
  finalize: ['preflight', 'stop_reverse', 'state', 'legacy_finalize'],
});

export const TRANSITION_KIND_LABELS: Readonly<Record<TransitionKind, string>> = Object.freeze({
  cutover: 'Passaggio a Radicale',
  rollback: 'Ritorno a Postgres',
  finalize: 'Chiusura della finestra',
});

/** Descrizione dei passi del journal (per tipo di transizione). */
export const TRANSITION_STEP_LABELS: Readonly<Record<TransitionKind, Readonly<Record<string, string>>>> = Object.freeze({
  cutover: {
    preflight: 'Controllo dei criteri',
    freeze: 'Scritture sospese (device in sola lettura)',
    quiesce: 'Attesa delle scritture in corso e quiescenza dei device',
    delta_apply: 'Ultime modifiche di Postgres verso Radicale',
    delta_verify: 'Verifica del delta',
    epoch: 'Radicale autorevole (punto di non ritorno)',
    control_plane: 'Nuova policy ai device',
    index_sync: 'Allineamento dell\'indice',
    reverse_start: 'Prima copia di sicurezza in Postgres',
    bookings_reconcile: 'Prenotazioni a cavallo del passaggio',
    unfreeze: 'Scritture riaperte',
    smoke: 'Prove finali (slot, prenotazione, feed, MCP)',
    abort: 'Annullamento: ritorno a Postgres',
  },
  rollback: {
    preflight: 'Controllo dell\'anteprima e della finestra',
    freeze: 'Scritture sospese (device in sola lettura)',
    quiesce: 'Attesa delle scritture in corso e quiescenza dei device',
    index_sync: 'Sincronizzazione finale dell\'indice',
    reverse_final: 'Copia finale in Postgres',
    rebaseline: 'Ri-baseline del ledger',
    epoch: 'Postgres autorevole (punto di non ritorno)',
    control_plane: 'Nuova policy ai device',
    cleanup: 'Pulizia',
    abort: 'Annullamento: Radicale resta autorevole',
  },
  finalize: {
    preflight: 'Controllo delle condizioni',
    stop_reverse: 'Stop della copia verso Postgres',
    state: 'Finestra chiusa',
    legacy_finalize: 'Tabella legacy in sola lettura',
  },
});

export const JOURNAL_STATUS_LABELS: Readonly<Record<JournalStepStatus, string>> = Object.freeze({
  started: 'In corso',
  done: 'Fatto',
  skipped: 'Saltato',
  failed: 'Non riuscito',
});

export const BACKEND_MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  postgres: 'Postgres',
  cutover: 'Passaggio in corso',
  radicale: 'Radicale',
  rollback: 'Ritorno in corso',
  finalized: 'Radicale (finestra chiusa)',
});

/** Classi dei degradi della copia verso Postgres (DEGRADATION_CLASSES di types.ts). */
export const DEGRADATION_LABELS: Readonly<Record<DegradationClass, string>> = Object.freeze({
  REPR_LOSS_VALARM: 'Promemoria (VALARM) non rappresentabili in Postgres',
  REPR_LOSS_ATTENDEE: 'Invitati e organizzatore non rappresentabili',
  REPR_LOSS_PROPERTY: 'Altre proprietà senza colonna in Postgres',
  SEMANTIC_EXPANDED: 'Serie espanse in occorrenze singole',
  SEMANTIC_TRANSP: '"Libero" reso come provvisorio',
  SANITIZED_UID: 'UID adattati (duplicati)',
  SANITIZED_DURATION: 'Durate nulle allungate',
  SANITIZED_SUMMARY: 'Titoli vuoti sostituiti',
  SANITIZED_STATUS: 'Stati adattati',
  REVERSE_FAILED: 'Risorse non copiate in Postgres',
});

export const FORCEABLE_CONFLICTS: readonly ConflictCode[] = ['TARGET_NEWER', 'BOTH_CHANGED', 'UNTRACKED_TARGET', 'DELETED_IN_TARGET', 'UID_AT_OTHER_HREF', 'REVALIDATION_REQUIRED'];
export const VERIFY_LEVELS: readonly VerifyLevel[] = ['V1', 'V2', 'V3', 'V4', 'V5'];
export const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

export const RUN_KIND_LABELS: Readonly<Record<MigrationRunKind, string>> = Object.freeze({
  preflight: 'Preflight',
  init: 'Inizializzazione',
  archive: 'Archivio Fase 0',
  identity: 'Riassegnazione d\'identità',
  inventory: 'Inventario',
  plan: 'Anteprima',
  apply: 'Apply',
  verify: 'Verifica',
  cutover: 'Passaggio',
  rollback_preview: 'Anteprima del rollback',
  rollback: 'Rollback',
  rebaseline: 'Ri-baseline',
  finalize: 'Chiusura finestra',
});

export const RUN_STATUS_LABELS: Readonly<Record<MigrationRunStatus, string>> = Object.freeze({
  queued: 'In coda',
  running: 'In corso',
  succeeded: 'Riuscito',
  failed: 'Fallito',
  cancelled: 'Annullato',
  interrupted: 'Interrotto',
});

export const RUN_TRIGGER_LABELS: Readonly<Record<MigrationRunTrigger, string>> = Object.freeze({
  admin: 'admin',
  schedule: 'programmato',
  shadow: 'attivazione shadow',
  restore: 'dopo un ripristino',
  system: 'sistema',
});

export const STEP_STATUS_LABELS: Readonly<Record<WizardStepStatus, string>> = Object.freeze({
  locked: 'Bloccato',
  todo: 'Da fare',
  running: 'In corso',
  done: 'Completato',
  attention: 'Da guardare',
  blocked: 'Bloccante',
  disabled: 'Non disponibile',
});

export const ACTION_LABELS: Readonly<Record<PlanAction, string>> = Object.freeze({
  create: 'Crea',
  update: 'Aggiorna',
  delete: 'Elimina',
  noop: 'Invariato',
  adopt: 'Adotta',
  skip: 'Salta',
  conflict: 'Conflitto',
});

export const OUTCOME_LABELS: Readonly<Record<ApplyOutcome, string>> = Object.freeze({
  done: 'Scritto',
  adopted: 'Adottato',
  noop: 'Invariato',
  skipped: 'Saltato',
  conflict: 'Conflitto',
  failed: 'Fallito',
  forced: 'Forzato',
});

export const IDENTITY_LABELS: Readonly<Record<IdentityStatus, string>> = Object.freeze({
  ok: 'Verificata',
  uninitialized: 'Volume non inizializzato',
  mismatch: 'Diversa da Postgres',
  unverified: 'Non verificata',
});

export const COLOR_LABELS: Readonly<Record<VerifyColor, string>> = Object.freeze({ green: 'Verde', yellow: 'Giallo', red: 'Rosso' });

export const CONFLICT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TARGET_NEWER: 'Destinazione modificata fuori dallo strumento',
  BOTH_CHANGED: 'Modificati sia Postgres sia la destinazione',
  UNTRACKED_TARGET: 'Oggetto già presente e non tracciato',
  DELETED_IN_TARGET: 'Scritto e poi cancellato dalla destinazione',
  UID_AT_OTHER_HREF: 'Stesso UID a un altro indirizzo',
  COLLECTION_MISSING: 'Collezione mancante (serve "Crea collezioni mancanti")',
  REVALIDATION_REQUIRED: 'Da rivalidare dopo un ripristino o una riassegnazione',
  DERIVED_EDITED: 'Riga derivata modificata in Postgres',
});

export const SKIP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CANCELLED_MASTER: 'Master cancellato',
  UNTIL_BEFORE_DTSTART: 'UNTIL precedente all\'inizio',
  ORPHAN_DISCARDED: 'Override orfano scartato',
  BOOKING_NOT_PROJECTED: 'Prenotazione non proiettata',
  EXCLUDED_CALENDAR: 'Calendario escluso',
  INVALID_OBJECT: 'Oggetto non valido',
  DUPLICATE_HOLIDAY: 'Festività duplicata',
});

export const PREFLIGHT_CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MODE_POSTGRES: 'Modalità Postgres',
  RESTORE_GUARD: 'Guardia post-ripristino',
  RADICALE_CONFIGURED: 'Radicale configurato',
  RADICALE_REACHABLE: 'Radicale raggiungibile',
  RADICALE_VERSION: 'Versione di Radicale',
  SERVICE_LOGIN: 'Login di servizio (caldes-svc)',
  IDENTITY: 'Identità del volume',
  COLLECTIONS: 'Collezioni del piano',
  CANARY_COLLECTION: 'Collezione _canary',
  PROBE_READONLY: 'Probe in sola lettura',
  PROBE_CANARY_FORBIDDEN: 'Probe rifiutato su _canary (403)',
  VOLUME_WATCH: 'Campanello del volume',
  CONTROL_PLANE: 'Policy e heartbeat scrivibili',
  SERVICE_PUBLIC_401: 'Utenti di servizio rifiutati sull\'URL pubblico (401)',
  RESERVED_APP_PASSWORDS: 'App-password con username riservato',
  NON_CANONICAL_APP_PASSWORDS: 'App-password con username diverso',
  BACKUP_RECENT: 'Backup coordinato recente',
  SUBSCRIPTION_SYNC_IDLE: 'Nessuna sincronizzazione delle iscrizioni in corso',
  PHASE0_VOLUME: 'Volume della Fase 0',
  DST_EXCEPTIONS: 'Eccezioni DST in Postgres',
});

export const CHECK_STATUS_LABELS: Readonly<Record<PreflightCheckStatus, string>> = Object.freeze({
  pass: 'OK',
  warn: 'Avviso',
  fail: 'Fallito',
  confirm: 'Serve conferma',
  skip: 'Non applicabile',
});

export const DECLARATION_LABELS: Readonly<Record<DeclarationKey, string>> = Object.freeze({
  phase0: 'Volume della Fase 0',
  remote_mode_accepted: 'Remote mode del campanello accettata',
  public_401_verified: '401 pubblico verificato dall\'host',
  backup_verified: 'Backup verificato a mano (valido 24 ore)',
  device_matrix: 'Matrice device',
});

export const VERIFY_LEVEL_LABELS: Readonly<Record<VerifyLevel, string>> = Object.freeze({
  V1: 'Struttura (ledger ed ETag)',
  V2: 'Contenuto (fingerprint)',
  V3: 'Occorrenze',
  V4: 'Busy',
  V5: 'Feed ICS',
});

export const DIFF_CODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  LEDGER_ETAG_MISMATCH: 'ETag diverso da quello scritto',
  LEDGER_TARGET_MISSING: 'Oggetto del ledger assente',
  TARGET_UNTRACKED: 'Oggetto non tracciato nella collezione',
  LEDGER_INTENT_PENDING: 'Scrittura rimasta a metà',
  COLLECTION_MISSING: 'Collezione mancante',
  CONTENT_MISMATCH: 'Contenuto diverso dal piano',
  TARGET_UNPARSABLE: 'Oggetto non leggibile',
  PLAN_TARGET_MISSING: 'Oggetto del piano assente',
  OCCURRENCE_MISSING: 'Occorrenza mancante',
  OCCURRENCE_EXTRA: 'Occorrenza in più',
  OCCURRENCE_TIME_DIFF: 'Orario diverso',
  OCCURRENCE_STATUS_DIFF: 'Stato diverso',
  OCCURRENCE_ALLDAY_DIFF: 'Tutto il giorno diverso',
  BUSY_MISSING: 'Intervallo occupato mancante',
  BUSY_EXTRA: 'Intervallo occupato in più',
  FEED_UID_MISSING: 'UID mancante nel feed',
  FEED_UID_EXTRA: 'UID in più nel feed',
  FEED_INSTANCES_DIFF: 'Istanze del feed diverse',
});

export const EXPECTED_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ORPHAN_CONVERTED: 'Override orfano convertito in evento singolo',
  UNTIL_REALIGNED: 'UNTIL "fino al" riallineato',
  DST_REALIGNED: 'Eccezione DST riallineata',
  CANCELLED_OVERRIDE_SUPPRESSED: 'Override cancellato soppresso nel feed',
  OVERRIDE_UID_MASTER: 'Override con l\'UID del master',
  BOOKING_REGENERATED: 'Proiezione rigenerata dalla prenotazione',
  BOOKING_DRIFT: 'Proiezione non allineata alla prenotazione',
  SUBSCRIPTION_RESYNCED: 'Iscrizione risincronizzata',
  SUBSCRIPTION_BLOCKING_IMPACT: 'Impatto di "blocca disponibilità"',
  NON_PROJECTION_MOVED: 'Evento spostato fuori da Prenotazioni',
  INVALID_RRULE_SINGLE: 'RRULE non valida migrata come evento singolo',
  CANCELLED_MASTER_SKIPPED: 'Master cancellato non migrato',
  MIXED_BYDAY: 'BYDAY misto (unione RFC 5545)',
  ALLDAY_NORMALIZED: 'Tutto il giorno normalizzato',
  DUPLICATE_HOLIDAY_SKIPPED: 'Festività duplicata non migrata',
});

/** Descrizioni delle anomalie (ANOMALY_DEFINITIONS di types.ts). */
export const ANOMALY_DESCRIPTIONS: Readonly<Record<string, { severity: ItemSeverity; blocking: boolean; description: string }>> = Object.freeze({
  ORPHAN_OVERRIDE_NOT_IN_RULE: { severity: 'warning', blocking: false, description: 'Override il cui RECURRENCE-ID non appartiene più alla regola: convertito in evento singolo (default) o scartato.' },
  OVERRIDE_CALENDAR_MISMATCH: { severity: 'warning', blocking: false, description: 'Override in un calendario diverso da quello del master: migrato nell\'oggetto del master.' },
  UNTIL_ADMIN_PATTERN: { severity: 'warning', blocking: false, description: 'UNTIL salvato dall\'admin a mezzanotte UTC del giorno "fino al": riallineato a fine giornata locale (default).' },
  ALLDAY_UNTIL_DATETIME: { severity: 'warning', blocking: false, description: 'Serie tutto il giorno con UNTIL orario: scritto come DATE.' },
  ALLDAY_EXDATE_DATETIME: { severity: 'warning', blocking: false, description: 'Serie tutto il giorno con EXDATE orari: scritti come DATE.' },
  ALLDAY_AMBIGUOUS: { severity: 'warning', blocking: false, description: 'Evento tutto il giorno con orari non a mezzanotte: data calcolata con la regola +12 h.' },
  INVALID_RRULE: { severity: 'warning', blocking: false, description: 'RRULE non valida: migrato come evento singolo con X-CALDES-LEGACY-RRULE.' },
  UNTIL_BEFORE_DTSTART: { severity: 'warning', blocking: false, description: 'Serie con UNTIL precedente al DTSTART: non migrata.' },
  RADICALE_RRULE_LIMIT: { severity: 'error', blocking: false, description: 'Serie oltre il limite di occorrenze di Radicale: non migrata finché non viene corretta in PG.' },
  NON_ROME_SERIES: { severity: 'info', blocking: false, description: 'Serie di un calendario con fuso diverso da Europe/Rome: scritta in Europe/Rome come la espande il legacy.' },
  CANCELLED_MASTER: { severity: 'info', blocking: false, description: 'Master cancellato: non migrato.' },
  DST_SHIFTED_EXCEPTION: { severity: 'warning', blocking: false, description: 'EXDATE o RECURRENCE-ID con l\'ora UTC del DTSTART ma un\'ora di Roma diversa (codice precedente al fix DST): riallineato (default).' },
  MIXED_BYDAY: { severity: 'warning', blocking: false, description: 'BYDAY misto in una serie mensile o annuale: Radicale e i device mostrano l\'unione RFC 5545, il legacy l\'intersezione.' },
  DUPLICATE_HOLIDAY: { severity: 'warning', blocking: false, description: 'Più festività di sistema per la stessa data: si migra la prima.' },
  POSSIBLE_DUPLICATE: { severity: 'info', blocking: false, description: 'Evento identico a un altro (stesso calendario, titolo e orari), per esempio una copia fatta con "Duplica": migrato così com\'è.' },
  BOOKING_DRIFT: { severity: 'warning', blocking: false, description: 'Prenotazione confermata senza proiezione, proiezione senza prenotazione o orari divergenti: la proiezione si rigenera dalla prenotazione.' },
  NON_PROJECTION_IN_BOOKINGS: { severity: 'info', blocking: false, description: 'Evento manuale nel calendario Prenotazioni: resta lì (default, decisione 8) o si sposta nel calendario scelto.' },
  ICS_PULL_REFETCH: { severity: 'info', blocking: false, description: 'Iscrizione che al passaggio verrà riscaricata da capo: non copiata nel volume.' },
  SUBSCRIPTION_BLOCKING_IMPACT: { severity: 'info', blocking: false, description: 'Ore occupate e slot persi a settimana se si abilitasse "blocca disponibilità" per l\'iscrizione (decisione 5).' },
  NON_CANONICAL_APP_PASSWORD: { severity: 'info', blocking: false, description: 'App-password con username diverso dal principal: continua a funzionare, mappata sul principal canonico.' },
  RESERVED_APP_PASSWORD: { severity: 'error', blocking: true, description: 'App-password attiva con username riservato (caldes-*): va revocata dall\'admin prima di procedere.' },
  EVENTS_IN_EXCLUDED_CALENDAR: { severity: 'warning', blocking: false, description: 'Righe legacy in un calendario escluso dal piano (sidecar d\'iscrizione o archivio): non migrate.' },
  COLLECTION_NAME_INVALID: { severity: 'error', blocking: true, description: 'Calendario senza un nome di collezione valido: escluso finché non viene corretto.' },
  INVALID_OBJECT: { severity: 'error', blocking: false, description: 'Oggetto che calendar-core o Radicale rifiuterebbero: non migrato, va corretto in PG.' },
});

/** Motivi delle precondizioni (PRECONDITION_REASONS di types.ts) in italiano. */
export const PRECONDITION_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MODE_NOT_POSTGRES: 'Il backend non è in modalità Postgres',
  IDENTITY_NOT_OK: 'Identità del volume non verificata',
  IDENTITY_NOT_UNINITIALIZED: 'Il volume è già inizializzato',
  PRINCIPAL_EXISTS: 'Sul volume esiste già il principal',
  PREFLIGHT_REQUIRED: 'Serve un preflight riuscito',
  PREFLIGHT_BLOCKING: 'Ci sono controlli o anomalie bloccanti',
  COLLECTIONS_MISSING: 'Mancano collezioni del piano',
  PLAN_REQUIRED: 'Serve un\'anteprima riuscita',
  PLAN_STALE: 'L\'anteprima è troppo vecchia',
  APPLY_REQUIRED: 'Serve un apply riuscito',
  APPLY_CONFLICTS: 'L\'ultimo apply ha conflitti o fallimenti',
  VERIFY_REQUIRED: 'Serve una verifica dopo l\'ultimo apply',
  VERIFY_RED: 'La verifica ha calendari rossi o gialli non accettati',
  REVALIDATION_PENDING: 'Ci sono righe del ledger da rivalidare',
  SHADOW_ALREADY: 'Lo shadow è già attivo',
  SHADOW_DISABLED: 'Lo shadow non è attivo',
  IDENTITY_DIFF_CHANGED: 'Il diff d\'identità è cambiato: rileggilo',
  RUN_KIND_NOT_VERIFY: 'Il run non è una verifica',
  MODE_NOT_RADICALE: 'Il backend non è in modalità Radicale',
  TRANSITION_ACTIVE: 'È attiva un\'altra transizione',
  NO_ACTIVE_TRANSITION: 'Nessuna transizione attiva',
  TRANSITION_NOT_ABORTABLE: 'Oltre il passo d\'epoch la transizione non si annulla più',
  ROLLBACK_WINDOW_EXPIRED: 'La finestra di rollback è scaduta',
  FINALIZE_TOO_EARLY: 'Servono almeno 14 giorni dal passaggio',
  SHADOW_PARITY_REQUIRED: 'Serve la parità dello shadow (o una verifica dopo il rollback)',
  DEVICE_MATRIX_REQUIRED: 'Serve la matrice device superata',
  BACKUP_TOO_OLD: 'Serve un backup coordinato di meno di 2 ore',
  OPEN_CONFLICTS: 'Ci sono conflitti aperti o scritture a metà',
  REVERSE_FAILED_OPEN: 'Ci sono risorse non copiate in Postgres',
  DEAD_JOBS: 'Ci sono job del calendario in dead letter',
  HEALTH_NOT_GREEN: 'La salute del calendario non è verde',
  PREVIEW_REQUIRED: 'Serve un\'anteprima del rollback',
  PREVIEW_STALE: 'L\'anteprima del rollback è troppo vecchia',
  PROBE_UNAVAILABLE: 'Password di caldes-probe assente',
  CONTROL_PLANE_UNAVAILABLE: 'Control-plane del calendario non attivo',
  ARCHIVE_DEVICE_WRITABLE: 'L\'archivio della Fase 0 sarebbe scrivibile dai device',
});

export function isRunActive(run: Pick<MigrationRunView, 'status'> | null | undefined): boolean {
  return !!run && (run.status === 'queued' || run.status === 'running');
}

// ─── Errori ───────────────────────────────

/** Errore dell'API della migrazione con codice e dettagli (`{ error, code, details? }`). */
export class MigrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'MigrationApiError';
  }

  /** Motivi delle precondizioni tradotti (details.reasons). */
  get reasons(): string[] {
    const r = this.details?.reasons;
    return Array.isArray(r) ? r.map((x) => PRECONDITION_REASON_LABELS[String(x)] ?? String(x)) : [];
  }

  /** Run in corso per MIGRATION_BUSY (details.active_run). */
  get activeRun(): MigrationRunView | null {
    const run = this.details?.active_run;
    return run && typeof run === 'object' ? (run as MigrationRunView) : null;
  }
}

/** Messaggio leggibile di un errore qualsiasi (con i motivi delle precondizioni). */
export function migrationErrorMessage(err: unknown): string {
  if (err instanceof MigrationApiError) {
    const reasons = err.reasons;
    if (err.code === 'MIGRATION_BUSY') {
      const active = err.activeRun;
      return active ? `È in corso un run (${RUN_KIND_LABELS[active.kind] ?? active.kind}): attendi che finisca o annullalo` : err.message;
    }
    if (err.code === 'TRANSITION_IN_PROGRESS') return err.message;
    return reasons.length ? `${err.message} (${reasons.join('; ')})` : err.message;
  }
  return err instanceof Error ? err.message : 'Errore inatteso';
}

// ─── Trasporto ───────────────────────────────

function isAuthRedirectExempt(): boolean {
  const path = window.location.pathname;
  return path === '/login' || path === '/setup' || path.startsWith('/firma/');
}

async function migrationFetch(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const locale = getStoredAdminLocale();
  headers.set('Accept-Language', toIntlLocale(locale));
  headers.set('X-Admin-Locale', locale);
  const res = await fetch(`${API_BASE}${BASE}${path}`, { ...init, headers, credentials: 'include' });
  if (res.ok) {
    sessionState.lastActivity = Date.now();
    return res;
  }
  if (res.status === 401 && retryAuth && !isAuthRedirectExempt()) {
    if (await refreshAdminSession()) return migrationFetch(path, init, false);
  }
  if (res.status === 401 && !isAuthRedirectExempt()) {
    const back = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(back)}`);
  }
  let body: { error?: unknown; code?: unknown; details?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    /* corpo non JSON (es. 413 del proxy) */
  }
  const message = typeof body.error === 'string' && body.error
    ? body.error
    : res.status === 413 ? 'File troppo grande' : `Errore HTTP ${res.status}`;
  const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details) ? (body.details as Record<string, unknown>) : null;
  throw new MigrationApiError(message, res.status, typeof body.code === 'string' ? body.code : null, details);
}

async function getJson<T>(path: string): Promise<T> {
  return (await migrationFetch(path)).json() as Promise<T>;
}

async function sendJson<T>(method: 'POST' | 'PATCH', path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return (await migrationFetch(path, { method, body: JSON.stringify(body ?? {}), headers })).json() as Promise<T>;
}

/** Chiave d'idempotenza nuova (una per azione: riusata se l'utente riprova la stessa richiesta). */
export function newIdempotencyKey(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `wizard-${uuid}`;
}

// ─── Endpoint ───────────────────────────────

export interface RunItemsQuery {
  item_type?: MigrationItemType;
  code?: string;
  calendar_id?: string;
  action?: PlanAction;
  outcome?: ApplyOutcome;
  level?: VerifyLevel;
  expected?: boolean;
  severity?: ItemSeverity;
  cursor?: string | null;
  limit?: number;
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const migrationApi = {
  state: () => getJson<MigrationStateView>('/state'),
  identity: () => getJson<IdentityDiffView>('/identity'),
  parity: () => getJson<ParityView>('/parity'),
  subscriptions: () => getJson<{ subscriptions: SubscriptionMigrationView[] }>('/subscriptions'),
  runs: (q: { kind?: MigrationRunKind; status?: MigrationRunStatus; limit?: number; cursor?: string | null } = {}) =>
    getJson<RunsListResponse>(`/runs${query(q)}`),
  run: <S = Record<string, unknown>>(id: string) => getJson<MigrationRunView<S>>(`/runs/${encodeURIComponent(id)}`),
  runItems: (id: string, q: RunItemsQuery = {}) => getJson<RunItemsResponse>(`/runs/${encodeURIComponent(id)}/items${query({ ...q })}`),

  preflight: (body: { probe_public_url?: boolean }, key?: string) => sendJson<RunCreatedResponse>('POST', '/preflight', body, key),
  init: (body: { action: 'initialize' | 'create_missing'; confirm: string }, key: string) => sendJson<RunCreatedResponse>('POST', '/init', body, key),
  identityReassign: (
    body: { direction: 'volume_to_pg' | 'pg_to_volume'; confirm: string; expected: { pg_volume_id: string | null; pg_epoch: number; marker_volume_id: string | null; marker_epoch: number | null } },
    key: string,
  ) => sendJson<RunCreatedResponse>('POST', '/identity/reassign', body, key),
  declare: <K extends DeclarationKey>(body: { key: K; value: DeclarationValues[K]; confirm?: string }) =>
    sendJson<{ declarations: MigrationDeclarations }>('POST', '/declarations', body),
  inventory: (body: { scope?: MigrationScope }, key?: string) => sendJson<RunCreatedResponse>('POST', '/inventory', body, key),
  plan: (body: { scope?: MigrationScope; options?: Partial<MigrationOptions> }, key?: string) => sendJson<RunCreatedResponse>('POST', '/plan', body, key),
  apply: (
    body: { plan_run_id: string; expect_plan_hash?: string | null; force_item_ids?: string[]; force_codes?: ConflictCode[]; confirm: string; confirm_force?: string },
    key: string,
  ) => sendJson<RunCreatedResponse>('POST', '/apply', body, key),
  verify: (body: { scope?: MigrationScope; levels?: VerifyLevel[]; v4_days?: number }, key?: string) => sendJson<RunCreatedResponse>('POST', '/verify', body, key),
  accept: (runId: string, body: { item_ids?: string[]; calendar_id?: string; all_expected?: boolean; confirm: string }) =>
    sendJson<AcceptDiffsResponse>('POST', `/runs/${encodeURIComponent(runId)}/accept`, body),
  cancel: (runId: string) => sendJson<{ run: MigrationRunView }>('POST', `/runs/${encodeURIComponent(runId)}/cancel`, {}),
  shadow: (body: { enabled: boolean; confirm?: string }) => sendJson<ShadowStateResponse>('POST', '/shadow', body),
  subscriptionFlags: (id: string, body: { blocks_availability?: boolean; device_visible?: boolean }) =>
    sendJson<SubscriptionFlagsResponse>('PATCH', `/subscriptions/${encodeURIComponent(id)}`, body),

  // F4: transizioni (contratto f4-modules §6.1).
  transition: () => getJson<TransitionView | null>('/transition'),
  reverse: () => getJson<ReverseProjectionHealthView>('/reverse'),
  cutover: (body: { confirm: string; rollback_window_days?: number; verify_run_id?: string | null }, key: string) =>
    sendJson<RunCreatedResponse>('POST', '/cutover', body, key),
  cutoverAbort: (body: { confirm: string }, key: string) => sendJson<RunCreatedResponse>('POST', '/cutover/abort', body, key),
  rollbackAbort: (body: { confirm: string }, key: string) => sendJson<RunCreatedResponse>('POST', '/rollback/abort', body, key),
  transitionResume: (body: { confirm: string }, key: string) => sendJson<RunCreatedResponse>('POST', '/transition/resume', body, key),
  rollbackPreview: (body: { scope?: MigrationScope }, key?: string) => sendJson<RunCreatedResponse>('POST', '/rollback/preview', body, key),
  rollback: (
    body: { preview_run_id: string; expect_preview_hash?: string | null; confirm: string; emergency?: boolean; confirm_emergency?: string },
    key: string,
  ) => sendJson<RunCreatedResponse>('POST', '/rollback', body, key),
  finalize: (body: { confirm: string }, key: string) => sendJson<RunCreatedResponse>('POST', '/finalize', body, key),
  rebaseline: (body: { scope?: MigrationScope; confirm: string }, key: string) => sendJson<RunCreatedResponse>('POST', '/rebaseline', body, key),

  /** Export v2 del calendario: zip con un .ics per collezione e manifest.json (GET /api/backup/export?format=calendar-v2). */
  downloadCalendarExportV2: async (): Promise<void> => {
    // Stesso flusso di refresh del JWT di apiFetch; un 409 (mode postgres) arriva come errore con il messaggio dell'API.
    const res = await apiFetchRaw('/api/backup/export?format=calendar-v2');
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? `calendario-export-v2-${new Date().toISOString().slice(0, 10)}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  },

  /** Archivio della Fase 0 (multipart: file e conferma). */
  archive: async (file: File, confirm: string, key: string): Promise<RunCreatedResponse> => {
    const fd = new FormData();
    fd.set('file', file);
    fd.set('confirm', confirm);
    const res = await migrationFetch('/phase0/archive', { method: 'POST', body: fd, headers: { 'Idempotency-Key': key } });
    return res.json() as Promise<RunCreatedResponse>;
  },

  /** Scarica il report di un run (JSON o CSV) e lo salva con il nome proposto dall'API. */
  downloadReport: async (runId: string, format: 'json' | 'csv'): Promise<void> => {
    const res = await migrationFetch(`/runs/${encodeURIComponent(runId)}/report${query({ format })}`);
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? `migrazione-${runId}.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  },
};

// ─── Formattazione ───────────────────────────────

const DATE_TIME = new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Rome' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? DATE_TIME.format(d) : '—';
}

/** "3 min fa", "2 h fa", "ieri"... */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s fa`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h fa`;
  return `${Math.round(h / 24)} giorni fa`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 12)}…` : '—';
}

/** Azione di un passo del wizard per id. */
export function findAction(step: WizardStepView | undefined, id: WizardActionId): WizardAction | undefined {
  return step?.actions.find((a) => a.id === id);
}

/** Chiavi di TanStack Query della pagina (invalidate tutte con ['calendar-migration']). */
export const migrationKeys = {
  all: ['calendar-migration'] as const,
  state: ['calendar-migration', 'state'] as const,
  run: (id: string | null) => ['calendar-migration', 'run', id] as const,
  items: (id: string | null, q: RunItemsQuery) => ['calendar-migration', 'items', id, q] as const,
  identity: ['calendar-migration', 'identity'] as const,
  parity: ['calendar-migration', 'parity'] as const,
  subscriptions: ['calendar-migration', 'subscriptions'] as const,
  runs: (kind: MigrationRunKind | null) => ['calendar-migration', 'runs', kind] as const,
  transition: ['calendar-migration', 'transition'] as const,
};

/** Giorni interi fra adesso e un istante (0 se passato). */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - now) / 86_400_000)) : 0;
}
