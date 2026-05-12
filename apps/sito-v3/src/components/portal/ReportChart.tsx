import { MonoLabel } from '@/components/ui/MonoLabel';
import type { PortalReportData } from '@/lib/portal-api';

interface ReportChartProps {
  data?: PortalReportData | null;
}

type ReportChartRow = Record<string, string | number | null>;

function collectRows(data?: PortalReportData | null): ReportChartRow[] {
  if (!data) return [];
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.metrics)) {
    return data.metrics.map<ReportChartRow>((metric) => ({
      metrica: metric.label,
      valore: metric.value,
      precedente: metric.previous ?? null,
      delta: metric.delta ?? null,
    }));
  }
  return [];
}

export function ReportChart({ data }: ReportChartProps) {
  // TODO P0-06 polish: replace with real charting in P1 after report data format is frozen.
  const rows = collectRows(data);
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  if (!rows.length || !keys.length) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        Nessun dato tabellare disponibile per questo report.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
            {keys.map((key) => (
              <th key={key} className="py-3 pr-6">
                <MonoLabel>{key.toUpperCase()}</MonoLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} style={{ borderBottom: '1px solid var(--color-border)' }}>
              {keys.map((key) => (
                <td key={key} className="py-4 pr-6 text-sm" style={{ color: 'var(--color-text-primary)' }}>
                  {String(row[key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
