import type { LabelHTMLAttributes, ReactNode } from 'react';

export interface FieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  children: ReactNode;
}

/**
 * Bottom-bordered field label — uppercase mono-spaced micro-text.
 * Letter-spacing matches `<Eyebrow>` (0.2em) so labels feel of-a-piece with
 * section eyebrows.
 */
export function FieldLabel({ required, children, className = '', ...rest }: FieldLabelProps) {
  return (
    <label
      className={`text-xs uppercase tracking-[0.2em] ${className}`}
      style={{ color: 'var(--color-text-secondary)' }}
      {...rest}
    >
      {children}
      {required && <span aria-hidden> *</span>}
    </label>
  );
}
