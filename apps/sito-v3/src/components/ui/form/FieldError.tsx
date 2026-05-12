import type { HTMLAttributes, ReactNode } from 'react';

export interface FieldErrorProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

/**
 * Inline field error — accent-deep ink, role="alert". Hidden via parent
 * conditional; do not render unless there's an actual error.
 */
export function FieldError({ children, className = '', id, ...rest }: FieldErrorProps) {
  return (
    <span
      id={id}
      role="alert"
      className={`mt-2 text-xs ${className}`}
      style={{ color: 'var(--color-text-error)' }}
      {...rest}
    >
      {children}
    </span>
  );
}
