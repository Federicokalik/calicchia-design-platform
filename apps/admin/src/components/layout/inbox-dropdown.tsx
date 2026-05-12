import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertCircle, FileSignature, Receipt, UserPlus, Calendar } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';

interface InboxPayload {
  counts: {
    tasks_overdue: number;
    tasks_today: number;
    quotes_pending: number;
    invoices_overdue: number;
    leads_new: number;
    total: number;
  };
  tasks_overdue: Array<{ id: string; title: string; project_id: string; project_name: string | null; due_date: string }>;
  tasks_today: Array<{ id: string; title: string; project_id: string; project_name: string | null; due_date: string }>;
  quotes_pending: Array<{ id: string; quote_number: string; title: string | null; total: number; company_name: string | null; contact_name: string | null }>;
  invoices_overdue: Array<{ id: string; invoice_number: string; total: number; amount_due: number; due_date: string; company_name: string | null }>;
  leads_new: Array<{ id: string; name: string; email: string | null; company: string | null; created_at: string }>;
}

function formatDate(raw: string): string {
  return new Date(raw).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export function InboxDropdown() {
  const navigate = useNavigate();
  const { data } = useQuery<InboxPayload>({
    queryKey: ['inbox'],
    queryFn: () => apiFetch('/api/inbox'),
    refetchInterval: 60_000,
  });

  const total = data?.counts.total ?? 0;
  const sections = useMemo(() => {
    if (!data) return [];
    const out: Array<{ key: string; label: string; icon: typeof Bell; count: number; items: Array<{ id: string; primary: string; secondary?: string; href: string }> }> = [];

    if (data.counts.tasks_overdue > 0) {
      out.push({
        key: 'tasks_overdue',
        label: 'Task in ritardo',
        icon: AlertCircle,
        count: data.counts.tasks_overdue,
        items: data.tasks_overdue.map((t) => ({
          id: t.id,
          primary: t.title,
          secondary: `${t.project_name ?? 'Progetto'} · ${formatDate(t.due_date)}`,
          href: `/progetti/${t.project_id}?task=${t.id}`,
        })),
      });
    }
    if (data.counts.tasks_today > 0) {
      out.push({
        key: 'tasks_today',
        label: 'Task di oggi',
        icon: Calendar,
        count: data.counts.tasks_today,
        items: data.tasks_today.map((t) => ({
          id: t.id,
          primary: t.title,
          secondary: t.project_name ?? 'Progetto',
          href: `/progetti/${t.project_id}?task=${t.id}`,
        })),
      });
    }
    if (data.counts.quotes_pending > 0) {
      out.push({
        key: 'quotes_pending',
        label: 'Preventivi in attesa firma',
        icon: FileSignature,
        count: data.counts.quotes_pending,
        items: data.quotes_pending.map((q) => ({
          id: q.id,
          primary: q.title || q.quote_number,
          secondary: q.company_name || q.contact_name || '',
          href: `/preventivi/${q.id}`,
        })),
      });
    }
    if (data.counts.invoices_overdue > 0) {
      out.push({
        key: 'invoices_overdue',
        label: 'Fatture scadute',
        icon: Receipt,
        count: data.counts.invoices_overdue,
        items: data.invoices_overdue.map((i) => ({
          id: i.id,
          primary: i.invoice_number,
          secondary: `${i.company_name ?? ''} · ${formatDate(i.due_date)}`,
          href: `/fatturazione`,
        })),
      });
    }
    if (data.counts.leads_new > 0) {
      out.push({
        key: 'leads_new',
        label: 'Lead nuovi',
        icon: UserPlus,
        count: data.counts.leads_new,
        items: data.leads_new.map((l) => ({
          id: l.id,
          primary: l.name,
          secondary: l.company || l.email || undefined,
          href: `/pipeline`,
        })),
      });
    }
    return out;
  }, [data]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 relative"
          aria-label="Inbox"
        >
          <Bell className="h-4 w-4" />
          {total > 0 && (
            <span className={cn(
              'absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full px-1 flex items-center justify-center text-[10px] font-semibold',
              total > 0 && 'bg-red-500 text-white'
            )}>
              {total > 99 ? '99+' : total}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0 max-h-[70vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h3 className="text-sm font-semibold">Inbox</h3>
          <span className="text-xs text-muted-foreground">{total} item{total === 1 ? '' : 's'}</span>
        </div>
        <div className="flex-1 overflow-auto">
          {sections.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Tutto sotto controllo. Nessuna azione richiesta.
            </div>
          ) : (
            sections.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.key} className="border-b last:border-b-0">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Icon className="h-3 w-3" />
                    {s.label}
                    <span className="ml-auto font-normal normal-case">{s.count}</span>
                  </div>
                  {s.items.slice(0, 6).map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => navigate(it.href)}
                      className="w-full text-left px-3 py-2 hover:bg-muted/40 border-b border-border/40 last:border-b-0 transition-colors"
                    >
                      <div className="text-xs font-medium text-foreground truncate">{it.primary}</div>
                      {it.secondary && (
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5">{it.secondary}</div>
                      )}
                    </button>
                  ))}
                  {s.items.length > 6 && (
                    <div className="px-3 py-1.5 text-[10px] text-muted-foreground text-center bg-muted/20">
                      … +{s.items.length - 6} altri
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
