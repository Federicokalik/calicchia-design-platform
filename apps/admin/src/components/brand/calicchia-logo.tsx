import { useId } from 'react';
import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';
import {
  CALICCHIA_PATHS,
  DESIGN_PATHS,
  TILDE_PATH,
  VIEWBOX_FULL,
} from './logo-paths';

interface CalicchiaLogoProps extends SVGProps<SVGSVGElement> {
  title?: string;
}

export function CalicchiaLogo({
  className,
  title = 'Calicchia Design',
  ...props
}: CalicchiaLogoProps) {
  const titleId = useId();

  return (
    <svg
      viewBox={VIEWBOX_FULL.join(' ')}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={titleId}
      className={cn('block h-auto w-auto shrink-0 text-current', className)}
      {...props}
    >
      <title id={titleId}>{title}</title>
      <g fill="currentColor">
        {CALICCHIA_PATHS.map((d, i) => (
          <path key={`calicchia-${i}`} d={d} />
        ))}
      </g>
      <g fill="currentColor">
        {DESIGN_PATHS.map((d, i) => (
          <path key={`design-${i}`} d={d} />
        ))}
      </g>
      <path fill="#f57f44" d={TILDE_PATH} />
    </svg>
  );
}
