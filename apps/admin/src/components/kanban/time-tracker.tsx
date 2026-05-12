import { useState, useEffect } from 'react';
import { Play, Square, Clock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TimeEntry } from '@/types/projects';

interface TimeTrackerProps {
  projectId: string;
  taskId?: string;
  userId: string;
  activeTimer: TimeEntry | null;
  entries: TimeEntry[];
  onStartTimer: (description?: string) => void;
  onStopTimer: () => void;
  onAddManual: (entry: { start_time: string; end_time: string; description: string; is_billable: boolean }) => void;
  onDeleteEntry: (id: string) => void;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function LiveTimer({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startTime).getTime();
    const update = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;

  return (
    <span className="font-mono text-lg font-bold text-primary tabular-nums">
      {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
}

export function TimeTracker({
  projectId: _projectId,
  taskId: _taskId,
  userId: _userId,
  activeTimer,
  entries,
  onStartTimer,
  onStopTimer,
  onAddManual,
  onDeleteEntry,
}: TimeTrackerProps) {
  const [description, setDescription] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [manualHours, setManualHours] = useState('');
  const [manualDesc, setManualDesc] = useState('');

  const handleStart = () => {
    onStartTimer(description || undefined);
    setDescription('');
  };

  const handleManualAdd = () => {
    const hours = parseFloat(manualHours);
    if (isNaN(hours) || hours <= 0) return;

    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

    onAddManual({
      start_time: start.toISOString(),
      end_time: now.toISOString(),
      description: manualDesc,
      is_billable: true,
    });

    setManualHours('');
    setManualDesc('');
    setShowManual(false);
  };

  const totalMinutes = entries.reduce((sum, e) => sum + (e.duration_minutes || 0), 0);

  return (
    <div className="space-y-4">
      {/* Timer */}
      <div className="rounded-lg border bg-card p-4">
        {activeTimer ? (
          <div className="flex items-center justify-between">
            <div>
              <LiveTimer startTime={activeTimer.start_time} />
              {activeTimer.description && (
                <p className="text-xs text-muted-foreground mt-1">{activeTimer.description}</p>
              )}
            </div>
            <Button variant="destructive" size="sm" onClick={onStopTimer}>
              <Square className="h-4 w-4 mr-1" />
              Stop
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Cosa stai facendo?"
              className="h-9"
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            />
            <Button size="sm" className="h-9" onClick={handleStart}>
              <Play className="h-4 w-4 mr-1" />
              Avvia
            </Button>
          </div>
        )}
      </div>

      {/* Manual entry */}
      <div>
        {showManual ? (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex gap-2">
              <Input
                value={manualHours}
                onChange={(e) => setManualHours(e.target.value)}
                placeholder="Ore (es. 1.5)"
                type="number"
                step="0.25"
                min="0"
                className="h-8 w-24"
              />
              <Input
                value={manualDesc}
                onChange={(e) => setManualDesc(e.target.value)}
                placeholder="Descrizione..."
                className="h-8"
              />
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" className="h-7 text-xs" onClick={handleManualAdd} disabled={!manualHours}>
                Salva
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowManual(false)}>
                Annulla
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={() => setShowManual(true)}>
            <Clock className="h-3 w-3 mr-1" />
            Aggiungi tempo manualmente
          </Button>
        )}
      </div>

      {/* Entries list */}
      {entries.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Tempo registrato</span>
            <span className="text-sm text-muted-foreground">
              Totale: {formatDuration(totalMinutes)}
            </span>
          </div>
          <div className="space-y-1">
            {entries.slice(0, 10).map(entry => (
              <div key={entry.id} className="flex items-center justify-between rounded-md p-2 text-sm hover:bg-muted/50 group">
                <div className="flex-1 min-w-0">
                  <span className="text-muted-foreground">
                    {entry.duration_minutes ? formatDuration(entry.duration_minutes) : '—'}
                  </span>
                  {entry.description && (
                    <span className="ml-2 text-muted-foreground truncate">{entry.description}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(entry.start_time).toLocaleDateString('it-IT')}
                  </span>
                  <button
                    onClick={() => onDeleteEntry(entry.id)}
                    className="opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive/80"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
