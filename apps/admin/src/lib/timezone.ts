/**
 * Calendar timezone helpers.
 *
 * Il calendario opera interamente in Europe/Rome a prescindere dal timezone
 * del browser (schedule, eventi e prenotazioni sono definiti nel fuso dello
 * studio). Questi helper convertono tra ISO UTC e wall-time Europe/Rome per
 * gli <input type="datetime-local"> e per le finestre-giorno, senza dipendere
 * dal fuso locale del client.
 */
export const CALENDAR_TZ = 'Europe/Rome';

/** Offset (ms) di Europe/Rome rispetto a UTC all'istante `ts`. */
function tzOffsetMs(ts: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CALENDAR_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - ts;
}

/** ISO UTC → valore per <input type="datetime-local"> come wall-time Europe/Rome. */
export function isoToZonedInput(iso: string): string {
  const ts = new Date(iso).getTime();
  return new Date(ts + tzOffsetMs(ts)).toISOString().slice(0, 16);
}

/**
 * Valore <input type="datetime-local"> (wall-time Europe/Rome) → ISO UTC.
 * Risoluzione dell'offset a due passaggi per i bordi DST (ora ambigua o
 * inesistente al cambio ora: viene scelto un istante valido adiacente).
 */
export function zonedInputToIso(input: string): string {
  const base = input.length === 16 ? `${input}:00` : input;
  const wall = Date.parse(`${base}Z`);
  let ts = wall - tzOffsetMs(wall);
  const secondPass = wall - tzOffsetMs(ts);
  if (secondPass !== ts) ts = secondPass;
  return new Date(ts).toISOString();
}

/** Finestra [startIso, endIso) del giorno Europe/Rome che contiene `d`. */
export function zonedDayWindow(d: Date = new Date()): { dateLocal: string; startIso: string; endIso: string } {
  const dateLocal = new Intl.DateTimeFormat('en-CA', { timeZone: CALENDAR_TZ }).format(d);
  const [y, m, day] = dateLocal.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
  return {
    dateLocal,
    startIso: zonedInputToIso(`${dateLocal}T00:00`),
    endIso: zonedInputToIso(`${next}T00:00`),
  };
}

/** ISO UTC → wall-time Europe/Rome con i secondi ('YYYY-MM-DDTHH:mm:ss'). */
export function isoToZonedWall(iso: string): string {
  const ts = new Date(iso).getTime();
  return new Date(ts + tzOffsetMs(ts)).toISOString().slice(0, 19);
}

/** Giorno Europe/Rome ('YYYY-MM-DD') che contiene l'istante `iso`. */
export function isoToZonedDate(iso: string): string {
  return isoToZonedWall(iso).slice(0, 10);
}

/** Data 'YYYY-MM-DD' spostata di `days` giorni di calendario. */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Mezzanotte Europe/Rome del giorno 'YYYY-MM-DD' come ISO UTC (inizio, o fine esclusiva, di un all-day). */
export function zonedDateToIso(date: string): string {
  return zonedInputToIso(`${date}T00:00`);
}

/**
 * Istante UTC delle 23:59:59 Europe/Rome del giorno 'YYYY-MM-DD': l'UNTIL di
 * una serie "fino al giorno X" comprende tutte le occorrenze di quel giorno
 * locale (la mezzanotte UTC escludeva quelle del mattino in Italia).
 */
export function zonedEndOfDayIso(date: string): string {
  return zonedInputToIso(`${date}T23:59:59`);
}

// ─── FullCalendar in Europe/Rome senza plugin di fuso ───────────────────────
//
// FullCalendar gira con timeZone 'UTC' e riceve gli istanti già convertiti in
// wall-time di Roma "etichettato" come UTC: la griglia mostra l'ora di Roma a
// prescindere dal fuso del browser. Le date che FullCalendar restituisce
// (selezione, trascinamento, ridimensionamento, intervallo visibile) hanno nei
// campi UTC il wall-time di Roma e si riconvertono in istanti veri con
// calendarDateToIso.

/** Istante UTC → data per FullCalendar (timeZone 'UTC'): wall-time di Roma, o il solo giorno per gli all-day. */
export function isoToCalendarDate(iso: string, allDay = false): string {
  const wall = isoToZonedWall(iso);
  return allDay ? wall.slice(0, 10) : `${wall}Z`;
}

/**
 * Fine esclusiva di un all-day per FullCalendar: giorno di Roma della fine,
 * mai uguale o precedente all'inizio (una fine alle 23:59 dello stesso giorno o
 * a mezzanotte UTC vale comunque un giorno intero).
 */
export function isoToCalendarAllDayEnd(startIso: string, endIso: string): string {
  const start = isoToZonedDate(startIso);
  const end = isoToZonedDate(endIso);
  return end > start ? end : addDaysToDate(start, 1);
}

/** Data restituita da FullCalendar con timeZone 'UTC' (wall-time di Roma) → istante ISO UTC. */
export function calendarDateToIso(d: Date): string {
  return zonedInputToIso(d.toISOString().slice(0, 19));
}

/** Giorno ('YYYY-MM-DD') di una data restituita da FullCalendar con timeZone 'UTC'. */
export function calendarDateToDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
