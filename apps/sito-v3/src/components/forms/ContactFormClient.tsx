'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Field,
  FieldError,
  FieldLabel,
  Form,
  Input,
  Textarea,
} from '@/components/ui/form';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Link } from '@/i18n/navigation';
import { PhoneInput } from './PhoneInput';
import { GdprCheckbox } from './GdprCheckbox';
import {
  contactSchema,
  SERVICE_OPTIONS,
  type ContactInput,
} from '@/lib/schemas/contact';
import { useTurnstile } from '@/hooks/useTurnstile';
import { useLeadSource } from '@/hooks/useLeadSource';
import { reportEvent } from '@/instrumentation-client';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ??
  process.env.PUBLIC_TURNSTILE_SITE_KEY;

type ServiceOption = (typeof SERVICE_OPTIONS)[number];

const SERVICE_OPTION_SET = new Set<string>(SERVICE_OPTIONS);

type FormTranslate = (key: string, values?: Record<string, string | number>) => string;

function isServiceOption(value: string | null): value is ServiceOption {
  return typeof value === 'string' && SERVICE_OPTION_SET.has(value);
}

function humanizeSlug(s: string) {
  return s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildPrefillMessage(params: URLSearchParams, t: FormTranslate): string {
  const service = params.get('service');
  const plan = params.get('plan');
  const profession = params.get('profession');
  const city = params.get('city');

  if (!service && !plan && !profession && !city) return '';

  const parts: string[] = [t('prefill.greeting')];
  if (service && plan) {
    parts.push(
      t('prefill.servicePlan', {
        plan: humanizeSlug(plan),
        service: humanizeSlug(service),
      })
    );
  } else if (service) {
    parts.push(t('prefill.service', { service: humanizeSlug(service) }));
  } else if (plan) {
    parts.push(t('prefill.plan', { plan: humanizeSlug(plan) }));
  }
  if (profession || city) {
    const ctxBits: string[] = [];
    if (profession) ctxBits.push(humanizeSlug(profession));
    if (city) ctxBits.push(humanizeSlug(city));
    parts.push(t('prefill.context', { context: ctxBits.join(' · ') }));
  }
  parts.push('', '');
  return parts.join(' ').trim() + '\n\n';
}

/**
 * ContactFormClient — RHF + Zod + Turnstile lazy + GDPR explicit.
 *
 * POSTs to `/api/contacts/`. Pattern Swiss: bottom-bordered inputs, label
 * sopra, FieldError inline, mono labels metadata. Turnstile invisible si
 * carica al primo mount (lazy script via `useTurnstile`).
 *
 * Pre-fills the message textarea when the user lands here from a pricing
 * CTA (e.g. /contatti?service=web-design&plan=multipagina). Caller must
 * wrap this component in <Suspense> (Next 16 App Router rule).
 */
export function ContactFormClient() {
  const t = useTranslations('contatti.form');
  const searchParams = useSearchParams();
  const leadSource = useLeadSource();
  const auditService = isServiceOption(leadSource.service)
    ? leadSource.service
    : null;
  const prefillMessage = useMemo(
    () => buildPrefillMessage(new URLSearchParams(searchParams.toString()), t as FormTranslate),
    [searchParams, t]
  );
  const validationMessages = useMemo(
    () =>
      new Map<string, string>([
        ['Inserisci nome e cognome (almeno 2 caratteri).', t('validation.nameMin')],
        ['Nome troppo lungo (max 100 caratteri).', t('validation.nameMax')],
        ['Email non valida.', t('validation.emailInvalid')],
        ['Email troppo lunga.', t('validation.emailMax')],
        ['Scrivimi almeno 20 caratteri sul progetto.', t('validation.messageMin')],
        ['Messaggio troppo lungo (max 2000 caratteri).', t('validation.messageMax')],
        [
          'Formato telefono non valido (es. +39 3510000000).',
          t('validation.phoneInvalid'),
        ],
        ['Nome azienda troppo lungo (max 150 caratteri).', t('validation.companyMax')],
        ["Devi accettare l'informativa privacy.", t('validation.gdprRequired')],
        ['Formato slot non valido.', t('validation.slotInvalid')],
        ['Verifica anti-bot richiesta.', t('validation.turnstileRequired')],
      ]),
    [t]
  );
  const validationMessage = (message: string | undefined) =>
    message ? validationMessages.get(message) ?? message : undefined;

  const turnstile = useTurnstile(TURNSTILE_SITE_KEY);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isSubmitSuccessful },
    setValue,
    setError,
    reset: resetForm,
    watch,
    control,
  } = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    mode: 'onBlur',
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      message: prefillMessage,
      services: auditService ? [auditService] : [],
      wants_call: false,
      wants_meet: false,
      gdpr_consent: false as unknown as true,
      source_page: searchParams.get('source_page') ?? '',
      source_service: auditService ?? searchParams.get('service') ?? '',
      source_profession: searchParams.get('profession') ?? '',
      lead_source: leadSource.source ?? '',
      meet_slot: '',
      turnstile_token: '',
    },
  });

  // Sync Turnstile token into form values whenever it changes.
  useEffect(() => {
    setValue('turnstile_token', turnstile.token ?? '', { shouldValidate: false });
  }, [turnstile.token, setValue]);

  // Re-fill message on prefill change (URL params change).
  useEffect(() => {
    if (prefillMessage) {
      setValue('message', prefillMessage, { shouldValidate: false });
    }
  }, [prefillMessage, setValue]);

  // Sync lead magnet query params into RHF after hydration/navigation changes.
  useEffect(() => {
    setValue('lead_source', leadSource.source ?? '', { shouldValidate: false });

    if (leadSource.isAudit && auditService) {
      setValue('services', [auditService], { shouldValidate: false });
      setValue('source_service', auditService, { shouldValidate: false });
    }
  }, [auditService, leadSource.isAudit, leadSource.source, setValue]);

  const messageValue = watch('message') ?? '';

  const onSubmit = async (data: ContactInput) => {
    try {
      const res = await fetch(`${API_URL}/api/contacts/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          if (text) message = text;
        }
        setError('root', { type: 'server', message });
        turnstile.reset();
        return;
      }

      if (data.lead_source) {
        reportEvent('lead.audit_requested', {
          service: auditService ?? leadSource.service,
          lead_source: data.lead_source,
          referrer: document.referrer,
        });
      }
    } catch (error) {
      setError('root', {
        type: 'server',
        message:
          error instanceof Error
            ? t('errorWithMessage', { message: error.message })
            : t('error'),
      });
      turnstile.reset();
    }
  };

  if (isSubmitSuccessful) {
    return (
      <div
        className="border-l pl-6 py-2"
        style={{ borderColor: 'var(--color-accent)' }}
      >
        <Eyebrow as="p" mono className="mb-2">
          {t('success.eyebrow')}
        </Eyebrow>
        <Heading
          as="h2"
          size="display-sm"
          className="mb-4"
          style={{ maxWidth: '24ch' }}
        >
          {t('success.heading')}
        </Heading>
        <p
          className="text-base md:text-lg leading-relaxed"
          style={{ color: 'var(--color-text-secondary)', maxWidth: '60ch' }}
        >
          {t('success.textBeforeEmail')}{' '}
          <a
            href="mailto:mail@calicchia.design"
            className="underline"
            style={{ color: 'var(--color-accent-deep)' }}
          >
            mail@calicchia.design
          </a>
          {t('success.textAfterEmail')}
        </p>
        <button
          type="button"
          onClick={() => resetForm()}
          className="mt-6 border-b border-current py-2 text-xs uppercase tracking-[0.18em] hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {t('success.sendAnother')}
        </button>
      </div>
    );
  }

  return (
    <Form onSubmit={handleSubmit(onSubmit)} noValidate>
      <input type="hidden" {...register('lead_source')} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Field>
          <FieldLabel htmlFor="contact-name" required>
            {t('labels.name')}
          </FieldLabel>
          <Input
            id="contact-name"
            type="text"
            autoComplete="name"
            invalid={Boolean(errors.name)}
            {...register('name')}
          />
          {errors.name ? <FieldError>{validationMessage(errors.name.message)}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="contact-email" required>
            {t('labels.email')}
          </FieldLabel>
          <Input
            id="contact-email"
            type="email"
            autoComplete="email"
            invalid={Boolean(errors.email)}
            {...register('email')}
          />
          {errors.email ? <FieldError>{validationMessage(errors.email.message)}</FieldError> : null}
        </Field>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8">
        <Field>
          <FieldLabel htmlFor="contact-phone">{t('labels.phone')}</FieldLabel>
          <Controller
            control={control}
            name="phone"
            render={({ field }) => (
              <PhoneInput
                id="contact-phone"
                invalid={Boolean(errors.phone)}
                {...field}
                value={field.value ?? ''}
              />
            )}
          />
          {errors.phone ? <FieldError>{validationMessage(errors.phone.message)}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="contact-company">{t('labels.company')}</FieldLabel>
          <Input
            id="contact-company"
            type="text"
            autoComplete="organization"
            invalid={Boolean(errors.company)}
            {...register('company')}
          />
        </Field>
      </div>

      {leadSource.isAudit ? (
        <Field className="mt-8">
          <FieldLabel htmlFor="contact-request-type">{t('labels.requestType')}</FieldLabel>
          <Input
            id="contact-request-type"
            type="text"
            value={t('auditRequestType')}
            readOnly
            aria-readonly="true"
          />
        </Field>
      ) : null}

      <Field className="mt-8">
        <FieldLabel>{t('labels.services')}</FieldLabel>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
          {SERVICE_OPTIONS.map((slug) => (
            <label
              key={slug}
              htmlFor={`contact-service-${slug}`}
              className="flex items-center gap-2 cursor-pointer text-sm"
              style={{ color: 'var(--color-text-primary)' }}
            >
              <input
                id={`contact-service-${slug}`}
                type="checkbox"
                value={slug}
                {...register('services')}
                style={{ accentColor: 'var(--color-accent)' }}
              />
              {t(`services.${slug}`)}
            </label>
          ))}
        </div>
      </Field>

      <Field className="mt-8">
        <FieldLabel htmlFor="contact-message" required>
          {t('labels.message')}
        </FieldLabel>
        <Textarea
          id="contact-message"
          rows={6}
          invalid={Boolean(errors.message)}
          {...register('message')}
        />
        <div className="flex justify-between items-center mt-2">
          {errors.message ? (
            <FieldError>{validationMessage(errors.message.message)}</FieldError>
          ) : (
            <span />
          )}
          <MonoLabel as="span">{messageValue.length}/2000</MonoLabel>
        </div>
      </Field>

      <Field className="mt-8">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <label
            htmlFor="contact-wants-call"
            className="flex items-center gap-2 cursor-pointer text-sm"
            style={{ color: 'var(--color-text-primary)' }}
          >
            <input
              id="contact-wants-call"
              type="checkbox"
              {...register('wants_call')}
              style={{ accentColor: 'var(--color-accent)' }}
            />
            {t('labels.wantsCall')}
          </label>
          <label
            htmlFor="contact-wants-meet"
            className="flex items-center gap-2 cursor-pointer text-sm"
            style={{ color: 'var(--color-text-primary)' }}
          >
            <input
              id="contact-wants-meet"
              type="checkbox"
              {...register('wants_meet')}
              style={{ accentColor: 'var(--color-accent)' }}
            />
            {t('labels.wantsMeet')}
          </label>
        </div>
      </Field>

      <Field className="mt-8">
        <Controller
          control={control}
          name="gdpr_consent"
          render={({ field }) => (
            <GdprCheckbox
              id="contact-gdpr"
              checked={Boolean(field.value)}
              onChange={(e) => field.onChange(e.target.checked)}
              error={validationMessage(errors.gdpr_consent?.message)}
            >
              {t('gdpr.beforeLink')}
              <Link
                href="/privacy-policy"
                className="underline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: 'var(--color-accent-deep)' }}
              >
                {t('gdpr.link')}
              </Link>{' '}
              {t('gdpr.afterLink')}
            </GdprCheckbox>
          )}
        />
      </Field>

      {/* Turnstile invisible widget (lazy script) */}
      <div ref={turnstile.containerRef} aria-hidden="true" className="mt-6" />
      {!TURNSTILE_SITE_KEY ? (
        <MonoLabel as="p" className="mt-3">
          {t('turnstileDisabled')}
        </MonoLabel>
      ) : turnstile.error ? (
        <FieldError>{validationMessage(turnstile.error)}</FieldError>
      ) : null}

      {errors.root ? (
        <p
          className="mt-6 text-sm leading-relaxed"
          style={{ color: 'var(--color-text-error)', maxWidth: '60ch' }}
          role="alert"
        >
          {errors.root.message}
        </p>
      ) : null}

      <div className="mt-10 flex flex-wrap items-center gap-6">
        <Button type="submit" variant="solid" size="md" disabled={isSubmitting}>
          {isSubmitting ? t('submitting') : t('submit')}
        </Button>
        <MonoLabel as="span">
          {t('responseNote')}
        </MonoLabel>
      </div>
    </Form>
  );
}
