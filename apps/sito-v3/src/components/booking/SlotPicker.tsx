'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchAvailableSlots, type SlotsByDate, type BookingSlot } from '@/lib/booking-api';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Heading } from '@/components/ui/Heading';

interface SlotPickerProps {
  eventTypeSlug: string;
  /** Day count to pre-load (default 14). */
  windowDays?: number;
  /** Callback when user picks a slot. */
  onSelect: (slot: BookingSlot) => void;
  /** Currently selected slot start ISO (for active state). */
  selectedStart?: string | null;
}

const DAY_FORMAT = new Intl.DateTimeFormat('it-IT', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const TIME_FORMAT = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * SlotPicker — calendar slot list, week-style verticale.
 *
 * Pattern Swiss: 7-col rigid grid disabled (lista verticale per giorno con
 * sub-row di slot orari, mobile-first, NO shadow cells, monospace tabular-nums,
 * accent solo per selected). Hairline 1px tra giorni.
 */
export function SlotPicker({
  eventTypeSlug,
  windowDays = 14,
  onSelect,
  selectedStart,
}: SlotPickerProps) {
  const [slots, setSlots] = useState<SlotsByDate>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to, days } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fromStr = isoDate(today);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + windowDays - 1);
    const toStr = isoDate(toDate);
    const allDays: string[] = [];
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      allDays.push(isoDate(d));
    }
    return { from: fromStr, to: toStr, days: allDays };
  }, [windowDays]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAvailableSlots(eventTypeSlug, from, to)
      .then((data) => {
        if (cancelled) return;
        setSlots(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Errore caricamento slot.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventTypeSlug, from, to]);

  const totalSlots = useMemo(
    () => Object.values(slots).reduce((acc, list) => acc + list.length, 0),
    [slots]
  );

  if (loading) {
    return (
      <div className="py-12">
        <MonoLabel as="p">Carico gli slot disponibili…</MonoLabel>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12">
        <MonoLabel as="p" tone="accent">
          Errore caricamento slot
        </MonoLabel>
        <p
          className="mt-2 text-base leading-relaxed"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {error} · Ricarica la pagina o scrivimi a{' '}
          <a
            href="mailto:mail@calicchia.design"
            className="underline"
            style={{ color: 'var(--color-accent-deep)' }}
          >
            mail@calicchia.design
          </a>
          .
        </p>
      </div>
    );
  }

  if (totalSlots === 0) {
    return (
      <div className="py-12">
        <MonoLabel as="p">Nessuno slot disponibile nei prossimi {windowDays} giorni</MonoLabel>
        <p
          className="mt-2 text-base leading-relaxed"
          style={{ color: 'var(--color-text-secondary)', maxWidth: '60ch' }}
        >
          Sono pieno. Scrivimi e troviamo uno spazio fuori calendario.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-6">
        <MonoLabel as="p">Disponibilità · prossimi {windowDays} giorni</MonoLabel>
        <MonoLabel as="p" tone="accent">
          {totalSlots} slot
        </MonoLabel>
      </div>

      <ul role="list" className="flex flex-col">
        {days.map((day) => {
          const daySlots = slots[day] ?? [];
          if (daySlots.length === 0) return null;
          const dayDate = new Date(`${day}T00:00:00`);
          return (
            <li
              key={day}
              className="border-t py-6 grid grid-cols-12 gap-4"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <div className="col-span-12 md:col-span-3">
                <Heading
                  as="h3"
                  size="card"
                  className="capitalize"
                  style={{ fontSize: '1.125rem' }}
                >
                  {DAY_FORMAT.format(dayDate)}
                </Heading>
                <MonoLabel as="p" className="mt-1">
                  {daySlots.length} slot
                </MonoLabel>
              </div>

              <div className="col-span-12 md:col-span-9 flex flex-wrap gap-2">
                {daySlots.map((slot) => {
                  const isSelected = slot.start === selectedStart;
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      onClick={() => onSelect(slot)}
                      aria-pressed={isSelected}
                      className="px-4 py-3 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 tabular-nums"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.95rem',
                        letterSpacing: '0.02em',
                        border: '1px solid',
                        borderColor: isSelected
                          ? 'var(--color-accent)'
                          : 'var(--color-border-strong)',
                        background: isSelected
                          ? 'var(--color-accent)'
                          : 'transparent',
                        color: isSelected
                          ? 'var(--color-accent-ink)'
                          : 'var(--color-text-primary)',
                        minHeight: 44,
                      }}
                    >
                      {TIME_FORMAT.format(new Date(slot.start))}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
