import type { FormHTMLAttributes, ReactNode } from 'react';

type Spacing = 'tight' | 'default' | 'loose';

export interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  spacing?: Spacing;
  children: ReactNode;
}

const SPACING: Record<Spacing, string> = {
  tight: 'gap-6',
  default: 'gap-10',
  loose: 'gap-14',
};

/**
 * Form — column-flex form container with pre-set vertical rhythm. Every
 * site form (contact, portal login, upload metadata) consumes this so the
 * whitespace between fields is identical across the product.
 */
export function Form({ spacing = 'default', className = '', children, ...rest }: FormProps) {
  const cls = ['flex flex-col', SPACING[spacing], className].filter(Boolean).join(' ');
  return (
    <form className={cls} noValidate {...rest}>
      {children}
    </form>
  );
}
