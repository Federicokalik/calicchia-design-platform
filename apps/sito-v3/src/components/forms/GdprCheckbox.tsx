'use client';

import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { FieldError } from '@/components/ui/form/FieldError';

export interface GdprCheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Inline error message (binds with aria-invalid + role=alert). */
  error?: string;
  /** Override label children. Default: italian standard with privacy link. */
  children?: ReactNode;
  /** Custom privacy policy href. Default: `/privacy-policy`. */
  privacyHref?: string;
}

/**
 * GdprCheckbox — checkbox required per consenso al trattamento dati.
 *
 * Pattern Swiss: NO floating, label a destra del check, link inline alla
 * privacy policy con underline. Required asterisco con tone accent.
 * Compatibile con `react-hook-form register('gdpr_consent')`.
 */
export const GdprCheckbox = forwardRef<HTMLInputElement, GdprCheckboxProps>(
  function GdprCheckbox(
    { id, error, children, privacyHref = '/privacy-policy', className = '', ...rest },
    ref
  ) {
    const inputId = id ?? 'gdpr-consent';
    return (
      <div className="flex flex-col">
        <label
          htmlFor={inputId}
          className="flex items-start gap-3 cursor-pointer group"
        >
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            required
            aria-invalid={Boolean(error)}
            className={`mt-1 h-5 w-5 flex-shrink-0 ${className}`}
            style={{ accentColor: 'var(--color-accent)' }}
            {...rest}
          />
          <span
            className="text-sm leading-relaxed"
            style={{ color: 'var(--color-text-secondary)', maxWidth: '60ch' }}
          >
            {children ?? (
              <>
                Ho letto l&apos;
                <Link
                  href={privacyHref}
                  className="underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ color: 'var(--color-accent-deep)' }}
                >
                  informativa privacy
                </Link>{' '}
                e autorizzo il trattamento dei miei dati per gestire la richiesta.
              </>
            )}
            <span aria-hidden="true" style={{ color: 'var(--color-accent-deep)' }}>
              {' *'}
            </span>
          </span>
        </label>
        {error ? <FieldError>{error}</FieldError> : null}
      </div>
    );
  }
);
