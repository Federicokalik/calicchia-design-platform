/**
 * Id persistenti degli oggetti di calendario (fase F2, modulo SYNC
 * radicale/ids.ts; design §5 "Gli id" e "getEvent"; contratto dei moduli
 * f2-modules.md §2.2 e §4.6). Solo database, senza Radicale.
 *
 * Allocazione nell'ordine del contratto (riga esistente riattivata, MOVE
 * entro 30 giorni, X-CALDES-LEGACY-ID libero, UUID v4 o uuidv5 con la
 * strategia deterministica), ritiro di risorse e override, prenotazione (F3) e
 * resolver di getEvent in quattro passi.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { onDatabaseReady, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import type { Calendar } from '../../src/lib/calendar/types';
import type { Db } from '../../src/lib/calendar/radicale/policy';
import {
  allocateObjectIds,
  deterministicObjectId,
  ObjectIdConflictError,
  reserveObjectId,
  resolveEventRef,
  retireObjectIds,
  retireOverrideIds,
  uuidV5,
} from '../../src/lib/calendar/radicale/ids';

const fx = useFixtures('sync-ids', { resetBaseline: true });
const cal: Record<string, Calendar> = {};
const DAY = 86_400_000;

onDatabaseReady(async () => {
  for (const key of ['a', 'b', 'c', 'sub', 'feste']) cal[key] = await fx.calendar({ key });
  await sql`UPDATE calendars SET role = 'subscription' WHERE id = ${cal.sub.id}`;
  await sql`UPDATE calendars SET role = 'holidays' WHERE id = ${cal.feste.id}`;
});

/** Esegue `fn` in una transazione (come l'indicizzatore) e restituisce il risultato. */
function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin((tx: any) => fn(tx)) as Promise<T>;
}

async function row(id: string): Promise<{ calendar_id: string; href: string; recurrence_key: string; uid: string | null; legacy_event_id: string | null; legacy_uid: string | null; retired_at: Date | null } | undefined> {
  const [r] = await sql<Array<{ calendar_id: string; href: string; recurrence_key: string; uid: string | null; legacy_event_id: string | null; legacy_uid: string | null; retired_at: Date | null }>>`
    SELECT calendar_id, href, recurrence_key, uid, legacy_event_id, legacy_uid, retired_at FROM cal_object_ids WHERE id = ${id}
  `;
  return r;
}

test('uuidV5: vettore di riferimento RFC 9562 e id deterministici stabili per (UID, chiave)', () => {
  // Namespace DNS dell'RFC, nome www.example.com.
  assert.equal(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  const a = deterministicObjectId('uid-1', '');
  assert.equal(a, deterministicObjectId('uid-1', ''));
  assert.notEqual(a, deterministicObjectId('uid-1', '20270104T080000Z'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('allocazione: riga nuova, poi la stessa a ogni giro; override con id propri e chiave \'\' = risorsa', async () => {
  const now = new Date();
  const first = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [
    { href: 'serie.ics', uid: 'uid-serie', overrideKeys: ['20270105T080000Z', '20270106'] },
    { href: 'singolo.ics', uid: 'uid-singolo', overrideKeys: [] },
  ], { now }));
  const serie = first.get('serie.ics');
  assert.ok(serie);
  assert.equal(serie.movedFrom, null);
  assert.equal(serie.componentIds.get(''), serie.objectId);
  assert.equal(serie.componentIds.size, 3);
  assert.notEqual(serie.componentIds.get('20270105T080000Z'), serie.objectId);
  assert.equal((await row(serie.objectId))?.uid, 'uid-serie');

  const again = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [
    { href: 'serie.ics', uid: 'uid-serie', overrideKeys: ['20270105T080000Z', '20270107'] },
  ], { now }));
  const serie2 = again.get('serie.ics');
  assert.equal(serie2?.objectId, serie.objectId);
  assert.equal(serie2?.componentIds.get('20270105T080000Z'), serie.componentIds.get('20270105T080000Z'));
  assert.ok(serie2?.componentIds.get('20270107'));
  assert.equal(serie2?.componentIds.has('20270106'), false, 'solo le chiavi richieste');
});

test('ritiro e ricomparsa: stesso id per la risorsa e per gli override; gli override non più presenti si ritirano', async () => {
  const now = new Date();
  const ids = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'r.ics', uid: 'uid-r', overrideKeys: ['20270108T080000Z'] }], { now }));
  const r = ids.get('r.ics');
  assert.ok(r);
  const override = r.componentIds.get('20270108T080000Z') as string;

  await inTx((tx) => retireOverrideIds(tx, cal.a.id, 'r.ics', [], now));
  assert.ok((await row(override))?.retired_at, 'override non più nel set: ritirato');
  assert.equal((await row(r.objectId))?.retired_at, null, 'la risorsa resta attiva');

  await inTx((tx) => retireObjectIds(tx, cal.a.id, ['r.ics'], now));
  assert.ok((await row(r.objectId))?.retired_at);

  const back = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'r.ics', uid: 'uid-r', overrideKeys: ['20270108T080000Z'] }], { now }));
  assert.equal(back.get('r.ics')?.objectId, r.objectId);
  assert.equal(back.get('r.ics')?.componentIds.get('20270108T080000Z'), override);
  assert.equal((await row(r.objectId))?.retired_at, null, 'riattivata');
  assert.equal((await row(override))?.retired_at, null);
});

test('MOVE: UID ritirato altrove da meno di 30 giorni → stesso id ri-chiavato (con gli override); oltre 30 giorni o da un\'iscrizione → id nuovo', async () => {
  const now = new Date();
  const src = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'mv.ics', uid: 'uid-mv', overrideKeys: ['20270109T080000Z'] }], { now }));
  const original = src.get('mv.ics');
  assert.ok(original);
  await inTx((tx) => retireObjectIds(tx, cal.a.id, ['mv.ics'], now));

  const moved = await inTx((tx) => allocateObjectIds(tx, cal.b.id, [{ href: 'arrivato.ics', uid: 'uid-mv', overrideKeys: ['20270109T080000Z'] }], { now }));
  const m = moved.get('arrivato.ics');
  assert.equal(m?.objectId, original.objectId, 'stesso id dopo il MOVE');
  assert.deepEqual(m?.movedFrom, { calendarId: cal.a.id, href: 'mv.ics' });
  assert.equal(m?.componentIds.get('20270109T080000Z'), original.componentIds.get('20270109T080000Z'), 'gli override seguono la risorsa');
  assert.deepEqual(await row(original.objectId).then((r) => [r?.calendar_id, r?.href, r?.retired_at]), [cal.b.id, 'arrivato.ics', null]);

  // Ritirato da più di 30 giorni: nessuna adozione.
  const old = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'vecchio.ics', uid: 'uid-vecchio', overrideKeys: [] }], { now }));
  await inTx((tx) => retireObjectIds(tx, cal.a.id, ['vecchio.ics'], new Date(now.getTime() - 31 * DAY)));
  const late = await inTx((tx) => allocateObjectIds(tx, cal.b.id, [{ href: 'vecchio.ics', uid: 'uid-vecchio', overrideKeys: [] }], { now }));
  assert.notEqual(late.get('vecchio.ics')?.objectId, old.get('vecchio.ics')?.objectId);
  assert.equal(late.get('vecchio.ics')?.movedFrom, null);

  // Da un'iscrizione (fonte remota) a un calendario proprio: id nuovo.
  const feed = await inTx((tx) => allocateObjectIds(tx, cal.sub.id, [{ href: 'r-feed.ics', uid: 'uid-feed', overrideKeys: [] }], { now }));
  await inTx((tx) => retireObjectIds(tx, cal.sub.id, ['r-feed.ics'], now));
  const copy = await inTx((tx) => allocateObjectIds(tx, cal.c.id, [{ href: 'copia.ics', uid: 'uid-feed', overrideKeys: [] }], { now }));
  assert.notEqual(copy.get('copia.ics')?.objectId, feed.get('r-feed.ics')?.objectId);
});

test('X-CALDES-LEGACY-ID libero → id e legacy_event_id = quello; già usato → UUID nuovo', async () => {
  const now = new Date();
  const legacy = randomUUID();
  const first = await inTx((tx) => allocateObjectIds(tx, cal.c.id, [{ href: 'mig.ics', uid: 'uid-mig', overrideKeys: [], legacyId: legacy.toUpperCase() }], { now }));
  assert.equal(first.get('mig.ics')?.objectId, legacy);
  assert.equal((await row(legacy))?.legacy_event_id, legacy);

  // Una copia con la stessa X-prop (es. "Duplica" su un device) non prende lo stesso id.
  const dup = await inTx((tx) => allocateObjectIds(tx, cal.c.id, [{ href: 'mig-copia.ics', uid: 'uid-mig-copia', overrideKeys: [], legacyId: legacy }], { now }));
  assert.notEqual(dup.get('mig-copia.ics')?.objectId, legacy);
});

test('strategia deterministica: stessi id ricostruendo da zero; lo stesso UID in due collezioni riceve id diversi', async () => {
  const now = new Date();
  const items = [{ href: 'det.ics', uid: 'uid-det', overrideKeys: ['20270110T080000Z'] }];
  const one = await inTx((tx) => allocateObjectIds(tx, cal.c.id, items, { now, idStrategy: 'deterministic' }));
  assert.equal(one.get('det.ics')?.objectId, deterministicObjectId('uid-det', ''));
  assert.equal(one.get('det.ics')?.componentIds.get('20270110T080000Z'), deterministicObjectId('uid-det', '20270110T080000Z'));

  // Tabella degli id "persa" (scenario B): si ricostruisce e gli id tornano uguali.
  await sql`DELETE FROM cal_object_ids WHERE calendar_id = ${cal.c.id} AND href = 'det.ics'`;
  const rebuilt = await inTx((tx) => allocateObjectIds(tx, cal.c.id, items, { now, idStrategy: 'deterministic' }));
  assert.equal(rebuilt.get('det.ics')?.objectId, one.get('det.ics')?.objectId);

  // Invito duplicato in un'altra collezione: l'uuidv5 di base è occupato, si usa quello qualificato dalla posizione.
  const other = await inTx((tx) => allocateObjectIds(tx, cal.b.id, [{ href: 'det.ics', uid: 'uid-det', overrideKeys: [] }], { now, idStrategy: 'deterministic' }));
  const otherId = other.get('det.ics')?.objectId;
  assert.ok(otherId);
  assert.notEqual(otherId, one.get('det.ics')?.objectId);
  assert.equal(otherId, uuidV5(`uid-det||${cal.b.id}/det.ics`));
});

test('reserveObjectId: prenota, ritrova senza sovrascrivere, completa i campi vuoti; id già usato → ObjectIdConflictError', async () => {
  const wanted = randomUUID();
  const id = await inTx((tx) => reserveObjectId(tx, { calendarId: cal.feste.id, href: 'booking-abc.ics', id: wanted, legacyEventId: wanted }));
  assert.equal(id, wanted);
  const again = await inTx((tx) => reserveObjectId(tx, { calendarId: cal.feste.id, href: 'booking-abc.ics', id: randomUUID(), uid: 'abc@caldes.it', legacyUid: 'abc' }));
  assert.equal(again, wanted, 'la riga esistente vince');
  const r = await row(wanted);
  assert.deepEqual([r?.uid, r?.legacy_uid, r?.legacy_event_id], ['abc@caldes.it', 'abc', wanted]);

  await assert.rejects(
    inTx((tx) => reserveObjectId(tx, { calendarId: cal.feste.id, href: 'altro.ics', id: wanted })),
    (err: unknown) => err instanceof ObjectIdConflictError && err.id === wanted,
  );
});

test('resolveEventRef: id e id di override, legacy_event_id, UID (preferendo le collezioni scrivibili), ambiguità, legacy_uid, @dominio', async () => {
  const now = new Date();
  const a = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'res.ics', uid: 'uid-res', overrideKeys: ['20270111T080000Z'] }], { now }));
  const res = a.get('res.ics');
  assert.ok(res);
  const overrideId = res.componentIds.get('20270111T080000Z') as string;

  assert.deepEqual(await resolveEventRef(sql, res.objectId), { kind: 'found', id: res.objectId, objectId: res.objectId, calendarId: cal.a.id, href: 'res.ics', recurrenceKey: '' });
  assert.deepEqual(await resolveEventRef(sql, overrideId.toUpperCase()), { kind: 'found', id: overrideId, objectId: res.objectId, calendarId: cal.a.id, href: 'res.ics', recurrenceKey: '20270111T080000Z' });
  assert.equal((await resolveEventRef(sql, 'uid-res')).kind, 'found');

  // Stesso UID in una collezione in sola lettura per i device e in un'iscrizione: vince quella scrivibile.
  await inTx((tx) => allocateObjectIds(tx, cal.feste.id, [{ href: 'res-feste.ics', uid: 'uid-pref', overrideKeys: [] }], { now }));
  await inTx((tx) => allocateObjectIds(tx, cal.sub.id, [{ href: 'r-pref.ics', uid: 'uid-pref', overrideKeys: [] }], { now }));
  const pref = await resolveEventRef(sql, 'uid-pref');
  assert.equal(pref.kind === 'found' && pref.calendarId, cal.feste.id);
  const writable = await inTx((tx) => allocateObjectIds(tx, cal.b.id, [{ href: 'pref.ics', uid: 'uid-pref', overrideKeys: [] }], { now }));
  const best = await resolveEventRef(sql, 'uid-pref');
  assert.equal(best.kind === 'found' && best.id, writable.get('pref.ics')?.objectId);

  // Invito duplicato in due collezioni scrivibili: ambiguo, con i candidati.
  await inTx((tx) => allocateObjectIds(tx, cal.c.id, [{ href: 'pref-2.ics', uid: 'uid-pref', overrideKeys: [] }], { now }));
  const amb = await resolveEventRef(sql, 'uid-pref');
  assert.equal(amb.kind, 'ambiguous');
  assert.equal(amb.kind === 'ambiguous' && amb.candidates.length, 4);
  assert.deepEqual(amb.kind === 'ambiguous' && amb.candidates.slice(0, 2).map((c) => c.calendarId).sort(), [cal.b.id, cal.c.id].sort());

  // Un UID con la forma di un UUID si cerca anche come UID (bug legacy, design §14).
  const uuidUid = randomUUID();
  const u = await inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'uuid-uid.ics', uid: uuidUid, overrideKeys: [] }], { now }));
  const byUuidUid = await resolveEventRef(sql, uuidUid);
  assert.equal(byUuidUid.kind === 'found' && byUuidUid.id, u.get('uuid-uid.ics')?.objectId);

  // legacy_event_id, legacy_uid e UID con o senza @dominio.
  const legacyEvent = randomUUID();
  const proj = await inTx((tx) => reserveObjectId(tx, { calendarId: cal.feste.id, href: 'booking-xyz.ics', uid: 'xyz@caldes.it', legacyUid: 'legacy-xyz', legacyEventId: legacyEvent }));
  const byLegacyEvent = await resolveEventRef(sql, legacyEvent);
  assert.equal(byLegacyEvent.kind === 'found' && byLegacyEvent.id, proj);
  const byLegacyUid = await resolveEventRef(sql, 'legacy-xyz');
  assert.equal(byLegacyUid.kind === 'found' && byLegacyUid.id, proj);
  const withoutDomain = await resolveEventRef(sql, 'xyz');
  assert.equal(withoutDomain.kind === 'found' && withoutDomain.id, proj);
  const withDomain = await resolveEventRef(sql, 'uid-res@altro.dominio');
  assert.equal(withDomain.kind === 'found' && withDomain.id, res.objectId);

  // Ritirati e sconosciuti: non trovati.
  await inTx((tx) => retireObjectIds(tx, cal.a.id, ['res.ics'], now));
  assert.deepEqual(await resolveEventRef(sql, res.objectId), { kind: 'not_found' });
  assert.deepEqual(await resolveEventRef(sql, 'uid-inesistente'), { kind: 'not_found' });
  assert.deepEqual(await resolveEventRef(sql, ''), { kind: 'not_found' });
  assert.deepEqual(await resolveEventRef(sql, '50%_x'), { kind: 'not_found' }, 'i caratteri di LIKE non sono jolly');
});

test('validazione: href o chiavi fuori formato e href ripetuti sono errori di programmazione', async () => {
  const now = new Date();
  await assert.rejects(inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'a/b.ics', uid: 'x', overrideKeys: [] }], { now })), TypeError);
  await assert.rejects(inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'k.ics', uid: 'x', overrideKeys: [''] }], { now })), TypeError);
  await assert.rejects(inTx((tx) => allocateObjectIds(tx, cal.a.id, [{ href: 'k.ics', uid: 'x', overrideKeys: ['2027-01-01'] }], { now })), TypeError);
  await assert.rejects(inTx((tx) => allocateObjectIds(tx, cal.a.id, [
    { href: 'k.ics', uid: 'x', overrideKeys: [] },
    { href: 'k.ics', uid: 'y', overrideKeys: [] },
  ], { now })), TypeError);
  assert.equal((await inTx((tx) => allocateObjectIds(tx, cal.a.id, [], { now }))).size, 0);
});
