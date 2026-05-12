'use client';

import { useState } from 'react';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Field, FieldLabel, FieldError, Textarea } from '@/components/ui/form';
import { SlotPicker } from './SlotPicker';
import {
  cancelBooking,
  rescheduleBooking,
  getIcsUrl,
  type BookingDetail,
  type BookingSlot,
} from '@/lib/booking-api';

interface ManageBookingProps {
  booking: BookingDetail;
  /** HMAC token for self-service access (from URL `?token=...`). */
  token: string;
}

const SLOT_FORMAT = new Intl.DateTimeFormat('it-IT', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const STATUS_LABELS: Record<BookingDetail['status'], string> = {
  confirmed: 'Confermata',
  cancelled: 'Cancellata',
  rescheduled: 'Riprogrammata',
  no_show: 'Mancata',
  completed: 'Completata',
};

type Mode = 'view' | 'cancelling' | 'rescheduling';

/**
 * ManageBooking — gestione self-service prenotazione (cancel + reschedule).
 *
 * Pattern Swiss: status mono uppercase + dot accent (NO pill colorate),
 * hairline tra meta, primitive button, NO modal centered, conferma cancel
 * inline con confirm flow.
 */
export function ManageBooking({ booking, token }: ManageBookingProps) {
  const [mode, setMode] = useState<Mode>('view');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatedBooking, setUpdatedBooking] = useState(booking);
  const [newSlot, setNewSlot] = useState<BookingSlot | null>(null);

  const isActive = updatedBooking.status === 'confirmed';
  const startDate = new Date(updatedBooking.start_time);

  const onCancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelBooking(updatedBooking.uid, { token, reason });
      setUpdatedBooking({ ...updatedBooking, status: 'cancelled', cancelled_at: new Date().toISOString() });
      setMode('view');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancellazione fallita.');
    } finally {
      setBusy(false);
    }
  };

  const onReschedule = async () => {
    if (!newSlot) {
      setError('Seleziona un nuovo orario.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rescheduleBooking(updatedBooking.uid, newSlot.start, { token });
      setUpdatedBooking({
        ...updatedBooking,
        status: 'rescheduled',
        start_time: newSlot.start,
        end_time: newSlot.end,
      });
      setMode('view');
      setNewSlot(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Riprogrammazione fallita.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="grid grid-cols-12 gap-6 md:gap-8">
      <div className="col-span-12 md:col-span-7 md:col-start-3">
        <Eyebrow as="p" mono className="mb-4">
          {`Prenotazione · ${updatedBooking.event_type.title}`}
        </Eyebrow>

        <Heading
          as="h1"
          size="display-lg"
          className="mb-6 capitalize"
          style={{ maxWidth: '24ch' }}
        >
          {SLOT_FORMAT.format(startDate)}
        </Heading>

        <div
          className="flex items-center gap-2 mb-8"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-mono-xs)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: 'var(--color-text-primary)',
          }}
        >
          <span aria-hidden="true" style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>
            ●
          </span>
          {STATUS_LABELS[updatedBooking.status]}
        </div>

        <dl
          className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6 mb-8 border-y"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div>
            <MonoLabel as="dt" className="mb-1">Tipo</MonoLabel>
            <dd style={{ color: 'var(--color-text-primary)' }}>
              {updatedBooking.event_type.title} · {updatedBooking.event_type.duration_minutes} minuti
            </dd>
          </div>
          <div>
            <MonoLabel as="dt" className="mb-1">Modalità</MonoLabel>
            <dd style={{ color: 'var(--color-text-primary)' }}>
              {updatedBooking.location_type === 'google_meet'
                ? 'Google Meet'
                : updatedBooking.location_type === 'phone'
                ? 'Telefono'
                : updatedBooking.location_type === 'in_person'
                ? 'In presenza'
                : 'Link personalizzato'}
            </dd>
          </div>
          <div>
            <MonoLabel as="dt" className="mb-1">Per</MonoLabel>
            <dd style={{ color: 'var(--color-text-primary)' }}>
              {updatedBooking.attendee_name}
            </dd>
          </div>
          <div>
            <MonoLabel as="dt" className="mb-1">Email</MonoLabel>
            <dd style={{ color: 'var(--color-text-primary)' }}>
              {updatedBooking.attendee_email}
            </dd>
          </div>
        </dl>

        {error ? (
          <p
            className="mb-6 text-sm leading-relaxed"
            style={{ color: 'var(--color-text-error)' }}
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {mode === 'view' && isActive ? (
          <div className="flex flex-wrap gap-6">
            <Button
              href={getIcsUrl(updatedBooking.uid, token)}
              variant="solid"
              size="md"
            >
              Scarica .ics
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => setMode('rescheduling')}
              type="button"
            >
              Riprogramma
            </Button>
            <Button
              variant="underline"
              size="md"
              onClick={() => setMode('cancelling')}
              type="button"
            >
              Cancella
            </Button>
          </div>
        ) : null}

        {mode === 'cancelling' ? (
          <div
            className="py-6 border-t"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Heading as="h2" size="display-sm" className="mb-4">
              Cancellare la prenotazione?
            </Heading>
            <Field>
              <FieldLabel htmlFor="cancel-reason">
                Motivo (opzionale, mi aiuta a migliorare)
              </FieldLabel>
              <Textarea
                id="cancel-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className="mt-6 flex flex-wrap gap-6">
              <Button
                variant="solid"
                size="md"
                onClick={onCancel}
                disabled={busy}
                type="button"
              >
                {busy ? 'Cancellazione…' : 'Sì, cancella'}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => setMode('view')}
                type="button"
                disabled={busy}
              >
                Torna indietro
              </Button>
            </div>
          </div>
        ) : null}

        {mode === 'rescheduling' ? (
          <div
            className="py-6 border-t"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Heading as="h2" size="display-sm" className="mb-6">
              Scegli un nuovo orario.
            </Heading>
            <SlotPicker
              eventTypeSlug={updatedBooking.event_type.slug}
              onSelect={setNewSlot}
              selectedStart={newSlot?.start ?? null}
            />
            <div className="mt-6 flex flex-wrap gap-6">
              <Button
                variant="solid"
                size="md"
                onClick={onReschedule}
                disabled={busy || !newSlot}
                type="button"
              >
                {busy ? 'Aggiornamento…' : 'Conferma nuovo orario'}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setMode('view');
                  setNewSlot(null);
                }}
                type="button"
                disabled={busy}
              >
                Annulla
              </Button>
            </div>
          </div>
        ) : null}

        {!isActive && mode === 'view' ? (
          <p
            className="text-base md:text-lg leading-relaxed"
            style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
          >
            La prenotazione non è più attiva. Se ti serve un nuovo orario,
            <a
              href="/prenota/consulenza-gratuita-30min"
              className="underline ml-1"
              style={{ color: 'var(--color-accent-deep)' }}
            >
              prenota di nuovo
            </a>
            .
          </p>
        ) : null}
      </div>
    </article>
  );
}
