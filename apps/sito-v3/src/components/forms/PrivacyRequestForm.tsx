'use client';

import { useState, type FormEvent } from 'react';
import {
  privacyRequestSchema,
  type PrivacyRequestInput,
  type PrivacyRequestType,
} from '@/lib/schemas/privacy-request';
import { Field } from '@/components/ui/form/Field';
import { FieldLabel } from '@/components/ui/form/FieldLabel';
import { FieldError } from '@/components/ui/form/FieldError';
import { Input } from '@/components/ui/form/Input';
import { Textarea } from '@/components/ui/form/Textarea';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { useTurnstile } from '@/hooks/useTurnstile';
import { useRuntimeConfig } from '@/lib/runtime-config';

// Italian copy keyed by the API enum values (request_type).
const REQUEST_TYPE_LABELS: Record<PrivacyRequestType, string> = {
  access: 'Accesso ai dati personali',
  erasure: 'Cancellazione (diritto all\'oblio)',
  portability: 'Portabilità dei dati',
  rectification: 'Rettifica',
  objection: 'Opposizione al trattamento',
  restriction: 'Limitazione del trattamento',
};

type FormState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? process.env.PORTAL_API_URL ?? 'http://localhost:3001';

export function PrivacyRequestForm() {
  const [state, setState] = useState<FormState>({ kind: 'idle' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof PrivacyRequestInput, string>>>({});
  const { config } = useRuntimeConfig();
  const turnstileSiteKey = config.turnstileSiteKey;
  const turnstile = useTurnstile(turnstileSiteKey);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFieldErrors({});

    const fd = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = {
      requestType: String(fd.get('requestType') ?? ''),
      name: String(fd.get('name') ?? ''),
      email: String(fd.get('email') ?? ''),
      description: String(fd.get('description') ?? ''),
      gdpr: fd.get('gdpr') === 'on' ? true : false,
    };

    const parsed = privacyRequestSchema.safeParse(payload);
    if (!parsed.success) {
      const formatted = parsed.error.flatten().fieldErrors;
      const next: Partial<Record<keyof PrivacyRequestInput, string>> = {};
      (Object.keys(formatted) as (keyof PrivacyRequestInput)[]).forEach((key) => {
        const messages = formatted[key];
        if (messages && messages.length > 0) next[key] = messages[0];
      });
      setFieldErrors(next);
      setState({ kind: 'error', message: 'Controlla i campi evidenziati.' });
      return;
    }

    setState({ kind: 'loading' });
    try {
      // Map the form shape onto the API contract: snake_case field names,
      // `message` (not `description`), real Turnstile token.
      const res = await fetch(`${API_BASE}/api/gdpr-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_type: parsed.data.requestType,
          name: parsed.data.name,
          email: parsed.data.email,
          message: parsed.data.description,
          turnstile_token: turnstile.token ?? '',
        }),
      });

      if (!res.ok) {
        turnstile.reset();
        const text = await res.text().catch(() => '');
        let message = `HTTP ${res.status}`;
        try {
          const json = JSON.parse(text) as { error?: string };
          if (json.error) message = json.error;
        } catch {
          if (text) message = text;
        }
        throw new Error(message);
      }

      setState({ kind: 'success' });
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof Error
            ? `Invio fallito: ${error.message}`
            : 'Invio fallito. Riprova tra qualche minuto o scrivimi a mail@calicchia.design.',
      });
    }
  };

  if (state.kind === 'success') {
    return (
      <div
        className="border-l pl-6 py-2"
        style={{ borderColor: 'var(--color-accent)' }}
      >
        <MonoLabel as="p" tone="accent" className="mb-2">
          Richiesta ricevuta
        </MonoLabel>
        <p
          className="text-base md:text-lg leading-relaxed"
          style={{ color: 'var(--color-text-primary)', maxWidth: '60ch' }}
        >
          Ho ricevuto la tua richiesta. Risposta entro 30 giorni come previsto dal
          GDPR. Se urgente, scrivimi direttamente a{' '}
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8" noValidate>
      <Field>
        <FieldLabel htmlFor="pr-request-type" required>
          Tipo di richiesta
        </FieldLabel>
        <select
          id="pr-request-type"
          name="requestType"
          required
          defaultValue=""
          className="mt-3 bg-transparent border-b py-3 text-lg outline-none focus-visible:border-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 transition-hover-color"
          style={{
            borderColor: fieldErrors.requestType
              ? 'var(--color-text-error)'
              : 'var(--color-border-strong)',
            color: 'var(--color-text-primary)',
          }}
        >
          <option value="" disabled>
            Seleziona il diritto da esercitare
          </option>
          {(Object.keys(REQUEST_TYPE_LABELS) as PrivacyRequestType[]).map((t) => (
            <option key={t} value={t}>
              {REQUEST_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {fieldErrors.requestType ? (
          <FieldError>{fieldErrors.requestType}</FieldError>
        ) : null}
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Field>
          <FieldLabel htmlFor="pr-name" required>
            Nome e cognome
          </FieldLabel>
          <Input
            id="pr-name"
            name="name"
            type="text"
            autoComplete="name"
            invalid={Boolean(fieldErrors.name)}
            required
          />
          {fieldErrors.name ? <FieldError>{fieldErrors.name}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="pr-email" required>
            Email
          </FieldLabel>
          <Input
            id="pr-email"
            name="email"
            type="email"
            autoComplete="email"
            invalid={Boolean(fieldErrors.email)}
            required
          />
          {fieldErrors.email ? <FieldError>{fieldErrors.email}</FieldError> : null}
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="pr-description" required>
          Descrizione della richiesta
        </FieldLabel>
        <Textarea
          id="pr-description"
          name="description"
          rows={6}
          invalid={Boolean(fieldErrors.description)}
          required
        />
        {fieldErrors.description ? (
          <FieldError>{fieldErrors.description}</FieldError>
        ) : null}
      </Field>

      <Field>
        <label htmlFor="pr-gdpr" className="flex items-start gap-3 cursor-pointer">
          <input
            id="pr-gdpr"
            name="gdpr"
            type="checkbox"
            required
            className="mt-1 h-5 w-5 accent-current"
            style={{ accentColor: 'var(--color-accent)' }}
          />
          <span
            className="text-sm leading-relaxed"
            style={{ color: 'var(--color-text-secondary)', maxWidth: '60ch' }}
          >
            Ho letto l'
            <a
              href="/privacy-policy"
              className="underline"
              style={{ color: 'var(--color-accent-deep)' }}
            >
              informativa privacy
            </a>{' '}
            e autorizzo il trattamento dei miei dati personali per gestire la
            presente richiesta. <span aria-hidden="true">*</span>
          </span>
        </label>
        {fieldErrors.gdpr ? <FieldError>{fieldErrors.gdpr}</FieldError> : null}
      </Field>

      {/* Turnstile invisible widget (lazy script via useTurnstile). */}
      <div ref={turnstile.containerRef} aria-hidden="true" />
      {!turnstileSiteKey ? (
        <MonoLabel as="p">
          Anti-bot · verifica server-side al submit
        </MonoLabel>
      ) : turnstile.error ? (
        <FieldError>{turnstile.error}</FieldError>
      ) : null}

      {state.kind === 'error' ? (
        <p
          className="text-sm leading-relaxed"
          style={{ color: 'var(--color-text-error)', maxWidth: '60ch' }}
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center gap-6">
        <Button
          type="submit"
          variant="solid"
          size="md"
          disabled={state.kind === 'loading'}
        >
          {state.kind === 'loading' ? 'Invio in corso…' : 'Invia richiesta'}
        </Button>
        <MonoLabel as="span">
          Risposta entro 30 giorni · GDPR art. 12
        </MonoLabel>
      </div>
    </form>
  );
}
