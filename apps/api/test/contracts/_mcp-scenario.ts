/**
 * Scenario deterministico per il contratto MCP dei tool di calendario.
 *
 * Settimana sotto test: lunedì 29 marzo – domenica 4 aprile 2027, subito dopo
 * il passaggio all'ora legale (domenica 28 marzo 2027): le serie iniziate a
 * marzo cambiano offset UTC a metà, come in produzione. "Adesso" è martedì 30
 * marzo 2027, 07:00 a Roma.
 *
 * Contenuto (tutto creato con le fixture di helpers/fixtures.ts):
 *  - calendari: 'lavoro' (bloccante), 'personale' ed 'esterno' (non
 *    bloccanti), 'f' con Pasqua e Pasquetta 2027 (festività del cron) e una
 *    chiusura "Ponte", più il calendario seminato 'bookings';
 *  - eventi singoli (confermato, tentative, annullato), all-day con ancora
 *    Roma e UTC, un evento con UID a forma di UUID (come quelli di Apple);
 *  - serie 'Standup' lun-ven dal 22 marzo con EXDATE, override modificato,
 *    override cancellato e due eccezioni "DST_SHIFTED" (design §13.4): un
 *    EXDATE e un override salvati con l'ora UTC del DTSTART, come faceva il
 *    codice precedente a d046006;
 *  - serie 'Palestra' settimanale nel calendario non bloccante;
 *  - fuori dalla settimana, nel calendario non bloccante: una serie oraria
 *    con più occorrenze del tetto di expandRRule (500 per serie e per query)
 *    e una serie con location e url il cui override spostato li eredita;
 *  - iscrizione ICS con un evento timed e un all-day a mezzanotte UTC;
 *  - nel calendario 'bookings': la proiezione di una prenotazione confermata
 *    e un evento manuale (decisione 8);
 *  - tipi di prenotazione pubblici (uno con buffer asimmetrici), privati e
 *    inattivi; prenotazioni confermata, in attesa e annullata, più una in
 *    attesa e una annullata "oggi" fuori dall'orario d'ufficio (non tolgono
 *    slot) e una confermata il 15 aprile per il verso dei buffer.
 *
 * I dati dei casi di scrittura (prenotazioni da spostare o annullare, eventi
 * da modificare o eliminare) li crea ogni test nelle settimane successive,
 * così i casi di lettura non dipendono da quelli di scrittura.
 */

import assert from 'node:assert/strict';
import { getBookingsCalendar } from '../../src/lib/calendar/calendars';
import type { Calendar, CalendarEvent, EventType } from '../../src/lib/calendar/types';
import { isRadicaleBackend } from '../helpers/calendar-backend';
import { storeEventRows, storeOverrideRows, storeProjectionRows } from '../helpers/calendar-rows';
import { SEED_CALENDAR_SLUGS, sql } from '../helpers/db';
import {
  OFFICE_HOURS,
  romeIso,
  utcMidnightIso,
  type BookingFixture,
  type Fixtures,
  type SeriesFixture,
} from '../helpers/fixtures';
import { createNormalizer, type SnapshotNormalizer } from '../helpers/normalize';

// ─── Tempo ───────────────────────────────

/** "Adesso": martedì 30 marzo 2027, 07:00 a Roma (ora legale). */
export const NOW = '2027-03-30T05:00:00.000Z';
/** Lunedì di Pasquetta 2027 alle 08:00 di Roma, per il caso del giorno festivo. */
export const HOLIDAY_NOW = '2027-03-29T06:00:00.000Z';
/** Settimana sotto test, dalla mezzanotte di Roma di lunedì 29 marzo a quella di lunedì 5 aprile. */
export const WEEK_FROM = romeIso('2027-03-29');
export const WEEK_TO = romeIso('2027-04-05');

/**
 * Eccezioni con la firma del codice precedente al fix DST: stessa ora UTC del
 * DTSTART della serie (08:00Z, le 09:00 di marzo in ora solare) ma, dopo il
 * cambio d'ora, un'ora locale diversa (10:00 invece di 09:00). Oggi non
 * combaciano con l'occorrenza: l'EXDATE non la sopprime e l'override diventa
 * orfano. La correzione in PG di F0 le riallinea (allowed-diffs, punto 5).
 */
export const DST_SHIFTED_EXDATE = '2027-04-01T08:00:00.000Z';
export const DST_SHIFTED_OVERRIDE_START = '2027-03-29T08:00:00.000Z';

/**
 * Le stesse due eccezioni riallineate sulla griglia della serie (09:00 di
 * Roma, 07:00Z dopo il cambio d'ora), come le scrive la migrazione con
 * l'anomalia DST_SHIFTED_EXCEPTION (design §13.4, riallineamento attivo di
 * default). Con lo store Radicale lo scenario usa queste: RadicaleStore non
 * crea un override fuori regola (409, design §8 "niente nuovi orfani") e i dati
 * migrati arrivano già riallineati (allowed-diffs, punto 5).
 */
export const REALIGNED_EXDATE = '2027-04-01T07:00:00.000Z';
export const REALIGNED_OVERRIDE_START = '2027-03-29T07:00:00.000Z';

/** Eccezioni della serie 'Standup' dello scenario per lo store sotto test. */
export const STANDUP_EXCEPTIONS = isRadicaleBackend()
  ? { exdate: REALIGNED_EXDATE, overrideStart: REALIGNED_OVERRIDE_START }
  : { exdate: DST_SHIFTED_EXDATE, overrideStart: DST_SHIFTED_OVERRIDE_START };

/** UID con forma di UUID (maiuscolo, come quelli generati da Apple Calendar). */
export const UUID_SHAPED_UID = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';

/** Occorrenze della serie oraria 'Promemoria orario' (COUNT della RRULE). */
export const PROMEMORIA_COUNT = 600;
/** Tetto di occorrenze per serie e per query di expandRRule (default di `limit`). */
export const PROMEMORIA_LIMIT = 500;

// ─── Alias per gli snapshot ───────────────────────────────

/**
 * Nomi leggibili per id, uid e token noti: `<ev:riunione>` invece di `<id:7>`.
 * Valgono per tutti i normalizzatori creati dopo la registrazione.
 */
export class AliasRegistry {
  private readonly entries = new Map<string, string>();

  add(value: string | null | undefined, label: string): void {
    if (!value) return;
    // Il normalizzatore confronta gli UUID in minuscolo.
    const key = /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : value;
    const existing = this.entries.get(key);
    if (existing && existing !== label) throw new Error(`Alias in conflitto per ${value}: ${existing} / ${label}`);
    this.entries.set(key, label);
  }

  /** Evento: id → `ev:<key>`, uid → `uid:<key>`. */
  event(key: string, event: Pick<CalendarEvent, 'id' | 'uid'>): void {
    this.add(event.id, `ev:${key}`);
    this.add(event.uid, `uid:${key}`);
  }

  /** Prenotazione: uid pubblico → `bk:<key>`, più la proiezione se c'è. */
  booking(key: string, fixture: BookingFixture): void {
    this.add(fixture.booking.uid, `bk:${key}`);
    if (fixture.projection) this.event(`proiezione-${key}`, fixture.projection);
  }

  /**
   * Serie: master più override con le chiavi indicate (nello stesso ordine).
   * Con lo store Radicale un override ha l'UID del master (RFC 5545, design
   * §12 differenza ammessa 1): il suo uid resta con l'alias del master.
   */
  series(key: string, series: SeriesFixture, overrideKeys: string[] = []): void {
    this.event(key, series.master);
    series.overrides.forEach((ov, i) => {
      const overrideKey = overrideKeys[i] ?? `${key}-override-${i + 1}`;
      if (ov.uid === series.master.uid) this.add(ov.id, `ev:${overrideKey}`);
      else this.event(overrideKey, ov);
    });
  }

  apply(normalizer: SnapshotNormalizer): SnapshotNormalizer {
    for (const [value, label] of this.entries) normalizer.alias(value, label);
    return normalizer;
  }
}

/**
 * Normalizzatore per un caso: prefisso del gruppo → `<prefix>`, alias
 * registrati, id e token del feed di tutti i calendari presenti (i seminati
 * hanno token casuali generati dalla migrazione, quindi diversi per database).
 */
export async function createScenarioNormalizer(fx: Fixtures, registry: AliasRegistry): Promise<SnapshotNormalizer> {
  const n = registry.apply(createNormalizer({ prefixes: [fx.prefix] }));
  const calendars = await sql<Array<{ id: string; slug: string; ics_feed_token: string }>>`
    SELECT id, slug, ics_feed_token FROM calendars
  `;
  const seeds = new Set<string>(SEED_CALENDAR_SLUGS);
  for (const c of calendars) {
    const label = c.slug.startsWith(`${fx.prefix}-`)
      ? c.slug.slice(fx.prefix.length + 1)
      : seeds.has(c.slug) ? `seed-${c.slug}` : c.slug;
    n.alias(c.id, `cal:${label}`);
    n.alias(c.ics_feed_token, `feed:${label}`);
  }
  return n;
}

// ─── Scenario di base ───────────────────────────────

export interface BaseScenario {
  calendars: {
    lavoro: Calendar;
    personale: Calendar;
    esterno: Calendar;
    festivita: Calendar;
    bookings: Calendar;
  };
  events: {
    riunione: CalendarEvent;
    forse: CalendarEvent;
    annullato: CalendarEvent;
    trasferta: CalendarEvent;
    compleanno: CalendarEvent;
    uidUuid: CalendarEvent;
    telefonata: CalendarEvent;
    ponte: CalendarEvent;
    pasqua: CalendarEvent;
    pasquetta: CalendarEvent;
    webinar: CalendarEvent;
    fiera: CalendarEvent;
  };
  series: {
    standup: SeriesFixture;
    palestra: SeriesFixture;
    promemoria: SeriesFixture;
    corso: SeriesFixture;
  };
  eventTypes: {
    consulenza: EventType;
    sopralluogo: EventType;
    privato: EventType;
    archiviato: EventType;
    asimmetrico: EventType;
  };
  bookings: {
    confermata: BookingFixture;
    inAttesa: BookingFixture;
    annullata: BookingFixture;
    inAttesaOggi: BookingFixture;
    annullataOggi: BookingFixture;
    bufferAsimmetrico: BookingFixture;
  };
}

/** Crea lo scenario di base e ne registra gli alias. Richiede la baseline del calendario. */
export async function createBaseScenario(fx: Fixtures, registry: AliasRegistry): Promise<BaseScenario> {
  // Calendari. Nomi con iniziale maiuscola dopo il prefisso: l'ordine di
  // list_calendars (sort_order, name) è lo stesso con collation C ed en_US.
  const lavoro = await fx.calendar({ key: 'lavoro', name: 'Lavoro', color: '#7c3aed' });
  const personale = await fx.calendar({ key: 'personale', name: 'Personale', color: '#ec4899', blocks_availability: false });
  const esterno = await fx.calendar({ key: 'esterno', name: 'Esterno', color: '#64748b', blocks_availability: false });
  const festivita = await fx.holidayCalendar();
  const bookings = await getBookingsCalendar();
  assert.ok(bookings, "calendario seminato 'bookings' assente");

  // Festività come le crea il cron (Pasqua attraversa il cambio d'ora: 23 ore) e una chiusura.
  const holidays = await fx.holidays(festivita, { year: 2027, only: ['2027-03-28', '2027-03-29'] });
  const pasqua = holidays.find((h) => h.source_id === 'it-holiday-2027-03-28');
  const pasquetta = holidays.find((h) => h.source_id === 'it-holiday-2027-03-29');
  assert.ok(pasqua && pasquetta, 'festività di Pasqua 2027 non create');
  const ponte = await fx.closure(festivita, { from: '2027-04-02', summary: 'Ponte' });

  // Serie lun-ven alle 09:00 di Roma dal 22 marzo (08:00Z), dopo il 28 marzo alle 07:00Z.
  const standup = await fx.series({
    calendar: lavoro,
    summary: 'Standup',
    description: 'Allineamento quotidiano',
    start_time: romeIso('2027-03-22', '09:00'),
    end_time: romeIso('2027-03-22', '09:15'),
    rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=10',
    exdates: [romeIso('2027-03-24', '09:00'), STANDUP_EXCEPTIONS.exdate],
    overrides: [
      { originalStart: romeIso('2027-03-30', '09:00'), start: romeIso('2027-03-30', '09:30'), end: romeIso('2027-03-30', '09:45'), summary: 'Standup posticipato' },
      { originalStart: romeIso('2027-03-31', '09:00'), status: 'cancelled' },
      { originalStart: STANDUP_EXCEPTIONS.overrideStart, start: romeIso('2027-03-29', '12:00') },
    ],
  });
  const palestra = await fx.series({
    calendar: personale,
    summary: 'Palestra',
    start_time: romeIso('2027-03-23', '18:00'),
    end_time: romeIso('2027-03-23', '19:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6',
  });
  // Serie oraria da 600 occorrenze dal 7 giugno: una query che le copre tutte
  // ne restituisce solo PROMEMORIA_LIMIT (tetto di expandRRule, per serie e per query).
  const promemoria = await fx.series({
    calendar: personale,
    summary: 'Promemoria orario',
    start_time: romeIso('2027-06-07', '00:00'),
    end_time: romeIso('2027-06-07', '00:05'),
    rrule: `FREQ=HOURLY;COUNT=${PROMEMORIA_COUNT}`,
  });
  // Serie con location e url: l'override spostato (createOccurrenceOverride,
  // come "solo questa" in admin) li copia dal master.
  const corso = await fx.series({
    calendar: personale,
    summary: 'Corso serale',
    location: 'Via Garibaldi 5, Frosinone',
    url: 'https://meet.caldes.test/corso',
    start_time: romeIso('2027-07-05', '18:00'),
    end_time: romeIso('2027-07-05', '19:30'),
    rrule: 'FREQ=WEEKLY;COUNT=3',
    overrides: [{ originalStart: romeIso('2027-07-12', '18:00'), start: romeIso('2027-07-13', '18:00'), end: romeIso('2027-07-13', '19:30') }],
  });

  const riunione = await fx.event({
    calendar: lavoro,
    summary: 'Riunione cliente',
    description: 'Ordine del giorno: preventivo',
    location: 'Via Roma 1, Frosinone',
    url: 'https://meet.caldes.test/riunione',
    start_time: romeIso('2027-03-30', '10:00'),
    end_time: romeIso('2027-03-30', '11:00'),
  });
  const forse = await fx.event({
    calendar: lavoro, summary: 'Call da confermare', status: 'tentative',
    start_time: romeIso('2027-03-31', '15:00'), end_time: romeIso('2027-03-31', '16:00'),
  });
  const annullato = await fx.event({
    calendar: lavoro, summary: 'Incontro annullato', status: 'cancelled',
    start_time: romeIso('2027-03-31', '11:00'), end_time: romeIso('2027-03-31', '12:00'),
  });
  const trasferta = await fx.allDayEvent({ calendar: lavoro, summary: 'Trasferta', date: '2027-04-01' });
  const compleanno = await fx.allDayEvent({ calendar: personale, summary: 'Compleanno', date: '2027-03-31' });
  const uidUuid = await fx.event({
    calendar: lavoro, summary: 'Importato da Apple', uid: UUID_SHAPED_UID,
    start_time: romeIso('2027-04-01', '16:00'), end_time: romeIso('2027-04-01', '17:00'),
  });
  // Evento non di prenotazione nel calendario 'bookings' (decisione 8).
  const telefonata = await fx.event({
    calendar: bookings, summary: 'Telefonata fornitore', source: 'manual',
    start_time: romeIso('2027-03-30', '16:30'), end_time: romeIso('2027-03-30', '17:00'),
  });

  // Iscrizione ICS (eventi già "parsati": parseIcs oggi scarta tutto, design §14).
  const subscription = await fx.subscription({
    calendar: esterno,
    name: 'Google',
    events: [
      {
        remote_uid: 'webinar-1@example.test', summary: fx.name('Webinar esterno'),
        description: null, location: null, url: 'https://webinar.example.test/1',
        start_time: '2027-03-30T12:00:00.000Z', end_time: '2027-03-30T13:00:00.000Z',
        all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed',
      },
      {
        remote_uid: 'fiera-1@example.test', summary: fx.name('Fiera esterna'),
        description: null, location: 'Fiera di Roma', url: null,
        start_time: utcMidnightIso('2027-04-01'), end_time: utcMidnightIso('2027-04-02'),
        all_day: true, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed',
      },
    ],
  });
  const webinar = subscription.events.find((e) => e.source_id === 'webinar-1@example.test');
  const fiera = subscription.events.find((e) => e.source_id === 'fiera-1@example.test');
  assert.ok(webinar && fiera, "eventi dell'iscrizione non importati");

  // Tipi di prenotazione: pubblico su schedule dedicato, con buffer, privato
  // (schedule di default) e inattivo. sort_order 0: precedono i seminati.
  const schedule = await fx.schedule({ name: 'Ufficio', slots: OFFICE_HOURS });
  const consulenza = await fx.eventType({
    key: 'consulenza', title: 'Consulenza', description: 'Prima consulenza online',
    durationMinutes: 60, slotIncrementMinutes: 60, schedule,
  });
  const sopralluogo = await fx.eventType({
    key: 'sopralluogo', title: 'Sopralluogo', durationMinutes: 60, slotIncrementMinutes: 30,
    bufferBeforeMinutes: 30, bufferAfterMinutes: 30, locationType: 'in_person',
    locationValue: 'Sede del cliente', color: '#0ea5e9', schedule,
  });
  const privato = await fx.eventType({ key: 'privato', title: 'Riservato', durationMinutes: 45, slotIncrementMinutes: 15, isPublic: false });
  const archiviato = await fx.eventType({ key: 'archiviato', title: 'Archiviato', isActive: false });
  // Buffer diversi prima (15) e dopo (45): il verso dei buffer si vede negli slot.
  const asimmetrico = await fx.eventType({
    key: 'buffer-asimmetrici', title: 'Buffer asimmetrici', durationMinutes: 30, slotIncrementMinutes: 15,
    bufferBeforeMinutes: 15, bufferAfterMinutes: 45, schedule,
  });

  const confermata = await fx.booking({
    eventType: consulenza,
    start: romeIso('2027-03-30', '15:00'),
    attendee: {
      name: 'Mario Rossi', email: fx.email('mario'), phone: '+39 333 0000001',
      company: 'Rossi SRL', message: 'Vorrei un preventivo per il sito',
    },
  });
  const inAttesa = await fx.booking({
    eventType: consulenza, start: romeIso('2027-04-01', '11:00'), status: 'pending',
    attendee: { name: 'Anna Neri', email: fx.email('anna') },
  });
  const annullata = await fx.booking({
    eventType: sopralluogo, start: romeIso('2027-03-31', '09:00'), status: 'cancelled',
    cancelledBy: 'attendee', cancellationReason: 'Cliente indisponibile',
    attendee: { name: 'Paolo Gialli', email: fx.email('paolo') },
  });
  // Oggi, prima e dopo l'orario d'ufficio (anche con i buffer 30/30 del
  // sopralluogo non toccano le finestre 09-13 e 14-18): get_calendar_today
  // mostra la pending ed esclude l'annullata.
  const inAttesaOggi = await fx.booking({
    eventType: consulenza, start: romeIso('2027-03-30', '07:00'), status: 'pending',
    attendee: { name: 'Lucia Bruni', email: fx.email('lucia') },
  });
  const annullataOggi = await fx.booking({
    eventType: consulenza, start: romeIso('2027-03-30', '19:00'), status: 'cancelled',
    cancelledBy: 'admin', cancellationReason: 'Spostata a voce',
    attendee: { name: 'Marco Celeste', email: fx.email('marco') },
  });
  // Giovedì 15 aprile, 11:00-11:30: ostacolo per gli slot del tipo con buffer asimmetrici.
  const bufferAsimmetrico = await fx.booking({
    eventType: asimmetrico, start: romeIso('2027-04-15', '11:00'),
    attendee: { name: 'Rita Ocra', email: fx.email('rita') },
  });

  const events = { riunione, forse, annullato, trasferta, compleanno, uidUuid, telefonata, ponte, pasqua, pasquetta, webinar, fiera };
  for (const [key, event] of Object.entries(events)) registry.event(key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`), event);
  registry.series('standup', standup, ['standup-posticipato', 'standup-annullato', 'standup-orfano']);
  registry.series('palestra', palestra);
  registry.series('promemoria', promemoria);
  registry.series('corso', corso, ['corso-spostato']);
  registry.booking('confermata', confermata);
  registry.booking('in-attesa', inAttesa);
  registry.booking('annullata', annullata);
  registry.booking('in-attesa-oggi', inAttesaOggi);
  registry.booking('annullata-oggi', annullataOggi);
  registry.booking('buffer-asimmetrico', bufferAsimmetrico);

  return {
    calendars: { lavoro, personale, esterno, festivita, bookings },
    events,
    series: { standup, palestra, promemoria, corso },
    eventTypes: { consulenza, sopralluogo, privato, archiviato, asimmetrico },
    bookings: { confermata, inAttesa, annullata, inAttesaOggi, annullataOggi, bufferAsimmetrico },
  };
}

// ─── Stato del database per gli effetti dei casi di scrittura ───────────────────────────────

/** Prenotazione e sue proiezioni (tutte, anche cancellate) come le vedono admin e feed. */
export async function bookingState(uid: string): Promise<{ booking: Record<string, unknown> | null; projections: Record<string, unknown>[] }> {
  const [booking] = await sql<Array<Record<string, unknown>>>`
    SELECT b.uid, et.slug AS event_type_slug, b.status, b.source, b.source_metadata,
           b.attendee_name, b.attendee_email, b.attendee_phone, b.attendee_company,
           b.attendee_timezone, b.attendee_message, b.start_time, b.end_time,
           b.location_type, b.location_value, b.cancelled_by, b.cancellation_reason,
           b.rescheduled_from_uid
    FROM calendar_bookings b
    JOIN calendar_event_types et ON et.id = b.event_type_id
    WHERE b.uid = ${uid}
  `;
  // Store Radicale: la risorsa booking-<uid>.ics letta dalla facade (helpers/calendar-rows.ts).
  const projections = isRadicaleBackend()
    ? await storeProjectionRows([uid], ['calendar', 'id', 'summary', 'description', 'location', 'url', 'start_time', 'end_time', 'all_day', 'source', 'source_id', 'status'])
    : await sql<Array<Record<string, unknown>>>`
      SELECT c.slug AS calendar, e.id, e.summary, e.description, e.location, e.url,
             e.start_time, e.end_time, e.all_day, e.source, e.source_id, e.status
      FROM calendar_events e
      JOIN calendars c ON c.id = e.calendar_id
      WHERE e.source = 'booking' AND e.source_id = ${uid}
      ORDER BY e.start_time, e.status
    `;
  return { booking: booking ?? null, projections: [...projections] };
}

/** Righe di calendar_events per id (assenti = cancellate fisicamente), nell'ordine richiesto. */
export async function eventRows(ids: string[]): Promise<Array<Record<string, unknown>>> {
  if (isRadicaleBackend()) {
    return storeEventRows(ids, ['calendar', 'id', 'uid', 'summary', 'description', 'location', 'url', 'start_time', 'end_time',
      'all_day', 'rrule', 'exdates', 'recurrence_id', 'recurrence_master_id', 'source', 'source_id', 'status']);
  }
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT c.slug AS calendar, e.id, e.uid, e.summary, e.description, e.location, e.url,
           e.start_time, e.end_time, e.all_day, e.rrule, e.exdates, e.recurrence_id,
           e.recurrence_master_id, e.source, e.source_id, e.status
    FROM calendar_events e
    JOIN calendars c ON c.id = e.calendar_id
    WHERE e.id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return ids.map((id) => byId.get(id) ?? { id, deleted: true });
}

/** Override di una serie (righe con recurrence_master_id), ordinati per recurrence_id. */
export async function overrideRows(masterId: string): Promise<Array<Record<string, unknown>>> {
  if (isRadicaleBackend()) return storeOverrideRows(masterId, ['id', 'summary', 'start_time', 'end_time', 'recurrence_id', 'status']);
  return [...await sql<Array<Record<string, unknown>>>`
    SELECT id, summary, start_time, end_time, recurrence_id, status
    FROM calendar_events
    WHERE recurrence_master_id = ${masterId}::uuid
    ORDER BY recurrence_id
  `];
}

/** Calendario creato da create_calendar, con le colonne che decidono il comportamento. */
export async function calendarRow(id: string): Promise<Record<string, unknown> | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    SELECT id, slug, name, description, color, icon, timezone, is_default, is_system,
           blocks_availability, ics_feed_enabled, sort_order
    FROM calendars WHERE id = ${id}::uuid
  `;
  return row ?? null;
}
