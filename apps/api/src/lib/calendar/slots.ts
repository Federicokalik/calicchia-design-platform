/**
 * Slot calculator.
 *
 * Algoritmo:
 * 1) Carica event_type + schedule + slots ricorrenti + overrides.
 * 2) Espande in finestre di disponibilità UTC (DST-aware via date-fns-tz).
 * 3) Carica bookings esistenti (status confirmed) nel range.
 * 4) Carica busy times Google (se connesso).
 * 5) Per ogni finestra, sottrae intervalli busy (booking + buffer + google) e
 *    genera slot a step `slot_increment_minutes` di durata `duration_minutes`.
 * 6) Filtra slot futuri rispettando `min_notice_hours` (clamp a now+min_notice).
 * 7) Rimuove duplicati e ordina.
 *
 * Nota buffer: il buffer è considerato come "tempo morto attorno a un booking esistente",
 * quindi blocca slot che cadrebbero entro buffer dal booking. Il buffer NON estende gli
 * slot generati (uno slot ha sempre durata = duration_minutes esatti, non duration+buffer).
 */

import { sql } from '../../db';
import {
  buildAvailabilityWindows,
  enumerateDates,
  loadScheduleForEventType,
  getEventType,
} from './availability';
import { getLocalBusyRanges } from './local-busy';
import type { EventType, Slot } from './types';

interface Range {
  start: number; // ms UTC
  end: number;   // ms UTC
}

function toMs(iso: string): number { return new Date(iso).getTime(); }
function fromMs(ms: number): string { return new Date(ms).toISOString(); }

/**
 * Sottrae da `windows` la lista `busy` mantenendo gli intervalli liberi.
 * Tutti in millisecondi UTC.
 */
function subtractBusy(windows: Range[], busy: Range[]): Range[] {
  if (!busy.length) return windows.slice();

  // Merge busy overlapping/adjacent
  const sorted = busy.slice().sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  const out: Range[] = [];
  for (const w of windows) {
    let cursor = w.start;
    for (const b of merged) {
      if (b.end <= cursor || b.start >= w.end) continue;
      if (b.start > cursor) {
        out.push({ start: cursor, end: Math.min(b.start, w.end) });
      }
      cursor = Math.max(cursor, b.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out.filter((r) => r.end > r.start);
}

/**
 * Genera slot di durata `durationMs` ad incremento `incrementMs` allineati alla
 * partenza di ciascuna finestra libera. Lo slot deve fittare interamente.
 */
function generateSlots(freeRanges: Range[], durationMs: number, incrementMs: number): Range[] {
  const slots: Range[] = [];
  for (const r of freeRanges) {
    let t = r.start;
    while (t + durationMs <= r.end) {
      slots.push({ start: t, end: t + durationMs });
      t += incrementMs;
    }
  }
  return slots;
}

export interface ComputeSlotsInput {
  eventTypeIdOrSlug: string;
  /** Data locale (YYYY-MM-DD) inclusiva nel timezone dello schedule */
  fromDateLocal: string;
  /** Data locale (YYYY-MM-DD) inclusiva nel timezone dello schedule */
  toDateLocal: string;
  /** Esclude busy Google se false (default true se connesso) */
  includeGoogleBusy?: boolean;
  /** Per route pubbliche: true → solo event types public+active */
  onlyPublic?: boolean;
}

export interface ComputeSlotsResult {
  eventType: EventType;
  timezone: string;
  /** Slot raggruppati per data locale dello schedule */
  slotsByDate: Record<string, Slot[]>;
  /** Lista piatta ordinata per start UTC */
  slots: Slot[];
}

export async function computeAvailableSlots(input: ComputeSlotsInput): Promise<ComputeSlotsResult | null> {
  const eventType = await getEventType(input.eventTypeIdOrSlug, { onlyPublic: input.onlyPublic === true });
  if (!eventType) return null;

  const sched = await loadScheduleForEventType(eventType);
  if (!sched) {
    return { eventType, timezone: 'Europe/Rome', slotsByDate: {}, slots: [] };
  }

  // 1. Finestre di disponibilità sul range
  const windows = buildAvailabilityWindows({
    schedule: sched.schedule,
    slots: sched.slots,
    overrides: sched.overrides,
    fromDateLocal: input.fromDateLocal,
    toDateLocal: input.toDateLocal,
  });

  if (!windows.length) {
    return { eventType, timezone: sched.schedule.timezone, slotsByDate: {}, slots: [] };
  }

  // Range complessivo per query bookings + google
  const overallStart = Math.min(...windows.map((w) => toMs(w.startUtc)));
  const overallEnd = Math.max(...windows.map((w) => toMs(w.endUtc)));

  // 2. Bookings esistenti
  const bookings = await sql<{ start_time: string; end_time: string }[]>`
    SELECT start_time, end_time FROM calendar_bookings
    WHERE status = 'confirmed'
      AND end_time   > ${new Date(overallStart).toISOString()}
      AND start_time < ${new Date(overallEnd).toISOString()}
  `;

  // 3. Busy locali da calendar_events (sostituisce Google Calendar)
  //    NB: quando un booking viene confermato, viene auto-creato anche un calendar_event
  //    nel calendario 'bookings' — quindi i busy includono già automaticamente i bookings.
  //    Li teniamo separati anche per applicare buffer_before/after specifici dell'event type.
  const localBusy = input.includeGoogleBusy === false
    ? []
    : await getLocalBusyRanges(new Date(overallStart).toISOString(), new Date(overallEnd).toISOString());

  // 4. Costruisci array busy con buffer applicato ai bookings
  const bufBeforeMs = eventType.buffer_before_minutes * 60_000;
  const bufAfterMs  = eventType.buffer_after_minutes  * 60_000;

  const busyRanges: Range[] = [
    ...bookings.map((b) => ({
      start: toMs(b.start_time) - bufAfterMs,    // un booking esistente blocca da (start - buffer_after del NUOVO slot)
      end:   toMs(b.end_time)   + bufBeforeMs,   // a (end + buffer_before del NUOVO slot)
    })),
    ...localBusy.map((g) => ({ start: toMs(g.start), end: toMs(g.end) })),
  ];

  // 5. Sottrai busy dalle finestre
  const freeRanges = subtractBusy(
    windows.map((w) => ({ start: toMs(w.startUtc), end: toMs(w.endUtc) })),
    busyRanges
  );

  // 6. Filtra per min_notice + max_advance
  const now = Date.now();
  const minStart = now + eventType.min_notice_hours * 60 * 60 * 1000;
  const maxStart = now + eventType.max_advance_days * 24 * 60 * 60 * 1000;

  const clamped: Range[] = [];
  for (const r of freeRanges) {
    const s = Math.max(r.start, minStart);
    const e = Math.min(r.end, maxStart);
    if (e > s) clamped.push({ start: s, end: e });
  }

  // 7. Genera slot
  const durationMs = eventType.duration_minutes * 60_000;
  const incrementMs = eventType.slot_increment_minutes * 60_000;
  const slotRanges = generateSlots(clamped, durationMs, incrementMs);

  // Allinea slot all'inizio dei minuti round (clamp di min_notice produce start non rotondi)
  const aligned = slotRanges
    .map((r) => {
      const remainder = r.start % incrementMs;
      const aligned = remainder === 0 ? r.start : r.start + (incrementMs - remainder);
      return { start: aligned, end: aligned + durationMs };
    })
    .filter((r, _i, arr) => arr.length > 0 && r.end <= maxStart);

  // Riapplica busy check post-allineamento + dedup
  const finalSlots = subtractAlignedSlots(aligned, busyRanges, freeRanges);

  // Convert
  const slotsList: Slot[] = finalSlots
    .map((r) => ({ start: fromMs(r.start), end: fromMs(r.end) }))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Raggruppa per data nel timezone
  const tz = sched.schedule.timezone;
  const slotsByDate: Record<string, Slot[]> = {};
  for (const dl of enumerateDates(input.fromDateLocal, input.toDateLocal)) {
    slotsByDate[dl] = [];
  }
  const localDateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const slot of slotsList) {
    const dateLocal = localDateFmt.format(new Date(slot.start));
    if (!slotsByDate[dateLocal]) slotsByDate[dateLocal] = [];
    slotsByDate[dateLocal].push(slot);
  }

  return { eventType, timezone: tz, slotsByDate, slots: slotsList };
}

/** Filtra slot allineati che a causa del clamp/realign potrebbero ricadere in busy. */
function subtractAlignedSlots(slots: Range[], busy: Range[], free: Range[]): Range[] {
  if (!slots.length) return [];
  const merged = busy.slice().sort((a, b) => a.start - b.start);
  return slots.filter((s) => {
    // Deve essere interamente dentro una finestra libera
    const insideFree = free.some((f) => s.start >= f.start && s.end <= f.end);
    if (!insideFree) return false;
    // Non deve overlappare nessun busy
    return !merged.some((b) => b.end > s.start && b.start < s.end);
  });
}
