import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Workflow, Plus, Trash2, Play, Pause, Mail, MessageCircle, Tag, Clock, ArrowDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface Step {
  delay_minutes: number;
  action_type: 'send_email' | 'send_whatsapp' | 'add_tag' | 'wait';
  action_config: Record<string, unknown>;
}
interface Automation {
  id: string; name: string; status: string; trigger_type: string;
  step_count: number; active_runs: number;
}

const TRIGGER_LABELS: Record<string, string> = {
  contact_created: 'Nuovo contatto', tag_added: 'Tag aggiunto', list_joined: 'Iscrizione a lista',
  form_submitted: 'Form inviato', manual: 'Manuale',
};

// Presets informed by the email-sequence skill (welcome / nurture / re-engagement).
const PRESETS: Record<string, { name: string; trigger: string; steps: Step[] }> = {
  welcome: {
    name: 'Benvenuto', trigger: 'form_submitted',
    steps: [
      { delay_minutes: 0, action_type: 'send_email', action_config: { subject: 'Benvenuto!', blocks: [{ type: 'text', text: 'Grazie per esserti iscritto. Ecco cosa aspettarti…' }] } },
      { delay_minutes: 2880, action_type: 'send_email', action_config: { subject: 'Un consiglio per iniziare', blocks: [{ type: 'text', text: 'Ecco un primo spunto utile…' }] } },
      { delay_minutes: 7200, action_type: 'send_email', action_config: { subject: 'Possiamo aiutarti?', blocks: [{ type: 'text', text: 'Se hai un progetto in mente, rispondi a questa email.' }] } },
    ],
  },
  reengage: {
    name: 'Riattivazione', trigger: 'manual',
    steps: [
      { delay_minutes: 0, action_type: 'send_email', action_config: { subject: 'Ci manchi', blocks: [{ type: 'text', text: 'È passato un po\'. Ecco le novità…' }] } },
      { delay_minutes: 4320, action_type: 'send_email', action_config: { subject: 'Ultima occasione', blocks: [{ type: 'text', text: 'Vuoi continuare a ricevere i nostri aggiornamenti?' }] } },
    ],
  },
};

export default function AutomationsPage() {
  const queryClient = useQueryClient();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);

  const { data, isLoading } = useQuery<{ automations: Automation[] }>({
    queryKey: ['mkt-automations'], queryFn: () => apiFetch('/api/email-marketing/automations'),
  });
  const automations = data?.automations ?? [];

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/api/email-marketing/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['mkt-automations'] }); },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Aggiornamento fallito'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/email-marketing/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['mkt-automations'] }); toast.success('Automazione eliminata'); },
  });

  const actions = useMemo(() => (
    <Button size="sm" onClick={() => { setEditing(null); setBuilderOpen(true); }} className="gap-1.5">
      <Plus className="h-4 w-4" /> Nuova automazione
    </Button>
  ), []);
  useTopbar({ title: 'Automazioni', subtitle: `${automations.length} automazioni`, actions });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      {automations.length === 0 ? (
        <EmptyState title="Nessuna automazione" description="Crea una sequenza drip (benvenuto, nurture, riattivazione)." icon={Workflow} />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {automations.map((a) => (
            <div key={a.id} className="p-3 flex items-center justify-between gap-4 hover:bg-muted/40">
              <button className="flex-1 min-w-0 text-left" onClick={() => { setEditing(a); setBuilderOpen(true); }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{a.name}</span>
                  <Badge variant={a.status === 'active' ? 'default' : 'secondary'} className="text-[10px]">{a.status}</Badge>
                  <Badge variant="outline" className="text-[10px]">{TRIGGER_LABELS[a.trigger_type] ?? a.trigger_type}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{a.step_count} step · {a.active_runs} in corso</p>
              </button>
              <div className="flex gap-1 shrink-0">
                {a.status === 'active' ? (
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => statusMutation.mutate({ id: a.id, status: 'paused' })} aria-label="Pausa"><Pause className="h-4 w-4" /></Button>
                ) : (
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => statusMutation.mutate({ id: a.id, status: 'active' })} aria-label="Attiva"><Play className="h-4 w-4" /></Button>
                )}
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => deleteMutation.mutate(a.id)} aria-label="Elimina"><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {builderOpen && <Builder editing={editing} onClose={() => setBuilderOpen(false)} />}
    </div>
  );
}

function Builder({ editing, onClose }: { editing: Automation | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: loaded } = useQuery<{ automation: any; steps: Step[] }>({
    queryKey: ['mkt-automation', editing?.id],
    queryFn: () => apiFetch(`/api/email-marketing/automations/${editing!.id}`),
    enabled: !!editing,
  });

  const [name, setName] = useState(editing?.name ?? '');
  const [trigger, setTrigger] = useState(editing?.trigger_type ?? 'manual');
  const [steps, setSteps] = useState<Step[]>([]);
  const [hydrated, setHydrated] = useState(!editing);

  if (editing && loaded && !hydrated) {
    setName(loaded.automation.name);
    setTrigger(loaded.automation.trigger_type);
    setSteps(loaded.steps.map((s) => ({ delay_minutes: s.delay_minutes, action_type: s.action_type, action_config: s.action_config })));
    setHydrated(true);
  }

  function applyPreset(key: string) {
    const p = PRESETS[key]; if (!p) return;
    setName(p.name); setTrigger(p.trigger); setSteps(p.steps.map((s) => ({ ...s })));
  }
  function addStep() { setSteps([...steps, { delay_minutes: 1440, action_type: 'send_email', action_config: { subject: '', blocks: [{ type: 'text', text: '' }] } }]); }
  function updateStep(i: number, patch: Partial<Step>) { setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s))); }
  function updateConfig(i: number, patch: Record<string, unknown>) { setSteps(steps.map((s, idx) => (idx === i ? { ...s, action_config: { ...s.action_config, ...patch } } : s))); }
  function removeStep(i: number) { setSteps(steps.filter((_, idx) => idx !== i)); }

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({ name, trigger_type: trigger, steps });
      return editing
        ? apiFetch(`/api/email-marketing/automations/${editing.id}`, { method: 'PATCH', body })
        : apiFetch('/api/email-marketing/automations', { method: 'POST', body });
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['mkt-automations'] }); toast.success('Salvato'); onClose(); },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Salvataggio fallito'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Modifica automazione' : 'Nuova automazione'}</DialogTitle>
          <DialogDescription>Sequenza di step eseguiti in ordine. Il ritardo è applicato prima di ogni step.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!editing && (
            <div className="flex gap-2">
              <span className="text-xs text-muted-foreground self-center">Preset:</span>
              <Button variant="outline" size="sm" onClick={() => applyPreset('welcome')}>Benvenuto</Button>
              <Button variant="outline" size="sm" onClick={() => applyPreset('reengage')}>Riattivazione</Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Trigger</Label>
              <Select value={trigger} onValueChange={setTrigger}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TRIGGER_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i}>
                {i > 0 && <div className="flex justify-center"><ArrowDown className="h-4 w-4 text-muted-foreground" /></div>}
                <div className="rounded-lg border p-3 space-y-2 bg-card">
                  <div className="flex items-center gap-2">
                    <StepIcon type={s.action_type} />
                    <Select value={s.action_type} onValueChange={(v) => updateStep(i, { action_type: v as Step['action_type'] })}>
                      <SelectTrigger className="w-44 h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="send_email">Invia email</SelectItem>
                        <SelectItem value="send_whatsapp">Invia WhatsApp</SelectItem>
                        <SelectItem value="add_tag">Aggiungi tag</SelectItem>
                        <SelectItem value="wait">Attendi</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1 ml-auto">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <Input type="number" value={s.delay_minutes} onChange={(e) => updateStep(i, { delay_minutes: Number(e.target.value) || 0 })} className="w-24 h-8" />
                      <span className="text-xs text-muted-foreground">min prima</span>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => removeStep(i)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                  {s.action_type === 'send_email' && (
                    <div className="space-y-2">
                      <Input value={(s.action_config.subject as string) ?? ''} onChange={(e) => updateConfig(i, { subject: e.target.value })} placeholder="Oggetto" />
                      <Textarea
                        value={(((s.action_config.blocks as any[])?.[0]?.text) as string) ?? ''}
                        onChange={(e) => updateConfig(i, { blocks: [{ type: 'text', text: e.target.value }] })}
                        placeholder="Testo dell'email…" className="min-h-[80px]" />
                    </div>
                  )}
                  {s.action_type === 'send_whatsapp' && (
                    <Textarea value={(s.action_config.body as string) ?? ''} onChange={(e) => updateConfig(i, { body: e.target.value })} placeholder="Messaggio WhatsApp…" className="min-h-[60px]" />
                  )}
                  {s.action_type === 'add_tag' && (
                    <Input value={(s.action_config.tag as string) ?? ''} onChange={(e) => updateConfig(i, { tag: e.target.value })} placeholder="Nome tag" />
                  )}
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addStep} className="gap-1.5"><Plus className="h-3.5 w-3.5" /> Aggiungi step</Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !name.trim() || steps.length === 0}>Salva</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepIcon({ type }: { type: Step['action_type'] }) {
  const cls = 'h-4 w-4 text-muted-foreground';
  if (type === 'send_email') return <Mail className={cls} />;
  if (type === 'send_whatsapp') return <MessageCircle className={cls} />;
  if (type === 'add_tag') return <Tag className={cls} />;
  return <Clock className={cls} />;
}
