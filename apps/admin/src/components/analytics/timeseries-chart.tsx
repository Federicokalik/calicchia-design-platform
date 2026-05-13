import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface DataPoint {
  bucket: string;
  value: number;
  valuePrev?: number | null;
}

interface Props {
  data: DataPoint[];
  granularity: 'hour' | 'day';
  metricLabel: string;
  showCompare?: boolean;
  height?: number;
}

function formatBucket(iso: string, granularity: 'hour' | 'day'): string {
  const d = new Date(iso);
  if (granularity === 'hour') {
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
}

export function TimeseriesChart({ data, granularity, metricLabel, showCompare, height = 280 }: Props) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="tsCurrent" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="tsPrev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.2} />
            <stop offset="95%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="bucket"
          tickFormatter={(v) => formatBucket(v, granularity)}
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(v) => formatBucket(String(v), granularity)}
          formatter={(val: number, name: string) => [val.toLocaleString('it-IT'), name === 'value' ? metricLabel : 'Periodo prec.']}
        />
        {showCompare && (
          <Area
            type="monotone"
            dataKey="valuePrev"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            fill="url(#tsPrev)"
            isAnimationActive={false}
          />
        )}
        <Area
          type="monotone"
          dataKey="value"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#tsCurrent)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
