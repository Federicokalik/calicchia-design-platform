import * as React from 'react';

import { cn } from '@/lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, max = 100, ...props }, ref) => {
    const percentage = value != null ? Math.min(100, Math.max(0, (value / max) * 100)) : null;

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className={cn(
          'relative h-2 w-full overflow-hidden rounded-full bg-primary/20',
          className
        )}
        {...props}
      >
        <div
          className={cn(
            'h-full bg-primary transition-all',
            percentage === null && 'animate-pulse'
          )}
          style={{
            width: percentage !== null ? `${percentage}%` : '100%',
          }}
        />
      </div>
    );
  }
);

Progress.displayName = 'Progress';

export { Progress };
