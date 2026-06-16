import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Save, Send, FlaskConical, Plus, Trash2, ArrowUp, ArrowDown,
  Eye, MousePointerClick, Users, Ban, Sparkles, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

interface Block {
  type: 'heading' | 'text' | 'button' | 'image' | 'divider' | 'spacer';
  text?: string; level?: 1 | 2 | 3; url?: string; src?: string; alt?: string; href?: string; size?: number;
}

const BLOCK_LABELS: Record<Block['type'], string> = {
  heading: 'Titolo', text: 'Testo', button: 'Bottone', image: 'Immagine', divider: 'Separatore', spacer: 'Spazio',
};

export default function CampaignEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ campaign: any }>({
    queryKey: ['mkt-campaign', id],
    queryFn: () => apiFetch(`/api/email-marketing/campaigns/${id}`),
    enabled: !!id,
  });
  const campaign = data?.campaign;

  // local editable state
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [contentMode, setContentMode] = useState<'blocks' | 'html' | 'ai'>('blocks');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [html, setHtml] = useState('');
  const [waBody, setWaBody] = useState('');
  const [audienceKind, setAudienceKind] = useState<string>('');
  const [listId, setListId] = useState<string>('');
  const [segmentId, setSegmentId] = useState<string>('');
  const [fromIdentityId, setFromIdentityId] = useState<string>('');
  const [throttle, setThrottle] = useState(60);
  const [trackOpens, setTrackOpens] = useState(true);
  const [trackClicks, setTrackClicks] = useState(true);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [sendOpen, setSendOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  useEffect(() => {
    if (!campaign) return;
    setName(campaign.name ?? '');
    setSubject(campaign.subject ?? '');
    setPreheader(campaign.preheader ?? '');
    setContentMode(
      campaign.content_mode === 'html' ? 'html' : campaign.content_mode === 'ai' ? 'ai' : 'blocks',
    );
    setBlocks(campaign.content_blocks?.blocks ?? []);
    setHtml(campaign.content_html ?? '');
    setWaBody(campaign.wa_body ?? '');
    setAudienceKind(campaign.audience_kind ?? '');
    setListId(campaign.list_id ?? '');
    setSegmentId(campaign.segment_id ?? '');
    setFromIdentityId(campaign.from_identity_id ?? '');
    setThrottle(campaign.throttle_per_min ?? 60);
    setTrackOpens(campaign.track_opens ?? true);
    setTrackClicks(campaign.track_clicks ?? true);
  }, [campaign]);

  const { data: lists } = useQuery<{ lists: { id: string; name: string }[] }>({
    queryKey: ['mkt-lists'], queryFn: () => apiFetch('/api/email-marketing/lists'),
  });
  const { data: segments } = useQuery<{ segments: { id: string; name: string }[] }>({
    queryKey: ['mkt-segments'], queryFn: () => apiFetch('/api/email-marketing/segments'),
  });
  const { data: senders } = useQuery<{ senders: { id: string; from_name: string; from_email: string }[] }>({
    queryKey: ['mkt-senders'], queryFn: () => apiFetch('/api/email-marketing/senders'),
  });

  const isEditable = campaign && ['draft', 'scheduled', 'paused', 'failed'].includes(campaign.status);
  const isEmail = campaign?.channel === 'email';

  function payload() {
    return {
      name, subject: subject || undefined, preheader: preheader || undefined,
      content_mode: contentMode,
      content_blocks: contentMode === 'blocks' || contentMode === 'ai' ? { blocks } : undefined,
      content_html: contentMode === 'html' ? html : undefined,
      wa_body: waBody || undefined,
      audience_kind: audienceKind || undefined,
      list_id: audienceKind === 'list' ? (listId || null) : null,
      segment_id: audienceKind === 'segment' ? (segmentId || null) : null,
      from_identity_id: fromIdentityId || null,
      throttle_per_min: throttle,
      track_opens: trackOpens, track_clicks: trackClicks,
    };
  }

  const saveMutation = useMutation({
    mutationFn: () => apiFetch(`/api/email-marketing/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(payload()) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['mkt-campaign', id] }); toast.success('Salvato'); },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Salvataggio fallito'),
  });

  const testMutation = useMutation({
    mutationFn: () => apiFetch(`/api/email-marketing/campaigns/${id}/test`, { method: 'POST', body: JSON.stringify({ to: testTo }) }),
    onSuccess: () => { toast.success('Email di test inviata'); setTestOpen(false); },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Invio test fallito'),
  });

  const sendMutation = useMutation({
    mutationFn: () => apiFetch(`/api/email-marketing/campaigns/${id}/send`, {
      method: 'POST', body: JSON.stringify({ scheduled_at: scheduledAt || null }),
    }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['mkt-campaign', id] });
      setSendOpen(false);
      toast.success(`Campagna in coda · ${res.campaign?.total_recipients ?? 0} destinatari`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Invio fallito'),
  });

  // Save first, then send — ensures the latest content/audience are persisted.
  async function handleSend() {
    await saveMutation.mutateAsync();
    sendMutation.mutate();
  }

  if (isLoading || !campaign) return <LoadingState />;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/email-marketing/campagne')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isEditable} className="font-medium max-w-xs" />
        <Badge variant="outline">{campaign.status}</Badge>
        <div className="ml-auto flex gap-2">
          {isEmail && (
            <Button variant="outline" size="sm" onClick={() => setTestOpen(true)} className="gap-1.5">
              <FlaskConical className="h-4 w-4" /> Test
            </Button>
          )}
          {isEditable && (
            <>
              <Button variant="outline" size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-1.5">
                <Save className="h-4 w-4" /> Salva
              </Button>
              <Button size="sm" onClick={() => setSendOpen(true)} className="gap-1.5">
                <Send className="h-4 w-4" /> Invia
              </Button>
            </>
          )}
        </div>
      </div>

      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">Contenuto</TabsTrigger>
          <TabsTrigger value="audience">Destinatari</TabsTrigger>
          <TabsTrigger value="settings">Impostazioni</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>

        {/* ── CONTENT ── */}
        <TabsContent value="content" className="space-y-4 pt-4">
          {isEmail ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Oggetto</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!isEditable} placeholder="Oggetto dell'email" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Preheader (anteprima inbox)</Label>
                <Input value={preheader} onChange={(e) => setPreheader(e.target.value)} disabled={!isEditable} placeholder="Testo di anteprima…" />
              </div>

              <div className="flex items-center gap-2">
                <Label className="text-xs">Modalità contenuto</Label>
                <Select value={contentMode} onValueChange={(v) => setContentMode(v as 'blocks' | 'html' | 'ai')} disabled={!isEditable}>
                  <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blocks">Blocchi</SelectItem>
                    <SelectItem value="ai">AI</SelectItem>
                    <SelectItem value="html">HTML</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {contentMode === 'ai' && isEditable && (
                <AIComposer
                  onGenerated={(copy) => {
                    if (copy.subject) setSubject(copy.subject);
                    if (copy.preheader) setPreheader(copy.preheader);
                    setBlocks(copy.blocks);
                  }}
                />
              )}

              {contentMode === 'html' ? (
                <Textarea value={html} onChange={(e) => setHtml(e.target.value)} disabled={!isEditable}
                  placeholder="<h1>…</h1>" className="font-mono text-xs min-h-[320px]" />
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <BlockEditor blocks={blocks} setBlocks={setBlocks} disabled={!isEditable} />
                  <BlockPreview blocks={blocks} />
                </div>
              )}
            </>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs">Messaggio WhatsApp</Label>
              <Textarea value={waBody} onChange={(e) => setWaBody(e.target.value)} disabled={!isEditable}
                placeholder="Testo del broadcast…" className="min-h-[200px]" />
              <p className="text-xs text-muted-foreground">Inviato solo ai contatti con opt-in marketing esplicito.</p>
            </div>
          )}
        </TabsContent>

        {/* ── AUDIENCE ── */}
        <TabsContent value="audience" className="space-y-4 pt-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Tipo di audience</Label>
            <Select value={audienceKind} onValueChange={setAudienceKind} disabled={!isEditable}>
              <SelectTrigger className="w-56"><SelectValue placeholder="Scegli…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="list">Lista</SelectItem>
                <SelectItem value="segment">Segmento</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {audienceKind === 'list' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Lista</Label>
              <Select value={listId} onValueChange={setListId} disabled={!isEditable}>
                <SelectTrigger className="w-72"><SelectValue placeholder="Scegli lista" /></SelectTrigger>
                <SelectContent>{(lists?.lists ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {audienceKind === 'segment' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Segmento</Label>
              <Select value={segmentId} onValueChange={setSegmentId} disabled={!isEditable}>
                <SelectTrigger className="w-72"><SelectValue placeholder="Scegli segmento" /></SelectTrigger>
                <SelectContent>{(segments?.segments ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <AudiencePreview campaignId={id!} onSaveNeeded={() => saveMutation.mutateAsync()} />
        </TabsContent>

        {/* ── SETTINGS ── */}
        <TabsContent value="settings" className="space-y-4 pt-4">
          {isEmail && (
            <div className="space-y-1.5">
              <Label className="text-xs">Mittente</Label>
              <Select value={fromIdentityId} onValueChange={setFromIdentityId} disabled={!isEditable}>
                <SelectTrigger className="w-72"><SelectValue placeholder="Mittente predefinito" /></SelectTrigger>
                <SelectContent>{(senders?.senders ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.from_name} ({s.from_email})</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Velocità invio (msg/min)</Label>
            <Input type="number" value={throttle} onChange={(e) => setThrottle(Number(e.target.value) || 60)}
              disabled={!isEditable} className="w-32" min={1} max={600} />
            <p className="text-xs text-muted-foreground">WhatsApp: tieni un valore basso (20-30) per evitare ban.</p>
          </div>
          {isEmail && (
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={trackOpens} onChange={(e) => setTrackOpens(e.target.checked)} disabled={!isEditable} />
                Traccia aperture
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={trackClicks} onChange={(e) => setTrackClicks(e.target.checked)} disabled={!isEditable} />
                Traccia click
              </label>
            </div>
          )}
        </TabsContent>

        {/* ── REPORT ── */}
        <TabsContent value="report" className="pt-4">
          <CampaignReport campaign={campaign} />
        </TabsContent>
      </Tabs>

      {/* Test dialog */}
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invia email di test</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Indirizzo email</Label>
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="tu@esempio.it" />
            <p className="text-xs text-muted-foreground">Salva prima le modifiche per testarle.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>Annulla</Button>
            <Button onClick={() => testMutation.mutate()} disabled={testMutation.isPending || !testTo}>Invia test</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send dialog */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invia campagna</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              La campagna verrà salvata e messa in coda. Lascia vuota la data per inviare subito.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Pianifica (opzionale)</Label>
              <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)}>Annulla</Button>
            <Button onClick={handleSend} disabled={sendMutation.isPending || saveMutation.isPending} className="gap-1.5">
              <Send className="h-4 w-4" /> {scheduledAt ? 'Pianifica' : 'Invia ora'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Block editor ──────────────────────────────────────
function BlockEditor({ blocks, setBlocks, disabled }: { blocks: Block[]; setBlocks: (b: Block[]) => void; disabled: boolean }) {
  function update(i: number, patch: Partial<Block>) {
    setBlocks(blocks.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function add(type: Block['type']) {
    const defaults: Record<Block['type'], Block> = {
      heading: { type: 'heading', text: 'Titolo', level: 2 },
      text: { type: 'text', text: 'Scrivi qui il testo…' },
      button: { type: 'button', text: 'Scopri di più', url: 'https://calicchia.design' },
      image: { type: 'image', src: '', alt: '' },
      divider: { type: 'divider' },
      spacer: { type: 'spacer', size: 16 },
    };
    setBlocks([...blocks, defaults[type]]);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    setBlocks(next);
  }
  function remove(i: number) { setBlocks(blocks.filter((_, idx) => idx !== i)); }

  return (
    <div className="space-y-2">
      {blocks.map((b, i) => (
        <div key={i} className="rounded-lg border p-3 space-y-2 bg-card">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">{BLOCK_LABELS[b.type]}</Badge>
            <div className="ml-auto flex gap-1">
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => move(i, -1)} disabled={disabled || i === 0}><ArrowUp className="h-3.5 w-3.5" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => move(i, 1)} disabled={disabled || i === blocks.length - 1}><ArrowDown className="h-3.5 w-3.5" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(i)} disabled={disabled}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          {b.type === 'heading' && (
            <div className="flex gap-2">
              <Input value={b.text ?? ''} onChange={(e) => update(i, { text: e.target.value })} disabled={disabled} placeholder="Titolo" />
              <Select value={String(b.level ?? 2)} onValueChange={(v) => update(i, { level: Number(v) as 1 | 2 | 3 })} disabled={disabled}>
                <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="1">H1</SelectItem><SelectItem value="2">H2</SelectItem><SelectItem value="3">H3</SelectItem></SelectContent>
              </Select>
            </div>
          )}
          {b.type === 'text' && <Textarea value={b.text ?? ''} onChange={(e) => update(i, { text: e.target.value })} disabled={disabled} className="min-h-[80px]" />}
          {b.type === 'button' && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={b.text ?? ''} onChange={(e) => update(i, { text: e.target.value })} disabled={disabled} placeholder="Etichetta" />
              <Input value={b.url ?? ''} onChange={(e) => update(i, { url: e.target.value })} disabled={disabled} placeholder="https://…" />
            </div>
          )}
          {b.type === 'image' && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={b.src ?? ''} onChange={(e) => update(i, { src: e.target.value })} disabled={disabled} placeholder="URL immagine" />
              <Input value={b.alt ?? ''} onChange={(e) => update(i, { alt: e.target.value })} disabled={disabled} placeholder="Testo alternativo" />
            </div>
          )}
          {b.type === 'spacer' && (
            <Input type="number" value={b.size ?? 16} onChange={(e) => update(i, { size: Number(e.target.value) })} disabled={disabled} className="w-28" placeholder="px" />
          )}
        </div>
      ))}
      {!disabled && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(BLOCK_LABELS) as Block['type'][]).map((t) => (
              <Button key={t} variant="outline" size="sm" onClick={() => add(t)} className="gap-1 text-xs">
                <Plus className="h-3 w-3" /> {BLOCK_LABELS[t]}
              </Button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Personalizzazione: usa{' '}
            {PERSONALIZATION_TOKENS.map((tk) => (
              <code key={tk} className="mx-0.5 rounded bg-muted px-1 py-0.5 text-[10px]">{`{{${tk}}}`}</code>
            ))}{' '}
            nei testi. Sintassi con valore di riserva: <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{'{{nome|ciao}}'}</code>.
          </p>
        </>
      )}
    </div>
  );
}

const PERSONALIZATION_TOKENS = ['nome', 'cognome', 'azienda', 'ruolo', 'email'];

// ── AI composer ───────────────────────────────────────
interface GeneratedCopy { subject: string; preheader: string; blocks: Block[] }

function AIComposer({ onGenerated }: { onGenerated: (copy: GeneratedCopy) => void }) {
  const [prompt, setPrompt] = useState('');
  const [tone, setTone] = useState('professionale');
  const [goal, setGoal] = useState('');

  const gen = useMutation({
    mutationFn: (): Promise<GeneratedCopy> => apiFetch('/api/email-marketing/campaigns/ai-generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, tone, goal: goal || undefined }),
    }),
    onSuccess: (copy) => {
      onGenerated({ subject: copy.subject, preheader: copy.preheader, blocks: copy.blocks ?? [] });
      toast.success('Bozza generata — rivedila e modifica i blocchi qui sotto');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Generazione fallita'),
  });

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-4 w-4 text-violet-500" /> Genera con AI
      </div>
      <Textarea
        value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder="Di cosa parla l'email? Es. «Lancio del nuovo servizio di restyling siti per studi professionali, sconto 20% entro fine mese»"
        className="min-h-[80px] text-sm bg-background"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={tone} onValueChange={setTone}>
          <SelectTrigger className="w-44 h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="professionale">Professionale</SelectItem>
            <SelectItem value="amichevole">Amichevole</SelectItem>
            <SelectItem value="diretto">Diretto</SelectItem>
            <SelectItem value="ispirazionale">Ispirazionale</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={goal} onChange={(e) => setGoal(e.target.value)}
          placeholder="Obiettivo (opz.): prenotare una call…" className="h-8 max-w-xs text-sm"
        />
        <Button size="sm" onClick={() => gen.mutate()} disabled={gen.isPending || prompt.trim().length < 3} className="gap-1.5 ml-auto">
          {gen.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Genera bozza
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        La bozza popola oggetto, preheader e blocchi qui sotto. Puoi rifinire tutto a mano prima dell'invio.
      </p>
    </div>
  );
}

// ── Block preview (email-ish) ─────────────────────────
function BlockPreview({ blocks }: { blocks: Block[] }) {
  return (
    <div className="rounded-lg border bg-[#f9fafb] p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">Anteprima</div>
      <div className="mx-auto max-w-[600px] rounded-md bg-white p-5 shadow-sm">
        {blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun blocco. Aggiungili o genera con AI.</p>
        ) : (
          blocks.map((b, i) => <PreviewBlock key={i} b={b} />)
        )}
      </div>
    </div>
  );
}

function PreviewBlock({ b }: { b: Block }) {
  switch (b.type) {
    case 'heading': {
      const size = b.level === 1 ? 'text-2xl' : b.level === 3 ? 'text-base' : 'text-xl';
      return <p className={`${size} font-semibold text-gray-900 mb-3`}>{b.text || 'Titolo'}</p>;
    }
    case 'text':
      return <p className="text-sm leading-relaxed text-gray-700 mb-4 whitespace-pre-line">{b.text || 'Testo…'}</p>;
    case 'button':
      return (
        <div className="mb-4">
          <span className="inline-block rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white">
            {b.text || 'Scopri di più'}
          </span>
        </div>
      );
    case 'image':
      return b.src
        ? <img src={b.src} alt={b.alt ?? ''} className="mb-4 max-w-full rounded-md" />
        : <div className="mb-4 flex h-28 items-center justify-center rounded-md bg-gray-100 text-xs text-gray-400">Immagine</div>;
    case 'divider':
      return <hr className="my-5 border-gray-200" />;
    case 'spacer':
      return <div style={{ height: Math.max(4, Math.min(80, b.size ?? 16)) }} />;
    default:
      return null;
  }
}

// ── Audience preview ──────────────────────────────────
function AudiencePreview({ campaignId, onSaveNeeded }: { campaignId: string; onSaveNeeded: () => Promise<unknown> }) {
  const [data, setData] = useState<{ total: number; eligible: number; skipped: number } | null>(null);
  const [loading, setLoading] = useState(false);
  async function run() {
    setLoading(true);
    try {
      await onSaveNeeded(); // persist current audience selection first
      const res = await apiFetch(`/api/email-marketing/campaigns/${campaignId}/audience-preview`);
      setData(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Anteprima fallita');
    } finally { setLoading(false); }
  }
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Anteprima destinatari</span>
        <Button variant="outline" size="sm" onClick={run} disabled={loading}>Calcola</Button>
      </div>
      {data && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border p-2"><div className="text-xl font-semibold flex items-center justify-center gap-1"><Users className="h-4 w-4" />{data.total}</div><span className="text-[10px] text-muted-foreground">in audience</span></div>
          <div className="rounded border p-2"><div className="text-xl font-semibold text-emerald-600">{data.eligible}</div><span className="text-[10px] text-muted-foreground">invii consentiti</span></div>
          <div className="rounded border p-2"><div className="text-xl font-semibold text-amber-600 flex items-center justify-center gap-1"><Ban className="h-4 w-4" />{data.skipped}</div><span className="text-[10px] text-muted-foreground">esclusi (consenso)</span></div>
        </div>
      )}
    </div>
  );
}

// ── Report ────────────────────────────────────────────
function CampaignReport({ campaign }: { campaign: any }) {
  const metrics = useMemo(() => ([
    { label: 'Destinatari', value: campaign.total_recipients, icon: Users },
    { label: 'Inviate', value: campaign.total_sent, icon: Send },
    { label: 'Aperture', value: campaign.total_opened, icon: Eye },
    { label: 'Click', value: campaign.total_clicked, icon: MousePointerClick },
    { label: 'Disiscritti', value: campaign.total_unsub, icon: Ban },
    { label: 'Esclusi', value: campaign.total_skipped, icon: Ban },
  ]), [campaign]);
  const openRate = campaign.total_sent ? Math.round((campaign.total_opened / campaign.total_sent) * 100) : 0;
  const clickRate = campaign.total_sent ? Math.round((campaign.total_clicked / campaign.total_sent) * 100) : 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border p-3">
            <div className="text-2xl font-semibold">{m.value ?? 0}</div>
            <span className="text-[10px] text-muted-foreground uppercase">{m.label}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-6 text-sm text-muted-foreground">
        <span>Open rate: <strong className="text-foreground">{openRate}%</strong></span>
        <span>Click rate: <strong className="text-foreground">{clickRate}%</strong></span>
      </div>
    </div>
  );
}
