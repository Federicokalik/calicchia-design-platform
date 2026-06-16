import { useQuery } from '@tanstack/react-query';
import {
  Users, Send, Eye, MousePointerClick, Mail, MessageCircle, TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface Analytics {
  contacts: { total: number; warm: number; cold: number; confirmed: number; unsubscribed: number; wa_opted_in: number };
  campaigns: { sent_campaigns: number; emails_sent: number; opened: number; clicked: number; unsub: number };
  by_channel: { channel: string; n: number }[];
  recent_campaigns: { id: string; name: string; channel: string; status: string; total_recipients: number; total_sent: number; total_opened: number; total_clicked: number; sent_at: string | null }[];
  growth_30d: { day: string; n: number }[];
}

export default function MarketingAnalyticsPage() {
  useTopbar({ title: 'Analytics', subtitle: 'Performance email & WhatsApp marketing' });
  const { data, isLoading } = useQuery<Analytics>({
    queryKey: ['mkt-analytics'], queryFn: () => apiFetch('/api/email-marketing/analytics'),
  });
  if (isLoading || !data) return <LoadingState />;

  const { contacts, campaigns, recent_campaigns, growth_30d } = data;
  const openRate = campaigns.emails_sent ? Math.round((campaigns.opened / campaigns.emails_sent) * 100) : 0;
  const clickRate = campaigns.emails_sent ? Math.round((campaigns.clicked / campaigns.emails_sent) * 100) : 0;
  const maxGrowth = Math.max(1, ...growth_30d.map((g) => g.n));

  return (
    <div className="space-y-6">
      {/* Audience */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Audience</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Metric icon={Users} label="Contatti" value={contacts.total} />
          <Metric label="Caldi" value={contacts.warm} />
          <Metric label="Freddi" value={contacts.cold} />
          <Metric label="Confermati" value={contacts.confirmed} tone="good" />
          <Metric label="Disiscritti" value={contacts.unsubscribed} tone="warn" />
          <Metric icon={MessageCircle} label="Opt-in WA" value={contacts.wa_opted_in} />
        </div>
      </section>

      {/* Performance */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Invii</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Metric icon={Send} label="Campagne inviate" value={campaigns.sent_campaigns} />
          <Metric icon={Mail} label="Email inviate" value={campaigns.emails_sent} />
          <Metric icon={Eye} label="Aperture" value={campaigns.opened} />
          <Metric icon={MousePointerClick} label="Click" value={campaigns.clicked} />
          <Metric label="Open rate" value={`${openRate}%`} tone="good" />
          <Metric label="Click rate" value={`${clickRate}%`} tone="good" />
        </div>
      </section>

      {/* Growth */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5"><TrendingUp className="h-4 w-4" /> Crescita (30 giorni)</h2>
        <div className="rounded-lg border p-4">
          {growth_30d.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessun nuovo contatto negli ultimi 30 giorni.</p>
          ) : (
            <div className="flex items-end gap-0.5 h-24">
              {growth_30d.map((g) => (
                <div key={g.day} className="flex-1 bg-primary/70 rounded-t" style={{ height: `${(g.n / maxGrowth) * 100}%` }} title={`${g.day}: ${g.n}`} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Recent campaigns */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Campagne recenti</h2>
        {recent_campaigns.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessuna campagna inviata.</p>
        ) : (
          <div className="rounded-lg border bg-card divide-y">
            {recent_campaigns.map((c) => {
              const open = c.total_sent ? Math.round((c.total_opened / c.total_sent) * 100) : 0;
              const click = c.total_sent ? Math.round((c.total_clicked / c.total_sent) * 100) : 0;
              return (
                <div key={c.id} className="p-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    {c.channel === 'email' ? <Mail className="h-3.5 w-3.5 text-muted-foreground" /> : <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />}
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    <Badge variant="outline" className="text-[10px]">{c.status}</Badge>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <span>{c.total_sent}/{c.total_recipients} inviate</span>
                    <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{open}%</span>
                    <span className="flex items-center gap-1"><MousePointerClick className="h-3 w-3" />{click}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon?: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone?: 'good' | 'warn' }) {
  const cls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
  return (
    <div className="rounded-lg border p-3">
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
      <span className="text-[10px] text-muted-foreground uppercase flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}{label}
      </span>
    </div>
  );
}
