/**
 * LEGACY READER per i bookings storici Cal.com.
 *
 * Il sistema booking è stato migrato a /api/calendar (cal.diy self-hosted).
 * Questo modulo espone solo lettura sui dati storici in `cal_bookings` per
 * il merger admin (calendario.tsx mostra Cal.com bookings con prefisso "[Cal.com]").
 *
 * Quando i bookings storici non saranno più necessari, sia questo file che
 * la tabella `cal_bookings` (migrations 023) potranno essere rimossi.
 */

import { Hono } from 'hono';
import { sql } from '../db';

export const calcom = new Hono();

calcom.get('/bookings', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const afterStart = c.req.query('after_start');
  const beforeEnd = c.req.query('before_end');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;
  const searchFilter = search
    ? sql`AND (attendee_name ILIKE ${'%' + search + '%'} OR attendee_email ILIKE ${'%' + search + '%'} OR title ILIKE ${'%' + search + '%'})`
    : sql``;
  const afterFilter = afterStart ? sql`AND start_time >= ${afterStart}` : sql``;
  const beforeFilter = beforeEnd ? sql`AND start_time <= ${beforeEnd}` : sql``;

  const [bookings, allBookings] = await Promise.all([
    sql`
      SELECT *, COUNT(*) OVER() AS _total_count
      FROM cal_bookings
      WHERE 1=1 ${statusFilter} ${searchFilter} ${afterFilter} ${beforeFilter}
      ORDER BY start_time DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`SELECT status FROM cal_bookings`,
  ]);

  const count = bookings[0]?._total_count ? parseInt(bookings[0]._total_count as string) : 0;
  const cleaned = bookings.map((b) => ({ ...b, _total_count: undefined }));

  const stats = {
    total: allBookings.length,
    upcoming: allBookings.filter((b) => b.status === 'upcoming').length,
    past: allBookings.filter((b) => b.status === 'past').length,
    cancelled: allBookings.filter((b) => b.status === 'cancelled').length,
    unconfirmed: allBookings.filter((b) => b.status === 'unconfirmed').length,
  };

  return c.json({ bookings: cleaned, count, stats, lastSync: null });
});

calcom.get('/bookings/:uid', async (c) => {
  const [booking] = await sql`SELECT * FROM cal_bookings WHERE booking_uid = ${c.req.param('uid')}`;
  if (!booking) return c.json({ error: 'Appuntamento non trovato' }, 404);
  return c.json({ booking });
});

calcom.post('/sync', (c) => {
  return c.json({
    error: 'Endpoint deprecato. Il sistema booking è stato migrato a /api/calendar (cal.diy). I dati storici Cal.com restano accessibili in sola lettura.',
  }, 410);
});
