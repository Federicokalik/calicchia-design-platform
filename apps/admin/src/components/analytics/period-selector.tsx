import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export const PERIODS = [
  { value: '24h', label: 'Ultime 24 ore' },
  { value: '7d', label: 'Ultimi 7 giorni' },
  { value: '30d', label: 'Ultimi 30 giorni' },
  { value: '90d', label: 'Ultimi 90 giorni' },
  { value: '12m', label: 'Ultimi 12 mesi' },
] as const;

export type PeriodValue = (typeof PERIODS)[number]['value'];

interface Props {
  period: PeriodValue;
  onPeriodChange: (v: PeriodValue) => void;
  compare: boolean;
  onCompareChange: (v: boolean) => void;
}

export function PeriodSelector({ period, onPeriodChange, compare, onCompareChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant={compare ? 'default' : 'outline'}
        size="sm"
        onClick={() => onCompareChange(!compare)}
        aria-pressed={compare}
        aria-label="Confronta con periodo precedente"
        className={cn('h-8 px-2 text-xs gap-1', !compare && 'text-muted-foreground')}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        Confronta
      </Button>
      <Select value={period} onValueChange={(v) => onPeriodChange(v as PeriodValue)}>
        <SelectTrigger className="w-40 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIODS.map((p) => (
            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
