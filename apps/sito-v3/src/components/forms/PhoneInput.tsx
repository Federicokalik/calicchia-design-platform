'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { Input } from '@/components/ui/form/Input';

const PREFIX_OPTIONS = [
  { code: '+39', label: 'IT +39' },
  { code: '+44', label: 'UK +44' },
  { code: '+33', label: 'FR +33' },
  { code: '+49', label: 'DE +49' },
  { code: '+34', label: 'ES +34' },
  { code: '+1', label: 'US/CA +1' },
  { code: '+41', label: 'CH +41' },
  { code: '+43', label: 'AT +43' },
] as const;

export interface PhoneInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  prefix?: string;
  onPrefixChange?: (prefix: string) => void;
  invalid?: boolean;
}

/**
 * PhoneInput — telefono con prefisso paese.
 *
 * Pattern Swiss: bottom-bordered (no boxes), label sopra (gestita dal caller
 * con `<FieldLabel>`), prefisso a sinistra come segmented select piatto + input
 * a destra. NO floating labels.
 *
 * Il prefisso è uno state controlled dal caller. Il valore del prefisso è
 * concatenato dall'esterno se serve (es. `${prefix} ${input}`); per RHF
 * registra solo il `phone` field, il prefisso è metadata UX.
 */
export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(
  function PhoneInput(
    { prefix = '+39', onPrefixChange, invalid, className = '', ...rest },
    ref
  ) {
    return (
      <div className="grid grid-cols-[auto_1fr] gap-3 items-end">
        <select
          aria-label="Prefisso paese"
          value={prefix}
          onChange={(e) => onPrefixChange?.(e.target.value)}
          className="mt-3 bg-transparent border-b py-3 text-base outline-none focus-visible:border-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 transition-hover-color"
          style={{
            borderColor: invalid
              ? 'var(--color-text-error)'
              : 'var(--color-border-strong)',
            color: 'var(--color-text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-mono-xs)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          {PREFIX_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>
        <Input
          ref={ref}
          type="tel"
          autoComplete="tel-national"
          inputMode="tel"
          invalid={invalid}
          className={className}
          {...rest}
        />
      </div>
    );
  }
);
