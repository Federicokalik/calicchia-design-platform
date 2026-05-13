import { useEffect, useRef, useState } from 'react';
import { Activity, Globe, Mouse, Wifi, WifiOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiFetch, API_BASE } from '@/lib/api';
import { cn } from '@/lib/utils';

type Realtime = {
  visitorsNow: number;
  topPages: Array<{ key: string; visitors: number; pageviews: number }>;
  recentEvents: Array<{
    type: string;
    event_name: string | null;
    page: string | null;
    country: string | null;
    created_at: string;
  }>;
};

const SSE_TIMEOUT_MS = 5000;

export function RealtimePanel() {
  const [data, setData] = useState<Realtime | null>(null);
  const [mode, setMode] = useState<'sse' | 'polling' | 'connecting'>('connecting');
  const [liveBlip, setLiveBlip] = useState(false);
  const sseRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const startPolling = () => {
      if (cancelled) return;
      setMode('polling');
      const fetchNow = () => {
        apiFetch('/api/analytics/realtime').then((d: Realtime) => {
          if (!cancelled) setData(d);
        }).catch(() => {});
      };
      fetchNow();
      pollRef.current = setInterval(fetchNow, 10_000);
    };

    const startSse = () => {
      try {
        const es = new EventSource(`${API_BASE}/api/analytics/realtime/stream`, {
          withCredentials: true,
        });
        sseRef.current = es;

        // If we don't get any message within SSE_TIMEOUT_MS, fall back to polling.
        sseTimeoutRef.current = setTimeout(() => {
          if (cancelled) return;
          es.close();
          sseRef.current = null;
          startPolling();
        }, SSE_TIMEOUT_MS);

        es.addEventListener('tick', (e) => {
          if (cancelled) return;
          if (sseTimeoutRef.current) {
            clearTimeout(sseTimeoutRef.current);
            sseTimeoutRef.current = null;
          }
          setMode('sse');
          try { setData(JSON.parse(e.data)); } catch { /* ignore */ }
        });

        es.addEventListener('event', () => {
          if (cancelled) return;
          setLiveBlip(true);
          setTimeout(() => setLiveBlip(false), 600);
        });

        es.onerror = () => {
          if (cancelled) return;
          es.close();
          sseRef.current = null;
          if (sseTimeoutRef.current) {
            clearTimeout(sseTimeoutRef.current);
            sseTimeoutRef.current = null;
          }
          startPolling();
        };
      } catch {
        startPolling();
      }
    };

    startSse();

    return () => {
      cancelled = true;
      if (sseRef.current) sseRef.current.close();
      if (pollRef.current) clearInterval(pollRef.current);
      if (sseTimeoutRef.current) clearTimeout(sseTimeoutRef.current);
    };
  }, []);

  const visitorsNow = data?.visitorsNow ?? 0;
  const topPages = data?.topPages ?? [];
  const recentEvents = data?.recentEvents ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-1">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Visitatori adesso</CardTitle>
            <div className="flex items-center gap-1.5">
              <span className={cn(
                'inline-block h-2 w-2 rounded-full transition-all',
                liveBlip ? 'bg-emerald-500 scale-150' : 'bg-emerald-500/50',
              )} />
              {mode === 'sse' ? <Wifi className="h-3.5 w-3.5 text-emerald-600" /> : <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{visitorsNow}</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {mode === 'sse' ? 'Live via SSE' : mode === 'polling' ? 'Polling 10s' : 'Connessione...'}
            </p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" /> Pagine attive
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topPages.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4 text-center">Nessuna visita negli ultimi 5 min.</div>
            ) : (
              <div className="space-y-1.5">
                {topPages.slice(0, 6).map((p) => (
                  <div key={p.key} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 truncate font-medium">{p.key}</span>
                    <Badge variant="outline" className="text-[10px] h-5">{p.visitors} {p.visitors === 1 ? 'visitatore' : 'visitatori'}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Mouse className="h-3.5 w-3.5 text-muted-foreground" /> Stream eventi (ultimi 5 min)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentEvents.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">Nessun evento.</div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto scrollbar-thin divide-y divide-border/50">
              {recentEvents.map((e, i) => (
                <div key={`${e.created_at}-${i}`} className="flex items-center gap-3 py-2 text-xs">
                  <Badge variant="outline" className="text-[10px] h-5 shrink-0 capitalize">{e.type}</Badge>
                  <span className="flex-1 truncate font-medium">{e.event_name || e.page || '—'}</span>
                  {e.country && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Globe className="h-3 w-3" /> {e.country}
                    </span>
                  )}
                  <span className="text-muted-foreground shrink-0">
                    {new Date(e.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
