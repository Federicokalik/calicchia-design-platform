import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Save, RefreshCw, Loader2, Edit3, X, Sparkles } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';

type Category = 'importanti' | 'normali' | 'aggiornamenti' | 'marketing' | 'spam';

interface MailRule {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  match_from: string | null;
  match_subject: string | null;
  match_has_unsubscribe: boolean | null;
  set_category: Category;
}

const CATEGORY_LABELS: Record<Category, string> = {
  importanti: 'Importanti',
  normali: 'Normali',
  aggiornamenti: 'Aggiornamenti',
  marketing: 'Marketing',
  spam: 'Spam',
};

const CATEGORY_COLORS: Record<Category, string> = {
  importanti: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30',
  normali: 'text-blue-600 bg-blue-50 dark:bg-blue-950/30',
  aggiornamenti: 'text-violet-600 bg-violet-50 dark:bg-violet-950/30',
  marketing: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30',
  spam: 'text-red-600 bg-red-50 dark:bg-red-950/30',
};

interface RulesDialogProps {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  id?: string;
  name: string;
  priority: number;
  active: boolean;
  match_from: string;
  match_subject: string;
  match_has_unsubscribe: 'any' | 'yes' | 'no';
  set_category: Category;
}

const emptyForm: FormState = {
  name: '',
  priority: 100,
  active: true,
  match_from: '',
  match_subject: '',
  match_has_unsubscribe: 'any',
  set_category: 'normali',
};

export function RulesDialog({ open, onClose }: RulesDialogProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<FormState | null>(null);

  const { data, isLoading } = useQuery<{ rules: MailRule[] }>({
    queryKey: ['mail-rules'],
    queryFn: () => apiFetch('/api/mail/rules'),
    enabled: open,
  });
  const rules = data?.rules ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['mail-rules'] });
    queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
  };

  const saveMutation = useMutation({
    mutationFn: async (state: FormState) => {
      const payload = {
        name: state.name,
        priority: state.priority,
        active: state.active,
        match_from: state.match_from || null,
        match_subject: state.match_subject || null,
        match_has_unsubscribe:
          state.match_has_unsubscribe === 'any' ? null
          : state.match_has_unsubscribe === 'yes' ? true : false,
        set_category: state.set_category,
      };
      if (state.id) {
        return apiFetch(`/api/mail/rules/${state.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      return apiFetch('/api/mail/rules', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      toast.success('Regola salvata');
      setEditing(null);
      invalidate();
    },
    onError: (err) => toast.error(`Errore: ${(err as Error).message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiFetch(`/api/mail/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Regola eliminata');
      invalidate();
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => apiFetch('/api/mail/rules/apply', { method: 'POST' }),
    onSuccess: (res: any) => {
      toast.success(`${res.updated} email riclassificate su ${res.scanned}`);
      invalidate();
    },
    onError: (err) => toast.error(`Applicazione fallita: ${(err as Error).message}`),
  });

  const aiClassifyMutation = useMutation({
    mutationFn: async () =>
      apiFetch('/api/mail/messages/classify-ai', {
        method: 'POST',
        body: JSON.stringify({ limit: 50, only_normali: true }),
      }),
    onSuccess: (res: any) => {
      const parts = Object.entries(res.distribution || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      toast.success(
        `IA: ${res.updated}/${res.scanned} ricategorizzate${parts ? ` (${parts})` : ''}${res.failed ? ` · ${res.failed} fallite` : ''}`,
        { duration: 6000 },
      );
      invalidate();
    },
    onError: (err) => toast.error(`Classificazione IA fallita: ${(err as Error).message}`),
  });

  const startEdit = (r: MailRule) => {
    setEditing({
      id: r.id,
      name: r.name,
      priority: r.priority,
      active: r.active,
      match_from: r.match_from || '',
      match_subject: r.match_subject || '',
      match_has_unsubscribe:
        r.match_has_unsubscribe === null ? 'any' : r.match_has_unsubscribe ? 'yes' : 'no',
      set_category: r.set_category,
    });
  };

  const canSave = editing
    && editing.name.trim()
    && (editing.match_from || editing.match_subject || editing.match_has_unsubscribe !== 'any');

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setEditing(null); } }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center justify-between pr-4">
            <DialogTitle>Regole di filtraggio</DialogTitle>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={aiClassifyMutation.isPending}
                onClick={() => aiClassifyMutation.mutate()}
                title="Usa l'IA per ri-categorizzare le email in 'Normali' (costa qualche token)"
              >
                {aiClassifyMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Sparkles className="h-3.5 w-3.5" />}
                Classifica con IA
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={applyMutation.isPending}
                onClick={() => applyMutation.mutate()}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', applyMutation.isPending && 'animate-spin')} />
                Applica regole
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Rules list */}
        {!editing && (
          <div className="space-y-2 max-h-[50vh] overflow-auto">
            {isLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : rules.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                Nessuna regola configurata. Aggiungi la prima in basso.
              </div>
            ) : (
              rules.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'rounded-md border p-3 flex items-center gap-3',
                    !r.active && 'opacity-50',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{r.name}</span>
                      <span className={cn('text-[10px] rounded px-1.5 py-0.5 font-medium', CATEGORY_COLORS[r.set_category])}>
                        → {CATEGORY_LABELS[r.set_category]}
                      </span>
                      {!r.active && <span className="text-[10px] text-muted-foreground">(disattiva)</span>}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 flex gap-3 flex-wrap">
                      {r.match_from && <span>from: <code className="bg-muted px-1 rounded">{r.match_from}</code></span>}
                      {r.match_subject && <span>subject: <code className="bg-muted px-1 rounded">{r.match_subject}</code></span>}
                      {r.match_has_unsubscribe !== null && <span>unsubscribe: {r.match_has_unsubscribe ? 'sì' : 'no'}</span>}
                      <span className="ml-auto">priorità {r.priority}</span>
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => startEdit(r)}>
                    <Edit3 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(r.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Editor */}
        {editing && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{editing.id ? 'Modifica regola' : 'Nuova regola'}</h3>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Nome regola</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Es. Newsletter GitHub"
                />
              </div>
              <div>
                <Label>Categoria destinazione</Label>
                <Select
                  value={editing.set_category}
                  onValueChange={(v) => setEditing({ ...editing, set_category: v as Category })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => (
                      <SelectItem key={k} value={k}>{CATEGORY_LABELS[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-md border bg-muted/20 p-3 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Condizioni (tutte quelle compilate devono corrispondere). Usa <code>%</code> come jolly.
              </p>
              <div>
                <Label>Pattern mittente</Label>
                <Input
                  value={editing.match_from}
                  onChange={(e) => setEditing({ ...editing, match_from: e.target.value })}
                  placeholder="es. %@github.com  oppure  mario.rossi@%"
                />
              </div>
              <div>
                <Label>Pattern oggetto</Label>
                <Input
                  value={editing.match_subject}
                  onChange={(e) => setEditing({ ...editing, match_subject: e.target.value })}
                  placeholder="es. %fattura%  oppure  [alert]%"
                />
              </div>
              <div>
                <Label>Header List-Unsubscribe</Label>
                <Select
                  value={editing.match_has_unsubscribe}
                  onValueChange={(v) => setEditing({ ...editing, match_has_unsubscribe: v as 'any' | 'yes' | 'no' })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Qualsiasi</SelectItem>
                    <SelectItem value="yes">Presente (mail bulk/marketing)</SelectItem>
                    <SelectItem value="no">Assente</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Priorità</Label>
                <Input
                  type="number"
                  value={editing.priority}
                  onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value, 10) || 100 })}
                />
                <p className="text-[10px] text-muted-foreground mt-1">Minore = prima nell'ordine di valutazione.</p>
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={editing.active}
                    onCheckedChange={(v) => setEditing({ ...editing, active: v })}
                  />
                  Regola attiva
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Annulla</Button>
              <Button
                disabled={!canSave || saveMutation.isPending}
                onClick={() => saveMutation.mutate(editing)}
              >
                {saveMutation.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  : <Save className="h-4 w-4 mr-2" />}
                Salva
              </Button>
            </div>
          </div>
        )}

        {/* Footer add button when list view */}
        {!editing && (
          <div className="flex justify-end pt-2 border-t">
            <Button size="sm" className="gap-1.5" onClick={() => setEditing({ ...emptyForm })}>
              <Plus className="h-3.5 w-3.5" /> Nuova regola
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
