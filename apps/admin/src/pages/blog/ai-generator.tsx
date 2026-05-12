import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  PlayCircle, History, CheckCircle2, XCircle, Loader2,
  Settings2, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function BlogAIGeneratorPage() {
  const queryClient = useQueryClient();
  const [manualTopic, setManualTopic] = useState('');

  // Fetch config
  const { data: configData, isLoading } = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => apiFetch('/api/blog/config'),
  });

  // Fetch logs
  const { data: logsData } = useQuery({
    queryKey: ['ai-logs'],
    queryFn: () => apiFetch('/api/blog/logs?limit=20'),
  });

  // Update config
  const updateConfig = useMutation({
    mutationFn: (updates: any) => apiFetch('/api/blog/config', { method: 'PUT', body: JSON.stringify(updates) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); toast.success('Configurazione salvata'); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Generate article
  const generateMutation = useMutation({
    mutationFn: (body: any) => apiFetch('/api/blog/generate', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['ai-logs'] });
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      toast.success(data.post ? `"${data.post.title}" creato!` : 'Generazione completata');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const config = configData?.config;
  const apiStatus = configData?.apiStatus;
  const logs = logsData?.logs || [];

  const topbarActions = useMemo(() => (
    <>
      <Button
        size="sm"
        disabled={generateMutation.isPending}
        onClick={() => generateMutation.mutate({ topic: manualTopic || undefined, skipSave: false })}
      >
        {generateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 mr-1.5" />}
        Genera Ora
      </Button>
    </>
  ), [generateMutation.isPending, manualTopic]);

  useTopbar({
    title: 'AI Generator',
    subtitle: `${config?.total_generated || 0} articoli generati · Perplexity (ricerca) + GPT-OSS-120B (scrittura)`,
    actions: topbarActions,
  });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{config?.total_generated || 0}</p>
          <p className="text-[10px] text-muted-foreground">Generati</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{config?.total_published || 0}</p>
          <p className="text-[10px] text-muted-foreground">Pubblicati</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-destructive">{config?.total_failed || 0}</p>
          <p className="text-[10px] text-muted-foreground">Falliti</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <div className={cn('h-2 w-2 rounded-full', apiStatus?.perplexity?.configured ? 'bg-emerald-500' : 'bg-red-500')} />
            <span className="text-xs">Perplexity</span>
          </div>
          <div className="flex items-center justify-center gap-1.5 mt-1">
            <div className={cn('h-2 w-2 rounded-full', apiStatus?.openai?.configured ? 'bg-emerald-500' : 'bg-red-500')} />
            <span className="text-xs">OpenAI</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="generate">
        <TabsList>
          <TabsTrigger value="generate" className="gap-1.5"><PlayCircle className="h-3.5 w-3.5" /> Genera</TabsTrigger>
          <TabsTrigger value="config" className="gap-1.5"><Settings2 className="h-3.5 w-3.5" /> Configurazione</TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5"><History className="h-3.5 w-3.5" /> Log ({logs.length})</TabsTrigger>
        </TabsList>

        {/* === GENERA === */}
        <TabsContent value="generate" className="space-y-4 mt-4">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold">Genera articolo</h3>
            <div className="space-y-1.5">
              <Label className="text-xs">Topic (opzionale — lascia vuoto per topic automatico)</Label>
              <Input value={manualTopic} onChange={(e) => setManualTopic(e.target.value)} placeholder="Es. SEO per piccole imprese nel 2026" />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => generateMutation.mutate({ topic: manualTopic || undefined, skipSave: false })}
                disabled={generateMutation.isPending}
              >
                {generateMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Zap className="h-4 w-4 mr-1.5" />}
                Genera e Pubblica
              </Button>
              <Button
                variant="outline"
                onClick={() => generateMutation.mutate({ topic: manualTopic || undefined, skipSave: true })}
                disabled={generateMutation.isPending}
              >
                Solo Preview
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Flusso: Perplexity cerca topic → GPT-OSS-120B scrive l'articolo → Z-Image genera la cover → Pubblica sul blog
            </p>
          </div>
        </TabsContent>

        {/* === CONFIGURAZIONE === */}
        <TabsContent value="config" className="space-y-4 mt-4">
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold">Generazione automatica</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Schedulazione CRON</p>
                <p className="text-xs text-muted-foreground">Genera articoli automaticamente. Gestito dal workflow "Blog Automatico Settimanale".</p>
              </div>
              <Switch checked={config?.is_enabled || false} onCheckedChange={(v) => updateConfig.mutate({ is_enabled: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Auto-pubblica</p>
                <p className="text-xs text-muted-foreground">Pubblica subito senza revisione</p>
              </div>
              <Switch checked={config?.auto_publish || false} onCheckedChange={(v) => updateConfig.mutate({ auto_publish: v })} />
            </div>
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold">Stile e contenuto</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Stile di scrittura</Label>
                <Input defaultValue={config?.writing_style || ''} onBlur={(e) => { if (e.target.value !== (config?.writing_style || '')) updateConfig.mutate({ writing_style: e.target.value }); }} placeholder="Professionale ma accessibile" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Tono</Label>
                <Input defaultValue={config?.tone || ''} onBlur={(e) => { if (e.target.value !== (config?.tone || '')) updateConfig.mutate({ tone: e.target.value }); }} placeholder="Informativo" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Lingua</Label>
                <Select value={config?.language || 'it'} onValueChange={(v) => updateConfig.mutate({ language: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="it">Italiano</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Parole target</Label>
                <Input type="number" defaultValue={config?.target_word_count || 1500} onBlur={(e) => { const v = parseInt(e.target.value); if (v !== (config?.target_word_count || 1500)) updateConfig.mutate({ target_word_count: v }); }} />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Topic preferiti (uno per riga)</Label>
              <Textarea
                id="topics-textarea"
                defaultValue={(config?.topics || []).join('\n')}
                onBlur={(e) => {
                  const newTopics = e.target.value.split('\n').map(t => t.trim()).filter(Boolean);
                  const oldTopics = (config?.topics || []).join(',');
                  if (newTopics.join(',') !== oldTopics) updateConfig.mutate({ topics: newTopics });
                }}
                rows={4}
                placeholder={"web design\nSEO\nfreelancing"}
              />
              <p className="text-[10px] text-muted-foreground">Il workflow Blog sceglie un topic random da questa lista. Clicca per aggiungere:</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  'Web design trend 2026',
                  'SEO per piccole imprese',
                  'Astro.build vs WordPress',
                  'Come scegliere un web designer',
                  'UX design per e-commerce',
                  'Velocità sito e conversioni',
                  'GDPR per siti web',
                  'Landing page che convertono',
                  'Branding per freelancer',
                  'React vs Vue nel 2026',
                  'Accessibilità web (WCAG)',
                  'Email marketing per PMI',
                  'Portfolio online efficace',
                  'Costi di un sito web',
                  'Tailwind CSS best practice',
                  'AI nel web design',
                  'Mobile first design',
                  'Tipografia per il web',
                  'Colori e psicologia nel design',
                  'Come ottimizzare Core Web Vitals',
                ].map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    className="text-[10px] rounded-full border px-2.5 py-1 hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-colors text-muted-foreground"
                    onClick={() => {
                      const ta = document.getElementById('topics-textarea') as HTMLTextAreaElement;
                      if (!ta) return;
                      const current = ta.value.trim();
                      if (current.split('\n').some(t => t.trim() === topic)) {
                        toast.info('Topic già presente');
                        return;
                      }
                      ta.value = current ? current + '\n' + topic : topic;
                      // Trigger save
                      const newTopics = ta.value.split('\n').map(t => t.trim()).filter(Boolean);
                      updateConfig.mutate({ topics: newTopics });
                      toast.success(`"${topic}" aggiunto`);
                    }}
                  >
                    + {topic}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold">Cover image</h3>
            <div className="space-y-1.5">
              <Label className="text-xs">Provider</Label>
              <Select value={config?.cover_provider || 'zimage'} onValueChange={(v) => updateConfig.mutate({ cover_provider: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="zimage">Z-Image (KIE)</SelectItem>
                  <SelectItem value="dalle">DALL-E</SelectItem>
                  <SelectItem value="unsplash">Unsplash</SelectItem>
                  <SelectItem value="none">Nessuna</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-3">
            <h3 className="text-sm font-semibold">Modelli LLM</h3>
            <p className="text-xs text-muted-foreground">
              Il sistema usa automaticamente il routing LLM ottimale:
            </p>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Ricerca topic</span><span>Perplexity Sonar Pro</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Scrittura articolo</span><span>Infomaniak GPT-OSS-120B</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Cover image</span><span>Z-Image / KIE</span></div>
            </div>
          </div>
        </TabsContent>

        {/* === LOG === */}
        <TabsContent value="logs" className="mt-4">
          {logs.length === 0 ? (
            <EmptyState title="Nessuna generazione" description="I log delle generazioni appariranno qui" icon={History} />
          ) : (
            <div className="rounded-xl border bg-card divide-y">
              {logs.map((log: any) => (
                <div key={log.id} className="flex items-center gap-3 px-4 py-3">
                  <div className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                    log.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : log.status === 'failed' ? 'bg-red-500/10 text-red-500' : 'bg-muted text-muted-foreground'
                  )}>
                    {log.status === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5" /> : log.status === 'failed' ? <XCircle className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{log.generated_title || log.topic_used || 'Generazione'}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(log.created_at).toLocaleString('it-IT')}
                      {log.duration_ms ? ` · ${(log.duration_ms / 1000).toFixed(1)}s` : ''}
                      {log.triggered_by ? ` · ${log.triggered_by}` : ''}
                    </p>
                  </div>
                  {log.error_message && (
                    <span className="text-[10px] text-red-500 truncate max-w-[200px]">{log.error_message}</span>
                  )}
                  <Badge variant="outline" className={cn('text-[10px] shrink-0',
                    log.status === 'completed' ? 'border-emerald-500/30 text-emerald-500' : log.status === 'failed' ? 'border-red-500/30 text-red-500' : ''
                  )}>
                    {log.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
