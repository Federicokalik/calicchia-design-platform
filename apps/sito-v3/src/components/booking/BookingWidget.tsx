'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRouter } from '@/i18n/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Field,
  FieldError,
  FieldLabel,
  Form,
  Input,
  Textarea,
} from '@/components/ui/form';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Button } from '@/components/ui/Button';
import { PhoneInput } from '@/components/forms/PhoneInput';
import { GdprCheckbox } from '@/components/forms/GdprCheckbox';
import { useTurnstile } from '@/hooks/useTurnstile';
import { SlotPicker } from './SlotPicker';
import { createBooking, type BookingSlot } from '@/lib/booking-api';
import type { BookingEventType } from '@/data/booking-types';

const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ??
  process.env.PUBLIC_TURNSTILE_SITE_KEY;

const bookingFormSchema = z.object({
  name: z.string().trim().min(2, 'Inserisci nome e cognome.').max(100),
  email: z.string().trim().email('Email non valida.').max(255),
  phone: z
    .string()
    .trim()
    .regex(/^\+\d{1,4}\s?\d{4,15}$/, 'Formato telefono non valido (es. +39 3510000000).')
    .optional()
    .or(z.literal('')),
  notes: z.string().trim().max(2000, 'Note troppo lunghe (max 2000).').optional().or(z.literal('')),
  gdpr_consent: z.literal(true, {
    errorMap: () => ({ message: "Devi accettare l'informativa privacy." }),
  }),
});

type BookingFormInput = z.infer<typeof bookingFormSchema>;

interface BookingWidgetProps {
  eventType: BookingEventType;
}

const SLOT_FORMAT = new Intl.DateTimeFormat('it-IT', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * BookingWidget — multi-step swiss booking flow.
 *
 * Step 1: SlotPicker (lista hairline)
 * Step 2: Form attendee (RHF + Zod) + Turnstile lazy
 * Step 3: Loading conferma
 * Step 4: redirect to /prenotazione/[uid]
 *
 * Pattern Swiss: NO stepper colorato, mono labels for state, primitive
 * form fields, single-page con scroll-to step su selezione slot.
 */
export function BookingWidget({ eventType }: BookingWidgetProps) {
  const router = useRouter();
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const turnstile = useTurnstile(TURNSTILE_SITE_KEY);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    control,
  } = useForm<BookingFormInput>({
    resolver: zodResolver(bookingFormSchema),
    mode: 'onBlur',
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      notes: '',
      gdpr_consent: false as unknown as true,
    },
  });

  // Reset turnstile if user goes back to picker
  useEffect(() => {
    if (!selectedSlot) turnstile.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlot]);

  const onSubmit = async (data: BookingFormInput) => {
    if (!selectedSlot) {
      setError('root', { type: 'manual', message: 'Seleziona prima uno slot.' });
      return;
    }
    if (!turnstile.token && TURNSTILE_SITE_KEY) {
      setError('root', {
        type: 'manual',
        message: 'Verifica anti-bot non completata. Riprova tra qualche secondo.',
      });
      return;
    }

    try {
      const result = await createBooking({
        eventTypeSlug: eventType.slug,
        startISO: selectedSlot.start,
        name: data.name,
        email: data.email,
        phone: data.phone || undefined,
        notes: data.notes || undefined,
        turnstileToken: turnstile.token ?? '',
        gdprConsent: true,
      });
      router.push(`/prenotazione/${result.uid}`);
    } catch (error) {
      setError('root', {
        type: 'server',
        message:
          error instanceof Error
            ? error.message
            : 'Non sono riuscito a creare la prenotazione. Riprova.',
      });
      turnstile.reset();
    }
  };

  return (
    <div className="grid grid-cols-12 gap-6 md:gap-8">
      {/* Step 1: SlotPicker */}
      <section className="col-span-12 md:col-span-7">
        <Eyebrow as="p" mono className="mb-6">
          01 — Scegli lo slot
        </Eyebrow>
        <SlotPicker
          eventTypeSlug={eventType.slug}
          onSelect={setSelectedSlot}
          selectedStart={selectedSlot?.start ?? null}
        />
      </section>

      {/* Step 2: Form attendee */}
      <section className="col-span-12 md:col-span-5 md:col-start-8">
        <Eyebrow as="p" mono className="mb-6">
          02 — I tuoi dati
        </Eyebrow>

        {!selectedSlot ? (
          <p
            className="text-base md:text-lg leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Seleziona prima uno slot a sinistra. Poi compili i dati e prenoti.
          </p>
        ) : (
          <>
            <div
              className="mb-6 py-4 border-y"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <MonoLabel as="p" tone="accent" className="mb-1">
                Slot selezionato
              </MonoLabel>
              <Heading
                as="h3"
                size="card"
                className="capitalize"
                style={{ fontSize: '1.05rem' }}
              >
                {SLOT_FORMAT.format(new Date(selectedSlot.start))}
              </Heading>
              <button
                type="button"
                onClick={() => setSelectedSlot(null)}
                className="mt-2 border-b border-current py-1 text-xs uppercase tracking-[0.18em] hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                Cambia orario
              </button>
            </div>

            <Form onSubmit={handleSubmit(onSubmit)} noValidate>
              <Field>
                <FieldLabel htmlFor="booking-name" required>
                  Nome e cognome
                </FieldLabel>
                <Input
                  id="booking-name"
                  type="text"
                  autoComplete="name"
                  invalid={Boolean(errors.name)}
                  {...register('name')}
                />
                {errors.name ? <FieldError>{errors.name.message}</FieldError> : null}
              </Field>

              <Field className="mt-6">
                <FieldLabel htmlFor="booking-email" required>
                  Email
                </FieldLabel>
                <Input
                  id="booking-email"
                  type="email"
                  autoComplete="email"
                  invalid={Boolean(errors.email)}
                  {...register('email')}
                />
                {errors.email ? <FieldError>{errors.email.message}</FieldError> : null}
              </Field>

              <Field className="mt-6">
                <FieldLabel htmlFor="booking-phone">Telefono</FieldLabel>
                <Controller
                  control={control}
                  name="phone"
                  render={({ field }) => (
                    <PhoneInput
                      id="booking-phone"
                      invalid={Boolean(errors.phone)}
                      {...field}
                      value={field.value ?? ''}
                    />
                  )}
                />
                {errors.phone ? <FieldError>{errors.phone.message}</FieldError> : null}
              </Field>

              <Field className="mt-6">
                <FieldLabel htmlFor="booking-notes">Note (opzionale)</FieldLabel>
                <Textarea
                  id="booking-notes"
                  rows={4}
                  invalid={Boolean(errors.notes)}
                  {...register('notes')}
                />
              </Field>

              <Field className="mt-6">
                <Controller
                  control={control}
                  name="gdpr_consent"
                  render={({ field }) => (
                    <GdprCheckbox
                      id="booking-gdpr"
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                      error={errors.gdpr_consent?.message}
                    />
                  )}
                />
              </Field>

              <div ref={turnstile.containerRef} aria-hidden="true" className="mt-6" />
              {turnstile.error ? <FieldError>{turnstile.error}</FieldError> : null}

              {errors.root ? (
                <p
                  className="mt-4 text-sm leading-relaxed"
                  style={{ color: 'var(--color-text-error)', maxWidth: '60ch' }}
                  role="alert"
                >
                  {errors.root.message}
                </p>
              ) : null}

              <div className="mt-8 flex items-center gap-6">
                <Button type="submit" variant="solid" size="md" disabled={isSubmitting}>
                  {isSubmitting ? 'Conferma in corso…' : 'Conferma prenotazione'}
                </Button>
              </div>
            </Form>
          </>
        )}
      </section>
    </div>
  );
}
