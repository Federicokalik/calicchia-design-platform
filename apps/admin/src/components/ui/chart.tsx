/**
 * shadcn-compatible ChartContainer + ChartTooltip wrappers
 * around recharts. Provides consistent theme colors and tooltip styling.
 */
import * as React from 'react';
import { ResponsiveContainer, Tooltip as RechartsTooltip, type TooltipProps } from 'recharts';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type ChartConfig = Record<
  string,
  {
    label: string;
    color?: string;
  }
>;

interface ChartContextValue {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error('useChart must be inside <ChartContainer>');
  return ctx;
}

// ─────────────────────────────────────────────────────────
// ChartContainer
// ─────────────────────────────────────────────────────────

interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config: ChartConfig;
  children: React.ReactElement;
  height?: number | string;
}

const ChartContainer = React.forwardRef<HTMLDivElement, ChartContainerProps>(
  ({ config, children, className, height = 250, ...props }, ref) => {
    // Inject CSS variables for each configured color
    const cssVars = Object.entries(config).reduce<Record<string, string>>((acc, [key, val]) => {
      if (val.color) acc[`--chart-${key}`] = val.color;
      return acc;
    }, {});

    return (
      <ChartContext.Provider value={{ config }}>
        <div
          ref={ref}
          className={cn('w-full', className)}
          style={cssVars as React.CSSProperties}
          {...props}
        >
          <ResponsiveContainer width="100%" height={height}>
            {children}
          </ResponsiveContainer>
        </div>
      </ChartContext.Provider>
    );
  }
);
ChartContainer.displayName = 'ChartContainer';

// ─────────────────────────────────────────────────────────
// ChartTooltipContent
// ─────────────────────────────────────────────────────────

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color?: string }>;
  label?: string;
  formatter?: (value: number, name: string) => React.ReactNode;
  labelFormatter?: (label: string) => React.ReactNode;
  className?: string;
}

const ChartTooltipContent = React.forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  ({ active, payload, label, formatter, labelFormatter, className }, ref) => {
    const { config } = useChart();

    if (!active || !payload?.length) return null;

    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border border-border bg-background p-3 shadow-md text-sm',
          className
        )}
      >
        {label && (
          <div className="mb-1 font-medium text-foreground">
            {labelFormatter ? labelFormatter(label) : label}
          </div>
        )}
        <div className="space-y-1">
          {payload.map((item, i) => {
            const cfg = config[item.name];
            const color = item.color || cfg?.color || 'hsl(var(--primary))';
            const displayName = cfg?.label || item.name;
            const displayValue = formatter
              ? formatter(item.value, item.name)
              : item.value;

            return (
              <div key={i} className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-muted-foreground">{displayName}</span>
                <span className="ml-auto font-medium text-foreground">{displayValue}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);
ChartTooltipContent.displayName = 'ChartTooltipContent';

// ─────────────────────────────────────────────────────────
// ChartTooltip (re-exports recharts Tooltip with defaults)
// ─────────────────────────────────────────────────────────

type ChartTooltipProps = TooltipProps<number, string> & {
  content?: React.ReactElement;
};

function ChartTooltip({ content, ...props }: ChartTooltipProps) {
  return (
    <RechartsTooltip
      cursor={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }}
      content={content}
      {...props}
    />
  );
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  useChart,
};
