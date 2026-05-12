'use client';

import { forwardRef, type CSSProperties, type InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/**
 * Bottom-bordered text input — transparent bg, 1px line below, no box.
 * Editorial Swiss aesthetic; consistent with `ContactFormClient` original.
 *
 * Border switches to error tone when `invalid` is set; focus collapses the
 * border colour to ink-primary.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className = '', style, ...rest },
  ref
) {
  const baseClass =
    'mt-3 bg-transparent border-b py-3 text-lg outline-none focus:border-[var(--color-text-primary)] transition-hover-color';
  const baseStyle: CSSProperties = {
    borderColor: invalid ? 'var(--color-text-error)' : 'var(--color-border-strong)',
    color: 'var(--color-text-primary)',
    ...style,
  };

  return (
    <input
      ref={ref}
      aria-invalid={invalid ? 'true' : undefined}
      className={`${baseClass} ${className}`.trim()}
      style={baseStyle}
      {...rest}
    />
  );
});
