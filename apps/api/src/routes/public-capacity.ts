import { Hono } from 'hono';
import { sql } from '../db';

export const publicCapacity = new Hono();

type CapacityStatus = 'available' | 'last_slot' | 'full';

type StudioSettingsRow = {
  value: {
    /** Limite reale di accettazione clienti — uso interno, dashboard, alert. */
    max_clients_per_month?: number | null;
    /** Override cosmetico del max mostrato pubblicamente. Se null/undefined usa max_clients_per_month. */
    displayed_max_clients?: number | null;
    /** Offset di slot "già occupati" precaricato per scarcity marketing. Default 0. */
    phantom_used_clients?: number | null;
  } | null;
};

type CapacityCountRow = {
  used: number;
};

const DEFAULT_MAX_CLIENTS_PER_MONTH = 3;
// Default "vetrina": il badge mostra "2/6" anche senza clienti reali, dando
// l'impressione di studio già attivo ma con margine ("4 posti liberi").
// Override esplicito a 0 dalla pagina Impostazioni per disabilitare l'effetto.
const DEFAULT_DISPLAYED_MAX_CLIENTS = 6;
const DEFAULT_PHANTOM_USED_CLIENTS = 2;
const ITALIAN_MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
] as const;

function safeNonNegInt(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback;
  return Math.trunc(raw);
}

function getCapacityStatus(used: number, max: number): CapacityStatus {
  if (max === 0 || used >= max) return 'full';
  if (max > 1 && used === max - 1) return 'last_slot';
  return 'available';
}

/**
 * Restituisce il "primo mese disponibile" partendo da Europe/Rome `now`.
 * `monthsAhead` consente di rotolare avanti: 1 = prossimo mese, 2 = mese dopo, etc.
 * Cap conservativo a 12 per evitare anni futuri irrealistici dovuti a config rotte.
 */
function getNextAvailableMonth(monthsAhead = 1): string {
  const ahead = Math.max(1, Math.min(12, monthsAhead));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());

  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  // Mesi 1-based. Sommo ahead, normalizzo modulo 12.
  const total = month - 1 + ahead;
  const nextMonth = (total % 12) + 1;
  const nextYear = year + Math.floor(total / 12);

  return `${ITALIAN_MONTHS[nextMonth - 1]} ${nextYear}`;
}

publicCapacity.get('/', async (c) => {
  try {
    const settingsRows = (await sql`
      SELECT value
      FROM site_settings
      WHERE key = 'freelancer.studio'
      LIMIT 1
    `) as StudioSettingsRow[];

    const countRows = (await sql`
      SELECT COUNT(*)::int AS used
      FROM customers
      WHERE created_at >= date_trunc('month', now())
    `) as CapacityCountRow[];

    const realUsed = countRows[0]?.used ?? 0;
    const settings = settingsRows[0]?.value;

    // Pubblico vs interno:
    //  - max_clients_per_month è il LIMITE REALE (usato anche dal dashboard capacity).
    //    È la sola fonte di verità per "sono pieno o no": se è raggiunto, forziamo 'full'
    //    a prescindere dai numeri di facciata. Così non si rischia mai di sembrare
    //    disponibili quando operativamente non lo si è.
    //  - displayed_max_clients sovrascrive solo il numero MOSTRATO nel badge ("vetrina"):
    //    consente di esibire "X/6" anche se l'asticella reale è 3.
    //  - phantom_used_clients è un OFFSET di slot pre-occupati che si somma al conteggio
    //    reale per dare un'impressione di scarsità senza falsi positivi: man mano che
    //    arrivano clienti veri, il badge si avvicina davvero al "pieno".
    //
    // Rollover prossimo mese:
    //  - se il vero limite è già saturato, il messaggio "Pieno fino a..." indica
    //    `Math.ceil(realUsed / realMax)` mesi avanti (così con realUsed=2*realMax si
    //    sta già prenotando per due mesi avanti).
    const realMax = safeNonNegInt(settings?.max_clients_per_month, DEFAULT_MAX_CLIENTS_PER_MONTH);
    const displayedMax = safeNonNegInt(settings?.displayed_max_clients, DEFAULT_DISPLAYED_MAX_CLIENTS);
    const phantomUsed = safeNonNegInt(settings?.phantom_used_clients, DEFAULT_PHANTOM_USED_CLIENTS);

    const displayedUsed = Math.min(realUsed + phantomUsed, displayedMax);
    const realFull = realMax > 0 && realUsed >= realMax;
    const status: CapacityStatus = realFull
      ? 'full'
      : getCapacityStatus(displayedUsed, displayedMax);

    // Esempi: realMax=3 → realUsed 3→+1, 4→+2, 6→+2, 7→+3 (Math.ceil(used/max)).
    const monthsAhead = realFull && realMax > 0
      ? Math.max(1, Math.ceil(realUsed / realMax))
      : 1;
    const nextAvailableMonth = getNextAvailableMonth(monthsAhead);

    // Quando realFull ma il displayed non è ancora saturo, mostro 'pieno' visivamente:
    // il numero `used` deve raggiungere `max` per coerenza con `status='full'`.
    const usedForUi = realFull ? displayedMax : displayedUsed;

    c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
    return c.json({ used: usedForUi, max: displayedMax, status, nextAvailableMonth });
  } catch (err) {
    console.error('[public-capacity] error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
