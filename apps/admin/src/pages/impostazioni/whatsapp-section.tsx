import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MessageCircle, QrCode, LogOut, RefreshCw, CheckCircle2, XCircle, Loader2,
  Plus, Trash2, ArrowUp, ArrowDown, Info, Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { apiFetch } from '@/lib/api';

interface QuickReply { label: string; text: string }

interface WaStatus {
  configured: boolean;
  connected: boolean;
  phone?: string;
  deviceId?: string;
  displayName?: string;
  reason?: string;
}

interface LinkResp {
  ok: boolean;
  qrCode?: string;
  qrText?: string;
  duration?: number;
  error?: string;
}

export function WhatsAppSection() {
  const qc = useQueryClient();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkData, setLinkData] = useState<LinkResp | null>(null);
  const [defaultAiMode, setDefaultAiMode] = useState<string>('off');

  const { data: status, isLoading, refetch } = useQuery<WaStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => apiFetch('/api/whatsapp-admin/status'),
    refetchInterval: 15_000,
  });

  const { data: settingsData } = useQuery({
    queryKey: ['settings', 'whatsapp'],
    queryFn: () => apiFetch('/api/settings'),
  });

  const settings = (((settingsData as any)?.settings ?? settingsData) || {}) as Record<string, any>;
  const whatsappSettings = settings['whatsapp'] || {};
  const savedDefaultAiMode = whatsappSettings.default_ai_mode || 'off';
  const savedDisclaimer: string = typeof whatsappSettings.first_contact_disclaimer === 'string' ? whatsappSettings.first_contact_disclaimer : '';
  const savedQuickReplies: QuickReply[] = Array.isArray(whatsappSettings.quick_replies) ? whatsappSettings.quick_replies : [];
  const savedAiPrompt: string = typeof whatsappSettings.ai_system_prompt === 'string' ? whatsappSettings.ai_system_prompt : '';

  const [disclaimer, setDisclaimer] = useState<string>('');
  const [disclaimerDirty, setDisclaimerDirty] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickRepliesDirty, setQuickRepliesDirty] = useState(false);
  const [aiPrompt, setAiPrompt] = useState<string>('');
  const [aiPromptDirty, setAiPromptDirty] = useState(false);

  // Sync local edit state from server whenever the server snapshot changes
  // and the user hasn't made unsaved local edits.
  useEffect(() => {
    if (!disclaimerDirty) setDisclaimer(savedDisclaimer);
  }, [savedDisclaimer, disclaimerDirty]);
  useEffect(() => {
    if (!quickRepliesDirty) setQuickReplies(savedQuickReplies);
    // Stringify guard: the array reference changes every fetch even when content is identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(savedQuickReplies), quickRepliesDirty]);
  useEffect(() => {
    if (!aiPromptDirty) setAiPrompt(savedAiPrompt);
  }, [savedAiPrompt, aiPromptDirty]);

  const linkMutation = useMutation({
    mutationFn: () => apiFetch('/api/whatsapp-admin/link', { method: 'POST' }) as Promise<LinkResp>,
    onSuccess: (resp) => {
      setLinkData(resp);
      setLinkOpen(true);
      setTimeout(() => refetch(), 5000);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore nel collegamento'),
  });

  const logoutMutation = useMutation({
    mutationFn: () => apiFetch('/api/whatsapp-admin/logout', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Disconnesso');
      qc.invalidateQueries({ queryKey: ['whatsapp-status'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore disconnessione'),
  });

  const reconnectMutation = useMutation({
    mutationFn: () => apiFetch('/api/whatsapp-admin/reconnect', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Riconnessione in corso');
      setTimeout(() => refetch(), 2000);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore riconnessione'),
  });

  const saveModeMutation = useMutation({
    mutationFn: (value: string) =>
      apiFetch('/api/settings/whatsapp', {
        method: 'PUT',
        body: JSON.stringify({ value: { ...whatsappSettings, default_ai_mode: value } }),
      }),
    onSuccess: () => {
      toast.success('Salvato');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore salvataggio'),
  });

  const saveDisclaimerMutation = useMutation({
    mutationFn: (value: string) =>
      apiFetch('/api/settings/whatsapp', {
        method: 'PUT',
        body: JSON.stringify({ value: { ...whatsappSettings, first_contact_disclaimer: value } }),
      }),
    onSuccess: () => {
      toast.success('Disclaimer salvato');
      setDisclaimerDirty(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore salvataggio'),
  });

  const saveQuickRepliesMutation = useMutation({
    mutationFn: (value: QuickReply[]) =>
      apiFetch('/api/settings/whatsapp', {
        method: 'PUT',
        body: JSON.stringify({ value: { ...whatsappSettings, quick_replies: value } }),
      }),
    onSuccess: () => {
      toast.success('Risposte rapide salvate');
      setQuickRepliesDirty(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore salvataggio'),
  });

  const saveAiPromptMutation = useMutation({
    mutationFn: (value: string) =>
      apiFetch('/api/settings/whatsapp', {
        method: 'PUT',
        body: JSON.stringify({ value: { ...whatsappSettings, ai_system_prompt: value } }),
      }),
    onSuccess: () => {
      toast.success('Prompt AI salvato');
      setAiPromptDirty(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore salvataggio'),
  });

  const currentMode = defaultAiMode === 'off' && savedDefaultAiMode ? savedDefaultAiMode : defaultAiMode;

  // Quick replies — local CRUD helpers
  const addQuickReply = () => {
    setQuickReplies((arr) => [...arr, { label: '', text: '' }]);
    setQuickRepliesDirty(true);
  };
  const removeQuickReply = (idx: number) => {
    setQuickReplies((arr) => arr.filter((_, i) => i !== idx));
    setQuickRepliesDirty(true);
  };
  const moveQuickReply = (idx: number, dir: -1 | 1) => {
    setQuickReplies((arr) => {
      const next = [...arr];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return arr;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setQuickRepliesDirty(true);
  };
  const updateQuickReply = (idx: number, patch: Partial<QuickReply>) => {
    setQuickReplies((arr) => arr.map((q, i) => i === idx ? { ...q, ...patch } : q));
    setQuickRepliesDirty(true);
  };

  const disclaimerSentinelPresent = disclaimer.includes('/clienti/preferenze');
  const disclaimerHasContent = disclaimer.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <MessageCircle className="h-5 w-5" /> WhatsApp (GOWA)
        </h2>
        <p className="text-sm text-muted-foreground">
          Gateway WhatsApp self-hosted su gowa.calicchia.design. Collega il numero, gestisci la sessione e il comportamento AI di default.
        </p>
      </div>

      {/* Stato connessione */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Stato connessione</p>
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Verifica in corso…</p>
            ) : !status?.configured ? (
              <p className="text-xs text-amber-600">
                {status?.reason || 'GOWA_URL non configurato nel .env'}
              </p>
            ) : status?.connected ? (
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Connesso
                </Badge>
                {status.phone && <span className="text-muted-foreground">{status.phone}</span>}
                {status.displayName && <span className="text-muted-foreground">— {status.displayName}</span>}
              </div>
            ) : (
              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
                <XCircle className="h-3 w-3 mr-1" /> Non connesso
              </Badge>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Aggiorna
            </Button>
            {status?.connected ? (
              <>
                <Button size="sm" variant="outline" onClick={() => reconnectMutation.mutate()} disabled={reconnectMutation.isPending}>
                  Riconnetti
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="destructive">
                      <LogOut className="h-3.5 w-3.5 mr-1" /> Disconnetti
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnettere il numero WhatsApp?</AlertDialogTitle>
                      <AlertDialogDescription>
                        La sessione corrente verrà terminata. Lo storico messaggi resta salvato. Per riconnettere dovrai scansionare di nuovo il QR.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annulla</AlertDialogCancel>
                      <AlertDialogAction onClick={() => logoutMutation.mutate()}>
                        Disconnetti
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            ) : (
              <Button size="sm" onClick={() => linkMutation.mutate()} disabled={!status?.configured || linkMutation.isPending}>
                {linkMutation.isPending ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Generazione QR…</>
                ) : (
                  <><QrCode className="h-3.5 w-3.5 mr-1" /> Collega numero</>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Default AI mode */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <div>
          <p className="text-sm font-medium">Modalità AI di default (nuove conversazioni)</p>
          <p className="text-xs text-muted-foreground">
            Cambia il comportamento AI di una conversazione già esistente direttamente dall'inbox WhatsApp.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={currentMode} onValueChange={(v) => { setDefaultAiMode(v); saveModeMutation.mutate(v); }}>
            <SelectTrigger className="w-[260px] h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off — l'AI non interviene</SelectItem>
              <SelectItem value="triage">Triage — bozza per approvazione</SelectItem>
              <SelectItem value="auto_reply">Auto-reply — invio diretto</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
          <p><b>Off</b>: messaggi entranti solo nell'inbox, risposta manuale.</p>
          <p><b>Triage</b>: l'AI prepara una bozza, la trovi nell'inbox con i pulsanti "Approva e invia" / "Modifica" / "Scarta".</p>
          <p><b>Auto-reply</b>: l'AI risponde subito, senza approvazione. Usalo solo per FAQ semplici.</p>
        </div>
      </div>

      {/* Disclaimer GDPR primo contatto */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <div>
          <p className="text-sm font-medium">Disclaimer GDPR di primo contatto</p>
          <p className="text-xs text-muted-foreground">
            Accodato automaticamente al primo messaggio outbound verso un numero mai contattato (obbligo art. 13 GDPR, decisione Garante 330/2025). Lascia vuoto per usare il testo di default.
          </p>
        </div>
        <Textarea
          value={disclaimer}
          onChange={(e) => { setDisclaimer(e.target.value); setDisclaimerDirty(true); }}
          placeholder="Testo del disclaimer. Verrà aggiunto a capo dopo il messaggio dell'admin al primo contatto."
          className="min-h-[160px] text-sm font-mono"
        />
        {disclaimerHasContent && !disclaimerSentinelPresent && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Stringa <code>/clienti/preferenze</code> assente</p>
              <p>Questa URL è la sentinella anti-doppio-disclaimer. Se il template non la contiene, il sistema potrebbe accodare il disclaimer due volte in alcuni edge case (es. messaggi composti manualmente). Consigliato includerla nel link "Gestione preferenze".</p>
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {disclaimerDirty && <Badge variant="outline">Modifiche non salvate</Badge>}
          <Button
            size="sm"
            onClick={() => saveDisclaimerMutation.mutate(disclaimer)}
            disabled={!disclaimerDirty || saveDisclaimerMutation.isPending}
          >
            {saveDisclaimerMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Salva disclaimer
          </Button>
        </div>
      </div>

      {/* Quick replies */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Risposte rapide</p>
            <p className="text-xs text-muted-foreground">
              Frasi salvate richiamabili dal composer WhatsApp con il pulsante <Badge variant="outline" className="px-1 py-0 text-[10px]">⚡</Badge>. Solo plain text, niente template variabili.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={addQuickReply}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Aggiungi
          </Button>
        </div>

        {quickReplies.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-2">Nessuna risposta rapida configurata.</p>
        ) : (
          <div className="space-y-3">
            {quickReplies.map((qr, idx) => (
              <div key={idx} className="rounded-md border bg-background p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={qr.label}
                    onChange={(e) => updateQuickReply(idx, { label: e.target.value })}
                    placeholder="Etichetta (es. 'Orari studio')"
                    className="h-8 text-sm font-medium flex-1"
                    maxLength={60}
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => moveQuickReply(idx, -1)} disabled={idx === 0} title="Sposta su">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => moveQuickReply(idx, 1)} disabled={idx === quickReplies.length - 1} title="Sposta giù">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600 hover:text-red-700" onClick={() => removeQuickReply(idx)} title="Elimina">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Textarea
                  value={qr.text}
                  onChange={(e) => updateQuickReply(idx, { text: e.target.value })}
                  placeholder="Testo della risposta…"
                  className="min-h-[60px] text-sm"
                  maxLength={2000}
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {quickRepliesDirty && <Badge variant="outline">Modifiche non salvate</Badge>}
          <Button
            size="sm"
            onClick={() => saveQuickRepliesMutation.mutate(quickReplies.filter((q) => q.label.trim() && q.text.trim()))}
            disabled={!quickRepliesDirty || saveQuickRepliesMutation.isPending}
          >
            {saveQuickRepliesMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Salva risposte rapide
          </Button>
        </div>
      </div>

      {/* Prompt AI WhatsApp */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <div>
          <p className="text-sm font-medium">Prompt AI (system)</p>
          <p className="text-xs text-muted-foreground">
            System prompt usato dall'IA per generare bozze e auto-reply su WhatsApp. Lascia vuoto per usare il prompt di default (audited). Per istruzioni specifiche a un singolo cliente, usa "Istruzioni AI" dentro la singola chat.
          </p>
        </div>
        <Textarea
          value={aiPrompt}
          onChange={(e) => { setAiPrompt(e.target.value); setAiPromptDirty(true); }}
          placeholder="Vuoto = prompt di default. Sovrascrivi solo se vuoi cambiare tono / regole base."
          className="min-h-[180px] text-sm font-mono"
        />
        <div className="flex items-center justify-end gap-2">
          {aiPromptDirty && <Badge variant="outline">Modifiche non salvate</Badge>}
          <Button
            size="sm"
            onClick={() => saveAiPromptMutation.mutate(aiPrompt)}
            disabled={!aiPromptDirty || saveAiPromptMutation.isPending}
          >
            {saveAiPromptMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Salva prompt AI
          </Button>
        </div>
      </div>

      {/* Dialog QR */}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scansiona il QR con WhatsApp</DialogTitle>
            <DialogDescription>
              Apri WhatsApp sul telefono → Impostazioni → Dispositivi collegati → Collega un dispositivo. Il QR scade tra ~{linkData?.duration ?? 20} secondi.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center py-4">
            {linkData?.qrCode ? (
              <img src={linkData.qrCode} alt="QR WhatsApp" className="w-64 h-64" />
            ) : linkData?.qrText ? (
              <code className="text-[10px] break-all p-3 bg-muted rounded">{linkData.qrText}</code>
            ) : (
              <Loader2 className="h-8 w-8 animate-spin" />
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => { setLinkOpen(false); refetch(); }}>Ho scansionato</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
