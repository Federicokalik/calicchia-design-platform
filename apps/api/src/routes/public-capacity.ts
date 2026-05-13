import { Hono } from 'hono';
import { sql } from '../db';

export const publicCapacity = new Hono();

type CapacityStatus = 'available' | 'last_slot' | 'full';

type StudioSettingsRow = {
  value: {
    max_clients_per_month?: number | null;
  } | null;
};

type CapacityCountRow = {
  used: number;
};

const DEFAULT_MAX_CLIENTS_PER_MONTH = 3;
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

function parseMaxClients(value: StudioSettingsRow['value'] | undefined): number {
  const raw = value?.max_clients_per_month;

  if (raw === null || raw === undefined) {
    return DEFAULT_MAX_CLIENTS_PER_MONTH;
  }

  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_MAX_CLIENTS_PER_MONTH;
  }

  return Math.trunc(raw);
}

function getCapacityStatus(used: number, max: number): CapacityStatus {
  if (max === 0 || used >= max) return 'full';
  if (max > 1 && used === max - 1) return 'last_slot';
  return 'available';
}

function getNextAvailableMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());

  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

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

    const used = countRows[0]?.used ?? 0;
    const max = parseMaxClients(settingsRows[0]?.value);
    const status = getCapacityStatus(used, max);
    const nextAvailableMonth = getNextAvailableMonth();

    c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
    return c.json({ used, max, status, nextAvailableMonth });
  } catch (err) {
    console.error('[public-capacity] error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
