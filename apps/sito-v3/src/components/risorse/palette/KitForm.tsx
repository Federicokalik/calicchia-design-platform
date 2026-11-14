'use client';

import { useState, type FormEvent } from 'react';
import { KIT_CONSENT_TEXT, KIT_CONSENT_VERSION, type SharedPalette } from '@calicchia/shared/palette';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { FieldError } from '@/components/ui/form/FieldError';
import { FieldLabel } from '@/components/ui/form/FieldLabel';
import { Input } from '@/components/ui/form/Input';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { GdprCheckbox } from '@/components/forms/GdprCheckbox';
import { useCaptcha } from '@/hooks/useCaptcha';
import type { Locale } from '@/lib/i18n';
import type { ToolStrings } from './strings';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface KitFormProps {
  t: ToolStrings;
  locale: Locale;
  /** Palette da mandare; null finché non è pronta. */
  shared: SharedPalette | null;
  /** Etichetta del settore curato (null per il testo libero, che non esce dal browser). */
  sectorLabel: string | null;
  onRequested: () => void;
}

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string };

/**
 * Modulo del brand kit in PDF (passo Esporta). Si apre con un bottone: il
 * captcha (e la sua richiesta a Cloudflare) parte solo per chi lo apre.
 * Lo scopo dichiarato è l'iscrizione alla newsletter; il testo del consenso
 * e la sua versione arrivano da @calicchia/shared/palette.
 */
export function KitForm(props: KitFormProps) {
  const [open, setOpen] = useState(false);
  const { t } = props;
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t pt-5" style={{ borderColor: 'var(--color-ink)' }}>
      <h3
        className="font-[family-name:var(--font-display)] text-2xl"
        style={{ fontWeight: 500, letterSpacing: '-0.018em', lineHeight: 1.15 }}
      >
        {t.kitTitle}
      </h3>
      <p className="max-w-[60ch]" style={{ color: 'var(--color-text-secondary)' }}>
        {t.kitText}
      </p>
      {open ? (
        <KitFormBody {...props} />
      ) : (
        <div>
          <Button type="button" variant="ghost" size="sm" disabled={!props.shared} onClick={() => setOpen(true)} aria-expanded={false}>
            {t.kitOpen}
          </Button>
        </div>
      )}
    </div>
  );
}

function KitFormBody({ t, locale, shared, sectorLabel, onRequested }: KitFormProps) {
  const captcha = useCaptcha('contact_form');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [errors, setErrors] = useState<{ email?: string; consent?: string }>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const clean = email.trim();
    const next: typeof errors = {};
    if (!EMAIL_RE.test(clean)) next.email = t.kitErrEmail;
    if (!consent) next.consent = t.kitErrConsent;
    setErrors(next);
    if (next.email || next.consent || !shared) return;

    setStatus({ kind: 'sending' });
    try {
      const res = await fetch(`${API_URL}/api/palette/kit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: clean,
          ...(name.trim() ? { name: name.trim() } : {}),
          palette: shared,
          ...(sectorLabel ? { sector_label: sectorLabel } : {}),
          locale,
          consent: true,
          consent_version: KIT_CONSENT_VERSION,
          turnstile_token: captcha.token ?? '',
        }),
      });
      if (res.status === 202) {
        setStatus({ kind: 'sent', email: clean });
        onRequested();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus({ kind: 'error', message: res.status === 400 || res.status === 403 ? data.error || t.kitErrGeneric : t.kitErrGeneric });
      captcha.reset();
    } catch {
      setStatus({ kind: 'error', message: t.kitErrNetwork });
      captcha.reset();
    }
  }

  if (status.kind === 'sent') {
    return (
      <div role="status" className="grid gap-2 border-l-2 pl-4" style={{ borderColor: 'var(--color-accent)' }}>
        <p className="font-medium">{t.kitSentTitle}</p>
        <p className="max-w-[60ch]" style={{ color: 'var(--color-text-secondary)' }}>
          {t.kitSentText(status.email)}
        </p>
      </div>
    );
  }

  const sending = status.kind === 'sending';
  return (
    <form onSubmit={submit} noValidate className="grid max-w-[40rem] grid-cols-1 gap-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          <FieldLabel htmlFor="pds-kit-email" required>
            {t.kitEmail}
          </FieldLabel>
          <Input
            id="pds-kit-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={255}
            value={email}
            invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'pds-kit-email-error' : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
          {errors.email ? <FieldError id="pds-kit-email-error">{errors.email}</FieldError> : null}
        </div>
        <div className="flex min-w-0 flex-col">
          <FieldLabel htmlFor="pds-kit-name">
            {t.kitName} <span className="normal-case tracking-normal">({t.kitOptional})</span>
          </FieldLabel>
          <Input
            id="pds-kit-name"
            name="name"
            type="text"
            autoComplete="given-name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <GdprCheckbox
        id="pds-kit-consent"
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        error={errors.consent}
      >
        {KIT_CONSENT_TEXT[locale]}{' '}
        <Link
          href="/privacy-policy"
          className="underline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ color: 'var(--color-accent-deep)' }}
        >
          {t.kitPrivacy}
        </Link>
      </GdprCheckbox>

      <div ref={captcha.containerRef} style={{ minWidth: 300, maxWidth: '100%' }} />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button type="submit" variant="solid" size="sm" disabled={sending || !shared} aria-busy={sending}>
          {sending ? t.kitSending : t.kitSubmit}
        </Button>
        {status.kind === 'error' ? (
          <MonoLabel as="span" role="alert" style={{ lineHeight: 1.4, color: 'var(--color-text-error)' }}>
            {status.message}
          </MonoLabel>
        ) : null}
      </div>
    </form>
  );
}
