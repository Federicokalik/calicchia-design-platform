import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Play, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface ActiveTimerEntry {
  id: string;
  project_id: string;
  project_name?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  start_time: string;
  description?: string | null;
}

interface ProjectListItem {
  id: string;
  name: string;
  customer_name?: string | null;
}

function formatElapsed(startIso: string, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * TimerWidget — popover persistente nel topbar per il time tracking.
 *
 * Stato attivo: pulsante rosso con conteggio live. Stato inattivo: pulsante
 * grigio con icona Play. Click apre il popover (select progetto + descrizione
 * → Avvia, oppure dettagli timer in corso → Ferma).
 *
 * Polling /timer/active ogni 30s in modo da rispecchiare un eventuale stop
 * fatto da un altro device/tab. Il countdown locale tickera ogni secondo solo
 * quando un timer è attivo.
 */
export function TimerWidget() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const activeQuery = useQuery<{ entry: ActiveTimerEntry | null }>({
    queryKey: ['timer-active', user?.id],
    queryFn: () => apiFetch(`/api/time-entries/timer/active?user_id=${user!.id}`),
    enabled: !!user?.id,
    refetchInterval: 30_000,
  });

  const active = activeQuery.data?.entry ?? null;

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active?.id]);

  const projectsQuery = useQuery<{ projects: ProjectListItem[] }>({
    queryKey: ['projects-for-timer'],
    queryFn: () => apiFetch('/api/client-projects?limit=100'),
    enabled: open && !active,
  });

  const startMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/time-entries/timer/start', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          user_id: user!.id,
          description: description.trim() || null,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timer-active'] });
      setProjectId('');
      setDescription('');
      setOpen(false);
      toast.success('Timer avviato');
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Errore avvio timer';
      toast.error(msg);
    },
  });

  const stopMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/time-entries/timer/stop', {
        method: 'POST',
        body: JSON.stringify({ user_id: user!.id }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timer-active'] });
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
      queryClient.invalidateQueries({ queryKey: ['client-projects'] });
      toast.success('Timer fermato');
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Errore stop timer';
      toast.error(msg);
    },
  });

  const elapsed = useMemo(
    () => (active ? formatElapsed(active.start_time, nowMs) : null),
    [active?.start_time, nowMs],
  );

  if (!user) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2"
          aria-label={active ? `Timer in corso — ${elapsed}` : 'Avvia timer'}
        >
          {active ? (
            <>
              <Square className="h-3 w-3 fill-current text-red-500" />
              <span className="text-xs tabular-nums">{elapsed}</span>
            </>
          ) : (
            <Play className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {active ? (
          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Timer in corso
              </p>
              <p className="text-3xl font-mono tabular-nums mt-1">{elapsed}</p>
              <p className="text-sm font-medium mt-2 truncate">
                {active.project_name || 'Progetto'}
              </p>
              {active.task_title && (
                <p className="text-xs text-muted-foreground truncate">{active.task_title}</p>
              )}
              {active.description && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{active.description}</p>
              )}
            </div>
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
            >
              <Square className="h-3.5 w-3.5 mr-1.5 fill-current" />
              Ferma timer
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Avvia timer
            </p>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Progetto</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Seleziona progetto..." />
                </SelectTrigger>
                <SelectContent>
                  {(projectsQuery.data?.projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="truncate">
                        {p.name}
                        {p.customer_name ? ` · ${p.customer_name}` : ''}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Descrizione (opzionale)</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Su cosa stai lavorando?"
                className="h-9 text-sm"
              />
            </div>
            <Button
              className="w-full"
              onClick={() => startMutation.mutate()}
              disabled={!projectId || startMutation.isPending}
            >
              <Play className="h-3.5 w-3.5 mr-1.5" /> Avvia
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
