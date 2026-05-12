import type { HTMLAttributes, ReactNode } from 'react';

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/**
 * Field — column-flex container that stacks label / input / error. Gap is
 * managed by the children's own margins (label: bottom, input: top mt-3,
 * error: top mt-2) so label-less fields still align.
 */
export function Field({ children, className = '', ...rest }: FieldProps) {
  return (
    <div className={`flex flex-col ${className}`} {...rest}>
      {children}
    </div>
  );
}
