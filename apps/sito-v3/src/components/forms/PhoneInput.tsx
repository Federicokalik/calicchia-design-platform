'use client';

import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
} from 'react';
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

const PREFIX_CODES = PREFIX_OPTIONS.map((opt) => opt.code);
const DEFAULT_PREFIX = '+39';

export interface PhoneInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  /**
   * Full phone value including international prefix (es. "+39 3510000000").
   * When empty the input is empty and the prefix defaults to +39.
   */
  value?: string;
  /**
   * Emitted with the full normalized phone (e.g. "+39 3510000000") or "" when
   * the local part is empty. RHF can pass this through `field.onChange`.
   */
  onChange?: (value: string) => void;
  /** Original onChange shape kept for non-RHF callers (deprecated). */
  invalid?: boolean;
}

function parseValue(full: string): { prefix: string; local: string } {
  const trimmed = (full ?? '').trim();
  if (!trimmed) return { prefix: DEFAULT_PREFIX, local: '' };
  // Longest-match country code (handles +1 vs +44 vs +393…).
  const sorted = [...PREFIX_CODES].sort((a, b) => b.length - a.length);
  for (const code of sorted) {
    if (trimmed.startsWith(code)) {
      const rest = trimmed.slice(code.length).replace(/^\s+/, '');
      return { prefix: code, local: rest };
    }
  }
  return { prefix: DEFAULT_PREFIX, local: trimmed.replace(/^\+/, '') };
}

function composeValue(prefix: string, local: string): string {
  const cleanLocal = local.trim();
  if (!cleanLocal) return '';
  return `${prefix} ${cleanLocal}`;
}

/**
 * PhoneInput — international phone with country-prefix select.
 *
 * Controlled component: the parent stores the full value (e.g. "+39 3510000000").
 * The select drives the prefix, the text input the local part. Both writes call
 * `onChange` with the composed string so the regex
 * `/^\+\d{1,4}\s?\d{4,15}$/` accepts it.
 */
export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(
  function PhoneInput(
    { value = '', onChange, invalid, className = '', name, ...rest },
    ref
  ) {
    const parsed = useMemo(() => parseValue(value), [value]);

    // Internal prefix state lets the user pick a country code before typing
    // any digits (otherwise composeValue('+44', '') would silently revert to
    // the default the next render).
    const [prefix, setPrefix] = useState(parsed.prefix);
    const lastEmittedRef = useRef(value);

    // Sync internal prefix when the parent sets a value containing a prefix.
    useEffect(() => {
      if (value && value !== lastEmittedRef.current) {
        setPrefix(parsed.prefix);
      }
    }, [value, parsed.prefix]);

    const emit = (nextPrefix: string, nextLocal: string) => {
      const composed = composeValue(nextPrefix, nextLocal);
      lastEmittedRef.current = composed;
      onChange?.(composed);
    };

    const handlePrefixChange = (e: ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value;
      setPrefix(next);
      emit(next, parsed.local);
    };

    const handleLocalChange = (e: ChangeEvent<HTMLInputElement>) => {
      // Strip everything except digits and spaces from user input; the regex
      // accepts a single space between prefix and number.
      const digits = e.target.value.replace(/[^\d\s]/g, '');
      emit(prefix, digits);
    };

    return (
      <div className="grid grid-cols-[auto_1fr] gap-3 items-end">
        <select
          aria-label="Prefisso paese"
          value={prefix}
          onChange={handlePrefixChange}
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
          name={name}
          type="tel"
          autoComplete="tel-national"
          inputMode="tel"
          invalid={invalid}
          className={className}
          value={parsed.local}
          onChange={handleLocalChange}
          {...rest}
        />
      </div>
    );
  }
);
