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
