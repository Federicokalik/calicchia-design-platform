import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Filter, Plus, Trash2, Eye, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface MktSegment {
  id: string;
  name: string;
  description: string | null;
  definition: Record<string, unknown>;
  created_at: string;
}

interface Definition {
  audience_type?: 'warm' | 'cold';
  email_consent?: string[];
  tags_any?: string[];
  industry?: string;
  country?: string;
  has_email?: boolean;
  has_phone?: boolean;
}

function buildDefinition(s: {
  audience: string; consent: string; tags: string; industry: string; country: string; channel: string;
}): Definition {
  const def: Definition = {};
  if (s.audience !== 'any') def.audience_type = s.audience as 'warm' | 'cold';
  if (s.consent !== 'any') def.email_consent = [s.consent];
  const tags = s.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.length) def.tags_any = tags;
  if (s.industry.trim()) def.industry = s.industry.trim();
  if (s.country.trim()) def.country = s.country.trim();
  if (s.channel === 'email') def.has_email = true;
  if (s.channel === 'phone') def.has_phone = true;
  return def;
}

export default function SegmentsPage() {
  const queryClient = useQueryClient();
  const [builderOpen, setBuilderOpen] = useState(false);

  const { data, isLoading } = useQuery<{ segments: MktSegment[] }>({
    queryKey: ['mkt-segments'],
    queryFn: () => apiFetch('/api/email-marketing/segments'),
  });
  const segments = data?.segments ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/email-marketing/segments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-segments'] });
      toast.success('Segmento eliminato');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Eliminazione fallita'),
  });

  const actions = useMemo(() => (
    <Button size="sm" onClick={() => setBuilderOpen(true)} className="gap-1.5">
      <Plus className="h-4 w-4" /> Nuovo segmento
    </Button>
  ), []);

  useTopbar({ title: 'Segmenti', subtitle: `${segments.length} segmenti (filtri salvati)`, actions });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      {segments.length === 0 ? (
        <EmptyState
          title="Nessun segmento"
          description="I segmenti sono filtri salvati e ri-valutabili (es. 'freddi B2B nel settore design')."
          icon={Filter}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => (
            <div key={s.id} className="rounded-lg border bg-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium truncate">{s.name}</h3>
                  {s.description && <p className="text-xs text-muted-foreground line-clamp-2">{s.description}</p>}
                </div>
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => deleteMutation.mutate(s.id)} aria-label="Elimina">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(s.definition).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="text-[10px]">{k}: {Array.isArray(v) ? v.join('/') : String(v)}</Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <SegmentBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
    </div>
  );
}

function SegmentBuilder({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [audience, setAudience] = useState('any');
  const [consent, setConsent] = useState('any');
  const [tags, setTags] = useState('');
  const [industry, setIndustry] = useState('');
  const [country, setCountry] = useState('');
  const [channel, setChannel] = useState('any');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const definition = buildDefinition({ audience, consent, tags, industry, country, channel });

  async function runPreview() {
    setPreviewing(true);
    try {
      const res = await apiFetch('/api/email-marketing/segments/preview', {
        method: 'POST', body: JSON.stringify({ definition }),
      });
      setPreviewCount(res.count);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Anteprima fallita');
    } finally { setPreviewing(false); }
  }

  const saveMutation = useMutation({
    mutationFn: () => apiFetch('/api/email-marketing/segments', {
      method: 'POST',
      body: JSON.stringify({ name, definition }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mkt-segments'] });
      toast.success('Segmento salvato');
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Salvataggio fallito'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo segmento</DialogTitle>
          <DialogDescription>Filtro salvato sull'audience. Lascia "qualsiasi" per non filtrare un campo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="es. Freddi B2B design" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Tipo audience</Label>
              <Select value={audience} onValueChange={setAudience}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Qualsiasi</SelectItem>
                  <SelectItem value="warm">Caldi</SelectItem>
                  <SelectItem value="cold">Freddi</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Consenso email</Label>
              <Select value={consent} onValueChange={setConsent}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Qualsiasi</SelectItem>
                  <SelectItem value="confirmed">Confermati</SelectItem>
                  <SelectItem value="unconfirmed">Da confermare</SelectItem>
                  <SelectItem value="unsubscribed">Disiscritti</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Settore</Label>
              <Input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="es. design" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Paese</Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="es. Italia" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Canale disponibile</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Qualsiasi</SelectItem>
                  <SelectItem value="email">Ha email</SelectItem>
                  <SelectItem value="phone">Ha telefono</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tag (uno qualsiasi)</Label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="apify, milano" />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing} className="gap-1.5">
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Anteprima
            </Button>
            {previewCount !== null && (
              <span className="text-sm text-muted-foreground">{previewCount} contatti corrispondono</span>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annulla</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !name.trim()}>Salva segmento</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
