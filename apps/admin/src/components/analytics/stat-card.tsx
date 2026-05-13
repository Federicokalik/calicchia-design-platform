import type { LucideIcon } from 'lucide-react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
  /** Optional delta % vs previous period. Positive = up, negative = down. null = no compare available. */
  deltaPercent?: number | null;
  /** If true, a positive delta is bad (e.g. bounce rate). */
  inverse?: boolean;
}

export function StatCard({
  title,
  value,
  icon: Icon,
  description,
  deltaPercent,
  inverse,
}: StatCardProps) {
  const hasDelta = deltaPercent !== undefined && deltaPercent !== null;
  const up = hasDelta && deltaPercent! > 0;
  const down = hasDelta && deltaPercent! < 0;
  const flat = hasDelta && deltaPercent === 0;
  const positive = inverse ? down : up;
  const negative = inverse ? up : down;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          {hasDelta && (
            <span className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              positive && 'text-emerald-600',
              negative && 'text-red-600',
              flat && 'text-muted-foreground',
            )}>
              {up && <ArrowUp className="h-3 w-3" />}
              {down && <ArrowDown className="h-3 w-3" />}
              {flat && <Minus className="h-3 w-3" />}
              {Math.abs(deltaPercent!).toFixed(1)}%
            </span>
          )}
          {description && <span>{description}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
