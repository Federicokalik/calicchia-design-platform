import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cookie, Calendar, Filter, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface CookieConsentEntry {
  id: string;
  ip_anonymous: string | null;
  preferences: {
    necessary?: boolean;
    analytics?: boolean;
    marketing?: boolean;
  };
  consent_version: string;
  user_agent: string | null;
  created_at: string;
}

interface CookieConsentPayload {
  entries: CookieConsentEntry[];
  stats: { total: number; with_analytics: number; with_marketing: number; versions: number };
}

export default function CookieConsentAuditPage() {
  const [acceptedOnly, setAcceptedOnly] = useState(false);

  const { data, isLoading } = useQuery<CookieConsentPayload>({
    queryKey: ['cookie-consents', acceptedOnly],
    queryFn: () => apiFetch(`/api/cookie-consent?limit=200${acceptedOnly ? '&accepted_only=1' : ''}`),
  });

  const entries = data?.entries ?? [];
  const stats = data?.stats ?? { total: 0, with_analytics: 0, with_marketing: 0, versions: 0 };
  const acceptRate = stats.total > 0
    ? Math.round((stats.with_analytics / stats.total) * 100)
    : 0;

  useTopbar({
    title: 'Audit consensi cookie',
    subtitle: `${stats.total} record · ${acceptRate}% analytics-on · ${stats.with_marketing} marketing-on · ${stats.versions} versioni`,
  });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Log GDPR append-only. IP anonimizzati (ultimo ottetto azzerato) lato server.
          Retention: 12 mesi via cron cleanup. Audit trail richiesto da Garante 229/2021.
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <div className="flex items-center gap-2">
          <Switch id="accepted-only" checked={acceptedOnly} onCheckedChange={setAcceptedOnly} />
          <Label htmlFor="accepted-only" className="text-sm cursor-pointer">
            Solo consensi attivi (analytics o marketing)
          </Label>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title="Nessun consenso registrato"
          description="I consensi raccolti dal banner cookie del sito pubblico appariranno qui."
          icon={Cookie}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">Quando</th>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">IP (anon.)</th>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">Necessari</th>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">Analytics</th>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">Marketing</th>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">Versione</th>
                <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">User-agent</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-1.5 text-xs">
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                      {new Date(e.created_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.ip_anonymous || '—'}</td>
                  <td className="px-3 py-2"><PrefBadge value={e.preferences?.necessary} /></td>
                  <td className="px-3 py-2"><PrefBadge value={e.preferences?.analytics} /></td>
                  <td className="px-3 py-2"><PrefBadge value={e.preferences?.marketing} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{e.consent_version}</td>
                  <td className="px-3 py-2 max-w-[280px] truncate text-xs text-muted-foreground" title={e.user_agent ?? ''}>
                    {e.user_agent || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PrefBadge({ value }: { value: boolean | undefined }) {
  if (value === true) return <Badge variant="default" className="text-xs">Sì</Badge>;
  if (value === false) return <Badge variant="outline" className="text-xs">No</Badge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}
