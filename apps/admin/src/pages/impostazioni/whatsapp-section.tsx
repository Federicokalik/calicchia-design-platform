import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageCircle, QrCode, LogOut, RefreshCw, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { apiFetch } from '@/lib/api';

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

  const currentMode = defaultAiMode === 'off' && savedDefaultAiMode ? savedDefaultAiMode : defaultAiMode;

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
