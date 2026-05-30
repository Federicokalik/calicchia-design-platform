import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface WaEvent {
  id: number;
  event_type: string;
  device_id: string | null;
  chat_id: string | null;
  from_jid: string | null;
  payload: unknown;
  received_at: string;
}

const EVENT_OPTIONS = [
  { value: 'all', label: 'Tutti gli eventi' },
  { value: 'chat_presence', label: 'Presenza chat (typing)' },
  { value: 'group.participants', label: 'Gruppo - partecipanti' },
  { value: 'group.joined', label: 'Gruppo - join' },
  { value: 'newsletter.joined', label: 'Newsletter - join' },
  { value: 'newsletter.left', label: 'Newsletter - leave' },
  { value: 'newsletter.message', label: 'Newsletter - messaggio' },
  { value: 'newsletter.mute', label: 'Newsletter - mute' },
  { value: 'call.offer', label: 'Chiamata in arrivo' },
];

function eventBadgeColor(type: string): string {
  if (type.startsWith('group.')) return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30';
  if (type.startsWith('newsletter.')) return 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30';
  if (type === 'call.offer') return 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30';
  if (type === 'chat_presence') return 'bg-muted text-muted-foreground border-border';
  return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30';
}

function shortJid(jid: string | null): string {
  if (!jid) return '—';
  // 393517773467@s.whatsapp.net → +39 351 777 3467
  const match = jid.match(/^(\d+)@/);
  return match ? `+${match[1]}` : jid;
}

/**
 * UI minima per consultare gli eventi WhatsApp non-message (group, newsletter,
 * presence, call). Lettura whatsapp_events_log via /api/whatsapp-admin/events.
 * Filtrabile per event_type + paginazione 100 alla volta. Click su riga espande
 * il payload JSONB integrale per ispezione manuale.
 */
export default function WhatsAppEventsPage() {
  const [filter, setFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const queryString = new URLSearchParams({
    limit: '100',
    ...(filter !== 'all' ? { type: filter } : {}),
  }).toString();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['whatsapp-events', filter],
    queryFn: () => apiFetch(`/api/whatsapp-admin/events?${queryString}`),
    refetchInterval: 30_000,
  });

  const events: WaEvent[] = data?.events ?? [];
  const total: number = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link to="/whatsapp">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Eventi WhatsApp</h1>
            <p className="text-sm text-muted-foreground">
              Audit log eventi side-channel ricevuti da GOWA: gruppi, newsletter,
              presenza, chiamate. Le chat normali stanno in{' '}
              <Link to="/whatsapp" className="underline">Inbox</Link>.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCw className={cn('h-4 w-4', isRefetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-sm text-muted-foreground py-12">
          Caricamento eventi…
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={RefreshCw}
          title="Nessun evento"
          description={
            filter === 'all'
              ? 'GOWA non ha ancora inoltrato eventi side-channel. Verifica la configurazione webhook.'
              : `Nessun evento di tipo "${filter}" negli ultimi 100.`
          }
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {events.length} di {total} eventi (più recenti per primi)
          </p>
          <div className="rounded-md border divide-y">
            {events.map((evt) => (
              <div key={evt.id} className="hover:bg-muted/30 transition-colors">
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === evt.id ? null : evt.id)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3"
                >
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 shrink-0 transition-transform text-muted-foreground',
                      expandedId === evt.id && 'rotate-90',
                    )}
                  />
                  <Badge variant="outline" className={cn('font-mono text-xs', eventBadgeColor(evt.event_type))}>
                    {evt.event_type}
                  </Badge>
                  <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                    <span className="truncate text-foreground">
                      <span className="text-muted-foreground">Da:</span> {shortJid(evt.from_jid)}
                    </span>
                    <span className="truncate text-muted-foreground">
                      Chat: {evt.chat_id ?? '—'}
                    </span>
                    <span className="text-xs text-muted-foreground md:text-right">
                      {new Date(evt.received_at).toLocaleString('it-IT', {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                      })}
                    </span>
                  </div>
                </button>
                {expandedId === evt.id && (
                  <div className="bg-muted/40 border-t px-4 py-3">
                    <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(evt.payload, null, 2)}
                    </pre>
                    {evt.device_id && (
                      <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Device: <span className="font-mono normal-case">{evt.device_id}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
