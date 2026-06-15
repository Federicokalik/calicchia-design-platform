import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Sparkles, Send, Trash2, Upload, Loader2, MessageSquare, FileText, ImageIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { siteAsset } from '@/lib/public-urls';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/hooks/use-confirm';
import type { CampaignAsset, CampaignAssetFeedback, AssetType } from '@/types/marketing';
import {
  ASSET_TYPE_LABELS, ASSET_STATUS_LABELS, APPROVAL_STATUS_LABELS,
} from '@/types/marketing';

const APPROVAL_COLOR: Record<string, string> = {
  pending: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  revision_requested: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const TEXT_TYPES: AssetType[] = ['copy'];

export function AssetSection({ campaignId, assets }: { campaignId: string; assets: CampaignAsset[] }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ asset_name: '', asset_type: 'image' as AssetType, file_url: '', text: '' });
  const [uploading, setUploading] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [openFeedback, setOpenFeedback] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });

  const isText = TEXT_TYPES.includes(form.asset_type);

  const createMutation = useMutation({
    mutationFn: async () =>
      apiFetch(`/api/marketing/campaigns/${campaignId}/assets`, {
        method: 'POST',
        body: JSON.stringify({
          asset_name: form.asset_name.trim(),
          asset_type: form.asset_type,
          file_url: isText ? null : (form.file_url || null),
          notes: isText ? form.text : null,
        }),
      }),
    onSuccess: () => {
      invalidate();
      setShowAdd(false);
      setForm({ asset_name: '', asset_type: 'image', file_url: '', text: '' });
      toast.success('Asset aggiunto');
    },
    onError: (e: Error) => toast.error(e.message || 'Errore'),
  });

  const submitMutation = useMutation({
    mutationFn: async (assetId: string) =>
      apiFetch(`/api/marketing/campaigns/${campaignId}/assets/${assetId}/submit`, { method: 'POST' }),
    onSuccess: () => { invalidate(); toast.success('Inviato al cliente per approvazione'); },
    onError: (e: Error) => toast.error(e.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (assetId: string) =>
      apiFetch(`/api/marketing/campaigns/${campaignId}/assets/${assetId}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); toast.success('Asset eliminato'); },
    onError: (e: Error) => toast.error(e.message || 'Errore'),
  });

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('folder', 'campaigns');
      const data = await apiFetch('/api/media/upload', { method: 'POST', body: fd });
      setForm((f) => ({ ...f, file_url: data.url, asset_name: f.asset_name || file.name }));
      toast.success('File caricato');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload fallito');
    } finally {
      setUploading(false);
    }
  }

  async function handleAiCopy() {
    setAiBusy(true);
    try {
      const data = await apiFetch(`/api/marketing/campaigns/${campaignId}/ai/copy`, {
        method: 'POST',
        body: JSON.stringify({ brief: form.text, kind: 'social_post' }),
      });
      setForm((f) => ({ ...f, text: data.copy || '' }));
      toast.success('Copy generato');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generazione fallita');
    } finally {
      setAiBusy(false);
    }
  }

  async function handleAiImage() {
    setAiBusy(true);
    try {
      const data = await apiFetch(`/api/marketing/campaigns/${campaignId}/ai/image`, {
        method: 'POST',
        body: JSON.stringify({ prompt: form.asset_name || undefined }),
      });
      setForm((f) => ({ ...f, file_url: data.url }));
      toast.success('Immagine generata');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generazione fallita');
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> Aggiungi asset
        </Button>
      </div>

      {assets.length === 0 ? (
        <EmptyState icon={ImageIcon} title="Nessun asset" description="Aggiungi creatività (immagini, video, copy) da far approvare al cliente." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {assets.map((a) => (
            <div key={a.id} className="rounded-lg border bg-card overflow-hidden flex flex-col">
              {a.file_url && (a.asset_type === 'image' || a.asset_type === 'graphic') ? (
                <img src={siteAsset(a.file_url)} alt={a.asset_name} className="aspect-video w-full object-cover bg-muted" />
              ) : (
                <div className="aspect-video w-full bg-muted flex items-center justify-center">
                  {a.asset_type === 'copy'
                    ? <FileText className="h-8 w-8 text-muted-foreground" />
                    : <ImageIcon className="h-8 w-8 text-muted-foreground" />}
                </div>
              )}
              <div className="p-3 space-y-2 flex-1 flex flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{a.asset_name}</p>
                    <p className="text-xs text-muted-foreground">{ASSET_TYPE_LABELS[a.asset_type]} · v{a.version}</p>
                  </div>
                  <Badge variant="outline" className={cn('text-[10px] shrink-0', APPROVAL_COLOR[a.approval_status])}>
                    {APPROVAL_STATUS_LABELS[a.approval_status]}
                  </Badge>
                </div>
                {a.asset_type === 'copy' && a.notes && (
                  <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">{a.notes}</p>
                )}
                <div className="flex items-center gap-1.5 mt-auto pt-1">
                  <span className="text-[10px] text-muted-foreground">{ASSET_STATUS_LABELS[a.status]}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost" size="sm" className="h-7 px-2"
                      onClick={() => setOpenFeedback(openFeedback === a.id ? null : a.id)}
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                    </Button>
                    {a.status !== 'review' && a.status !== 'approved' && (
                      <Button
                        variant="outline" size="sm" className="h-7 px-2"
                        disabled={submitMutation.isPending}
                        onClick={() => submitMutation.mutate(a.id)}
                        title="Invia al cliente per approvazione"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost" size="sm" className="h-7 px-2 text-destructive"
                      onClick={async () => {
                        if (await confirm({ title: 'Eliminare l\'asset?', variant: 'destructive' })) {
                          deleteMutation.mutate(a.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {openFeedback === a.id && <FeedbackThread campaignId={campaignId} assetId={a.id} />}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add asset dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Aggiungi asset</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Nome *</Label>
                <Input value={form.asset_name} onChange={(e) => setForm({ ...form, asset_name: e.target.value })} placeholder="Es. Post lancio" />
              </div>
              <div className="space-y-1.5">
                <Label>Tipo</Label>
                <Select value={form.asset_type} onValueChange={(v) => setForm({ ...form, asset_type: v as AssetType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(ASSET_TYPE_LABELS).map(([k, l]) => (
                      <SelectItem key={k} value={k}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isText ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Testo</Label>
                  <Button type="button" variant="ghost" size="sm" className="h-7" disabled={aiBusy} onClick={handleAiCopy}>
                    {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
                    Genera con AI
                  </Button>
                </div>
                <Textarea rows={6} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Scrivi un brief e genera, oppure incolla il copy…" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>File</Label>
                  {(form.asset_type === 'image' || form.asset_type === 'graphic') && (
                    <Button type="button" variant="ghost" size="sm" className="h-7" disabled={aiBusy} onClick={handleAiImage}>
                      {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
                      Genera con AI
                    </Button>
                  )}
                </div>
                {form.file_url ? (
                  <div className="flex items-center gap-2 rounded-md border p-2">
                    <span className="text-xs truncate flex-1">{form.file_url}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, file_url: '' })}>Rimuovi</Button>
                  </div>
                ) : (
                  <label className={cn('flex items-center justify-center gap-2 rounded-md border border-dashed p-4 cursor-pointer text-sm text-muted-foreground hover:border-muted-foreground/50', uploading && 'opacity-50')}>
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {uploading ? 'Caricamento…' : 'Carica file'}
                    <input
                      type="file" className="hidden" disabled={uploading}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
                    />
                  </label>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Annulla</Button>
            <Button
              disabled={!form.asset_name.trim() || createMutation.isPending || (isText ? !form.text.trim() : !form.file_url)}
              onClick={() => createMutation.mutate()}
            >
              Aggiungi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FeedbackThread({ campaignId, assetId }: { campaignId: string; assetId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['campaign-asset-feedback', assetId],
    queryFn: () => apiFetch(`/api/marketing/campaigns/${campaignId}/assets/${assetId}/feedback`),
  });
  const feedback: CampaignAssetFeedback[] = data?.feedback || [];

  if (isLoading) return <p className="text-xs text-muted-foreground">Caricamento…</p>;
  if (feedback.length === 0) return <p className="text-xs text-muted-foreground border-t pt-2">Nessun feedback ancora.</p>;

  return (
    <div className="border-t pt-2 space-y-1.5">
      {feedback.map((f) => (
        <div key={f.id} className="text-xs">
          <span className={cn('font-medium', f.feedback_type === 'approval' ? 'text-emerald-600' : 'text-amber-600')}>
            {f.author_name || (f.author_type === 'client' ? 'Cliente' : 'Studio')}
          </span>
          <span className="text-muted-foreground"> · {f.feedback_type === 'approval' ? 'Approvato' : 'Revisione'}</span>
          <p className="text-muted-foreground whitespace-pre-wrap">{f.feedback_text}</p>
        </div>
      ))}
    </div>
  );
}
