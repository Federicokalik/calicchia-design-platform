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

const REQUEST_TYPE_LABELS: Record<PrivacyRequestType, string> = {
  accesso: 'Accesso ai dati personali',
  cancellazione: 'Cancellazione (diritto all\'oblio)',
  portabilita: 'Portabilità dei dati',
  rettifica: 'Rettifica',
  opposizione: 'Opposizione al trattamento',
  limitazione: 'Limitazione del trattamento',
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
      // Turnstile token will be wired in P0-05; per ora passiamo placeholder
      // accettato a livello server (la validazione finale anti-bot avverrà in fase
      // 3 via Cloudflare Turnstile come da P0-05).
      turnstileToken: 'pending-p0-05',
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
      const res = await fetch(`${API_BASE}/api/gdpr-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
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

      {/* Turnstile slot — wired in P0-05 (Cloudflare Turnstile + RHF refactor) */}
      <div
        className="text-xs uppercase tracking-[0.18em]"
        style={{
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        Anti-bot · verifica server-side al submit
      </div>

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
