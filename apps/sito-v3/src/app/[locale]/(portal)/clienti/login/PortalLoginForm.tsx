'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/portal/ui/button';
import { Input } from '@/components/portal/ui/input';
import { Label } from '@/components/portal/ui/label';
import { PortalCaption } from '@/components/portal/ui/typography';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = 'magic-link' | 'code';

interface FieldErrors {
  email?: string;
  access_code?: string;
  global?: string;
}

/**
 * Magic-link primary login (B+A hardening).
 *
 * Primary flow: enter email → POST /api/portal/request-link → success
 * screen "check your email". Click link in email → /clienti/auth/verify
 * (Route Handler) → cookie set → redirect dashboard.
 *
 * Fallback "emergency code": toggle reveals email + access_code form for
 * cases where email delivery fails or admin issued a one-time code. Calls
 * /api/portal/login (email + bcrypt-verified code).
 */
export function PortalLoginForm() {
  const t = useTranslations('portal.login');
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/clienti/dashboard';
  const urlError = searchParams.get('error');

  const [mode, setMode] = useState<Mode>('magic-link');
  const [linkSentEmail, setLinkSentEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>(() =>
    urlError === 'invalid_link' ? { global: t('errors.invalidLinkUrl') } : {}
  );

  const requestLink = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') ?? '').trim();
    if (!email) return setErrors({ email: t('errors.emailRequired') });
    if (!EMAIL_RE.test(email)) return setErrors({ email: t('errors.emailInvalid') });
    setErrors({});
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/portal/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setErrors({ global: t('errors.linkRequestFailed') });
        setSubmitting(false);
        return;
      }
      // Always show "check your email" — endpoint returns 200 even for
      // unknown emails (anti-enumeration). UX consistent.
      setLinkSentEmail(email);
    } catch (error) {
      setErrors({
        global:
          error instanceof Error
            ? t('errors.connectionLostDetail', { message: error.message })
            : t('errors.connectionLost'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const codeLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') ?? '').trim();
    const access_code = String(fd.get('access_code') ?? '').trim();

    const errs: FieldErrors = {};
    if (!email) errs.email = t('errors.emailRequired');
    else if (!EMAIL_RE.test(email)) errs.email = t('errors.emailInvalid');
    if (!access_code) errs.access_code = t('errors.accessCodeRequired');
    if (Object.keys(errs).length) return setErrors(errs);

    setErrors({});
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/portal/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, access_code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErrors({ global: data.error ?? t('errors.credentialsInvalid') });
        setSubmitting(false);
        return;
      }
      router.push(next);
    } catch (error) {
      setErrors({
        global:
          error instanceof Error
            ? t('errors.connectionLostDetail', { message: error.message })
            : t('errors.connectionLost'),
      });
      setSubmitting(false);
    }
  };

  // Success: link sent confirmation
  if (linkSentEmail) {
    return (
      <div className="flex flex-col gap-4 rounded-sm border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <MailCheck className="h-5 w-5 shrink-0 text-primary mt-0.5" aria-hidden />
          <div className="flex flex-col gap-2">
            <p className="text-portal-h3 font-medium">{t('linkSent.title')}</p>
            <PortalCaption tone="muted">{t('linkSent.body')}</PortalCaption>
            <p className="text-portal-caption text-foreground font-mono break-all">
              {linkSentEmail}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setLinkSentEmail(null);
            setErrors({});
          }}
          className="self-start text-portal-label uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('linkSent.retry')}
        </button>
      </div>
    );
  }

  // Magic link mode (primary)
  if (mode === 'magic-link') {
    return (
      <div className="flex flex-col gap-4">
        <form onSubmit={requestLink} noValidate className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="login-email">{t('fields.email')}</Label>
            <Input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              placeholder={t('fields.emailPlaceholder')}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
            />
            {errors.email ? (
              <PortalCaption id="login-email-error" tone="error">
                {errors.email}
              </PortalCaption>
            ) : null}
          </div>

          {errors.global ? (
            <PortalCaption role="alert" tone="error">
              {errors.global}
            </PortalCaption>
          ) : null}

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? t('submit.loading') : t('submit.idle')}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode('code');
            setErrors({});
          }}
          className="self-start text-portal-label uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('fallback.toggleShow')}
        </button>
      </div>
    );
  }

  // Code mode (fallback)
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <p className="text-portal-h3 font-medium">{t('fallback.header')}</p>
        <PortalCaption tone="muted">{t('fallback.subheader')}</PortalCaption>
      </div>

      <form onSubmit={codeLogin} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="code-email">{t('fields.email')}</Label>
          <Input
            id="code-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder={t('fields.emailPlaceholder')}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'code-email-error' : undefined}
          />
          {errors.email ? (
            <PortalCaption id="code-email-error" tone="error">
              {errors.email}
            </PortalCaption>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="code-access">{t('fields.accessCode')}</Label>
          <Input
            id="code-access"
            name="access_code"
            type="text"
            autoComplete="one-time-code"
            required
            placeholder={t('fields.accessCodePlaceholder')}
            aria-invalid={Boolean(errors.access_code)}
            aria-describedby={errors.access_code ? 'code-access-error' : undefined}
          />
          {errors.access_code ? (
            <PortalCaption id="code-access-error" tone="error">
              {errors.access_code}
            </PortalCaption>
          ) : null}
        </div>

        {errors.global ? (
          <PortalCaption role="alert" tone="error">
            {errors.global}
          </PortalCaption>
        ) : null}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitting ? t('submit.codeLoading') : t('submit.codeIdle')}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode('magic-link');
          setErrors({});
        }}
        className="self-start text-portal-label uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors"
      >
        {t('fallback.toggleHide')}
      </button>
    </div>
  );
}
