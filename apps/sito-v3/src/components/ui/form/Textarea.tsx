'use client';

import { forwardRef, type CSSProperties, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

/**
 * Bottom-bordered textarea. Mirrors `<Input>` for consistency — same border
 * treatment, same focus state, same error tone.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className = '', style, rows = 5, ...rest },
  ref
) {
  const baseClass =
    'mt-3 bg-transparent border-b py-3 text-lg outline-none focus:border-[var(--color-text-primary)] transition-hover-color resize-y';
  const baseStyle: CSSProperties = {
    borderColor: invalid ? 'var(--color-text-error)' : 'var(--color-border-strong)',
    color: 'var(--color-text-primary)',
    ...style,
  };

  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`${baseClass} ${className}`.trim()}
      style={baseStyle}
      {...rest}
    />
  );
});
