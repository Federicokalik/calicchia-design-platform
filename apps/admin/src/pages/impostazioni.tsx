import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  User, Link2, Key, KeyRound, History, Palette, FileSignature, Brain, Sparkles,
  Trash2, CheckCircle2, XCircle, RefreshCw, Building2, CreditCard, MapPin,
  Shield, Zap, Activity, ChevronDown, Scale, Database, Download, Upload, AlertTriangle,
  Briefcase, Users, Calculator, Coins, Copy,
} from 'lucide-react';
import { McpTokensSection } from './impostazioni/mcp-tokens-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch, API_BASE } from '@/lib/api';
import { cn } from '@/lib/utils';

function Field({ label, value, onChange, type = 'text', placeholder = '', rows, description }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; rows?: number; description?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      {rows ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} className="text-sm" />
      ) : (
        <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="text-sm h-9" />
      )}
      {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
    </div>
  );
}

const NAV_ITEMS = [
  { id: 'profilo', label: 'Profilo', icon: User },
  { id: 'studio-freelance', label: 'Studio freelance', icon: Briefcase },
  { id: 'preventivi', label: 'Preventivi & PDF', icon: FileSignature },
  { id: 'integrazioni', label: 'Integrazioni', icon: Link2 },
  { id: 'brain', label: 'Second Brain', icon: Brain },
  { id: 'ai-costs', label: 'Costi AI', icon: Activity },
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'mcp-tokens', label: 'Token MCP', icon: KeyRound },
  { id: 'backup', label: 'Backup', icon: Database },
  { id: 'audit', label: 'Audit Log', icon: History },
];

export default function ImpostazioniPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('profilo');

  const { data: settingsData } = useQuery({ queryKey: ['settings'], queryFn: () => apiFetch('/api/settings') });
  const { data: keysData } = useQuery({ queryKey: ['api-keys'], queryFn: () => apiFetch('/api/keys') });
  const { data: auditData } = useQuery({ queryKey: ['audit-logs'], queryFn: () => apiFetch('/api/audit-logs?limit=50') });
  const { data: integrationsStatus, refetch: refetchIntegrations } = useQuery({
    queryKey: ['integrations-check'],
    queryFn: async () => { try { return await apiFetch('/api/settings/integrations-check'); } catch { return {}; } },
  });
  const { data: brainStats } = useQuery({
    queryKey: ['brain-stats'],
    queryFn: async () => { try { return await apiFetch('/api/settings/brain-stats'); } catch { return { facts: 0, conversations: 0, preferences: 0 }; } },
  });
  const { data: aiUsage } = useQuery({
    queryKey: ['ai-usage'],
    queryFn: async () => { try { return await apiFetch('/api/settings/ai-usage'); } catch { return { totals: {}, byProvider: [], byDay: [], recentCalls: [] }; } },
  });

  // /api/settings risponde con { settings: {...keys} } — unwrap se presente.
  const settings = (((settingsData as any)?.settings ?? settingsData) || {}) as Record<string, any>;
  const businessProfile = settings['business.profile'] || {};
  const quoteSettings = settings['quote.settings'] || {};
  const freelancerStudio = settings['freelancer.studio'] || {};
  const apiKeys = keysData?.keys || [];
  const auditLogs = auditData?.logs || auditData?.entries || [];

  const saveMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) =>
      apiFetch(`/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['settings'] }); toast.success('Salvato'); },
    onError: () => toast.error('Errore'),
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['api-keys'] }); toast.success('Eliminata'); },
  });

  const [qs, setQs] = useState<Record<string, any>>({});
  const getQs = (key: string, fallback = '') => qs[key] !== undefined ? qs[key] : quoteSettings[key] ?? fallback;
  const setQsField = (key: string, value: any) => setQs((prev) => ({ ...prev, [key]: value }));

  const [openArticles, setOpenArticles] = useState<Set<number>>(new Set());
  const toggleArticle = (i: number) => setOpenArticles((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });

  const [bp, setBp] = useState<Record<string, any>>({});
  const getBp = (key: string) => bp[key] !== undefined ? bp[key] : businessProfile[key] ?? '';
  const setBpField = (key: string, value: any) => setBp((prev) => ({ ...prev, [key]: value }));

  const [fs, setFs] = useState<Record<string, any>>({});
  const getFs = (key: string, fallback: any = '') =>
    fs[key] !== undefined ? fs[key] : freelancerStudio[key] ?? fallback;
  const setFsField = (key: string, value: any) => setFs((prev) => ({ ...prev, [key]: value }));

  const saveQs = () => { saveMutation.mutate({ key: 'quote.settings', value: { ...quoteSettings, ...qs } }); setQs({}); };
  const saveBp = () => { saveMutation.mutate({ key: 'business.profile', value: { ...businessProfile, ...bp } }); setBp({}); };
  const saveFs = () => { saveMutation.mutate({ key: 'freelancer.studio', value: { ...freelancerStudio, ...fs } }); setFs({}); };

  useTopbar({ title: 'Impostazioni', subtitle: 'Profilo, integrazioni, preventivi, preferenze' });

  const intStatus = (integrationsStatus || {}) as Record<string, any>;

  return (
    <div className="flex gap-6 min-h-[calc(100vh-8rem)]">
      {/* Left nav */}
      <nav className="w-48 shrink-0 space-y-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={cn(
              'flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-sm transition-colors text-left',
              activeTab === item.id
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </button>
        ))}
      </nav>

      {/* Right content */}
      <div className="flex-1 max-w-3xl space-y-6">

        {/* === PROFILO === */}
        {activeTab === 'profilo' && (
          <>
            <div>
              <h2 className="text-lg font-semibold">Profilo Business</h2>
              <p className="text-sm text-muted-foreground">I tuoi dati aziendali e di contatto.</p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Building2 className="h-4 w-4 text-muted-foreground" /> Azienda</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Nome azienda" value={getBp('company_name')} onChange={(v) => setBpField('company_name', v)} placeholder="Calicchia Design" />
                <Field label="Ragione sociale" value={getBp('legal_name')} onChange={(v) => setBpField('legal_name', v)} />
                <Field label="P.IVA" value={getBp('vat_number')} onChange={(v) => setBpField('vat_number', v)} />
                <Field label="Codice Fiscale" value={getBp('tax_code')} onChange={(v) => setBpField('tax_code', v)} />
                <Field label="Email" value={getBp('email')} onChange={(v) => setBpField('email', v)} />
                <Field label="Telefono" value={getBp('phone')} onChange={(v) => setBpField('phone', v)} />
                <Field label="Sito web" value={getBp('website')} onChange={(v) => setBpField('website', v)} />
                <Field label="PEC" value={getBp('pec')} onChange={(v) => setBpField('pec', v)} />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><MapPin className="h-4 w-4 text-muted-foreground" /> Indirizzo</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Via" value={getBp('address_street')} onChange={(v) => setBpField('address_street', v)} />
                <Field label="CAP" value={getBp('address_zip')} onChange={(v) => setBpField('address_zip', v)} />
                <Field label="Città" value={getBp('address_city')} onChange={(v) => setBpField('address_city', v)} />
                <Field label="Provincia" value={getBp('address_province')} onChange={(v) => setBpField('address_province', v)} />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><CreditCard className="h-4 w-4 text-muted-foreground" /> Coordinate Bancarie</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Banca" value={getBp('bank_name')} onChange={(v) => setBpField('bank_name', v)} />
                <Field label="IBAN" value={getBp('bank_iban')} onChange={(v) => setBpField('bank_iban', v)} />
                <Field label="BIC/SWIFT" value={getBp('bank_bic')} onChange={(v) => setBpField('bank_bic', v)} />
              </div>
            </div>

            <Button onClick={saveBp} disabled={saveMutation.isPending || Object.keys(bp).length === 0}>
              {saveMutation.isPending ? 'Salvataggio...' : 'Salva profilo'}
            </Button>
          </>
        )}

        {/* === STUDIO FREELANCE === */}
        {activeTab === 'studio-freelance' && (
          <>
            <div>
              <h2 className="text-lg font-semibold">Studio freelance</h2>
              <p className="text-sm text-muted-foreground">
                Capacità mensile, tariffa di default e regime fiscale.
                Determinano badge disponibilità del sito, calcoli profittabilità e tasse stimate.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4 text-muted-foreground" /> Capacità
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Max clienti / mese"
                  value={String(getFs('max_clients_per_month', 3))}
                  onChange={(v) => setFsField('max_clients_per_month', parseInt(v, 10) || 0)}
                  type="number"
                  description="Soglia mostrata nel badge 'Disponibile' della home"
                />
                <Field
                  label="Ore disponibili / settimana"
                  value={String(getFs('weekly_capacity_hours', 40))}
                  onChange={(v) => setFsField('weekly_capacity_hours', parseInt(v, 10) || 0)}
                  type="number"
                  description="Usato dal widget capacity nel dashboard"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Coins className="h-4 w-4 text-muted-foreground" /> Tariffa
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Tariffa oraria default (€)"
                  value={String((getFs('default_hourly_rate_cents', 5000) || 0) / 100)}
                  onChange={(v) => setFsField('default_hourly_rate_cents', Math.round((parseFloat(v) || 0) * 100))}
                  type="number"
                  description="Usata quando un progetto non ha una tariffa propria"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Calculator className="h-4 w-4 text-muted-foreground" /> Regime fiscale
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Regime</Label>
                  <select
                    value={getFs('vat_regime', 'forfettario')}
                    onChange={(e) => setFsField('vat_regime', e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    <option value="forfettario">Forfettario</option>
                    <option value="ordinario">Ordinario</option>
                    <option value="none">Nessuno (non applicabile)</option>
                  </select>
                </div>
                <Field
                  label="Coefficiente redditività"
                  value={String(getFs('forfettario_coefficient', 0.78))}
                  onChange={(v) => setFsField('forfettario_coefficient', parseFloat(v) || 0)}
                  type="number"
                  description="Default 0.78 per codici ATECO web/IT"
                />
                <Field
                  label="Aliquota INPS gest. separata"
                  value={String(getFs('inps_rate', 0.2607))}
                  onChange={(v) => setFsField('inps_rate', parseFloat(v) || 0)}
                  type="number"
                  description="Es. 0.2607 = 26.07%"
                />
                <Field
                  label="Imposta sostitutiva IRPEF"
                  value={String(getFs('irpef_substitute_rate', 0.05))}
                  onChange={(v) => setFsField('irpef_substitute_rate', parseFloat(v) || 0)}
                  type="number"
                  description="5% primi 5 anni, poi 15%"
                />
                <Field
                  label="Plafond forfettario (€)"
                  value={String(getFs('forfettario_plafond_eur', 85000))}
                  onChange={(v) => setFsField('forfettario_plafond_eur', parseFloat(v) || 0)}
                  type="number"
                  description="Tetto ricavi annui (85.000€ dal 2023)"
                />
              </div>
            </div>

            <Button onClick={saveFs} disabled={saveMutation.isPending || Object.keys(fs).length === 0}>
              {saveMutation.isPending ? 'Salvataggio...' : 'Salva impostazioni studio'}
            </Button>

            {/* Embed lead form */}
            <div className="rounded-xl border bg-card p-6 space-y-4 mt-6">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-muted-foreground" /> Embed form lead
              </div>
              <p className="text-xs text-muted-foreground">
                Genera uno snippet iframe da incollare su siti partner, landing esterne o newsletter.
                Le lead vengono inserite con sorgente <code className="text-[10px] bg-muted px-1 rounded">embed_form</code>
                e UTM tracking automatico.
              </p>
              {(() => {
                const baseUrl = (typeof window !== 'undefined'
                  ? `${window.location.protocol}//calicchia.design`
                  : 'https://calicchia.design');
                const sourceToken = (businessProfile.company_name || 'embed').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'embed';
                const iframeSrc = `${baseUrl}/it/embed/lead?source=${sourceToken}`;
                const snippet = `<iframe
  src="${iframeSrc}"
  width="100%"
  height="640"
  frameborder="0"
  style="border:0;max-width:560px;"
  title="Richiedi un preventivo"
></iframe>
<script>
  window.addEventListener('message', function(e) {
    if (e.data?.type === 'calicchia:lead-embed:resize') {
      var iframe = document.querySelector('iframe[src*="${baseUrl.replace(/^https?:\/\//, '')}/it/embed/lead"]');
      if (iframe) iframe.style.height = e.data.height + 'px';
    }
  });
</script>`;
                return (
                  <>
                    <Textarea
                      readOnly
                      value={snippet}
                      rows={12}
                      className="text-[10px] font-mono"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <div className="flex items-center justify-between">
                      <a
                        href={iframeSrc}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-primary hover:underline"
                      >
                        Anteprima form →
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(snippet);
                            toast.success('Snippet copiato');
                          } catch {
                            toast.error('Impossibile copiare');
                          }
                        }}
                      >
                        <Copy className="h-3.5 w-3.5 mr-1.5" /> Copia snippet
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Token sorgente: <code className="bg-muted px-1 rounded">{sourceToken}</code>
                      (deriva dal nome azienda — modifica in alto per cambiarlo).
                      Aggiungi parametri UTM allo URL per tracciare campagne: <code className="bg-muted px-1 rounded">&amp;utm_source=...</code>
                    </p>
                  </>
                );
              })()}
            </div>
          </>
        )}

        {/* === PREVENTIVI === */}
        {activeTab === 'preventivi' && (
          <>
            <div>
              <h2 className="text-lg font-semibold">Preventivi & PDF</h2>
              <p className="text-sm text-muted-foreground">Brand, dati fornitore, regime fiscale e contratto per i PDF.</p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Palette className="h-4 w-4 text-muted-foreground" /> Brand</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Colore primario" value={getQs('colore_primario', '#f57f44')} onChange={(v) => setQsField('colore_primario', v)} type="color" />
                <Field label="Font" value={getQs('font', 'Inter, Arial, sans-serif')} onChange={(v) => setQsField('font', v)} />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><FileSignature className="h-4 w-4 text-muted-foreground" /> Intestazione PDF</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Ragione sociale" value={getQs('ragione_sociale', 'Calicchia Design di Federico Calicchia')} onChange={(v) => setQsField('ragione_sociale', v)} />
                <Field label="P.IVA" value={getQs('piva', '03160480608')} onChange={(v) => setQsField('piva', v)} />
                <Field label="Indirizzo" value={getQs('indirizzo', 'Via Scifelli 74, 03023 Ceccano (FR)')} onChange={(v) => setQsField('indirizzo', v)} />
                <Field label="Rappresentante" value={getQs('legale_rappresentante', 'Federico Calicchia')} onChange={(v) => setQsField('legale_rappresentante', v)} />
                <Field label="Telefono" value={getQs('telefono', '351 777 3467')} onChange={(v) => setQsField('telefono', v)} />
                <Field label="Email" value={getQs('email_fornitore', 'info@calicchia.design')} onChange={(v) => setQsField('email_fornitore', v)} />
                <Field label="Banca" value={getQs('banca', 'Revolut Bank UAB')} onChange={(v) => setQsField('banca', v)} />
                <Field label="IBAN" value={getQs('iban', 'LT84 3250 0216 2701 8744')} onChange={(v) => setQsField('iban', v)} />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Shield className="h-4 w-4 text-muted-foreground" /> Regime Fiscale</div>
              <Field label="Nota IVA" value={getQs('nota_iva', '')} onChange={(v) => setQsField('nota_iva', v)} rows={3} description="Apparirà nel footer di ogni pagina del PDF" />
              <Field label="Nota marca da bollo" value={getQs('marca_bollo_nota', '')} onChange={(v) => setQsField('marca_bollo_nota', v)} rows={2} />
              <div className="grid grid-cols-2 gap-4">
                <Field label="Soglia bollo (€)" value={getQs('soglia_bollo', '77.47')} onChange={(v) => setQsField('soglia_bollo', parseFloat(v) || 0)} type="number" />
                <Field label="Importo bollo (€)" value={getQs('importo_bollo', '2')} onChange={(v) => setQsField('importo_bollo', parseFloat(v) || 0)} type="number" />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Scale className="h-4 w-4 text-muted-foreground" /> Contratto Standard</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Foro competente" value={getQs('foro_competente', 'Tribunale di Frosinone')} onChange={(v) => setQsField('foro_competente', v)} />
                <Field label="Durata standard (mesi)" value={getQs('durata_standard_mesi', '12')} onChange={(v) => setQsField('durata_standard_mesi', parseInt(v) || 12)} type="number" />
              </div>

              <div className="space-y-1 pt-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Articoli del contratto</Label>
                  <button
                    type="button"
                    className="text-[10px] text-primary hover:underline"
                    onClick={() => {
                      if (openArticles.size === 15) setOpenArticles(new Set());
                      else setOpenArticles(new Set(Array.from({ length: 15 }, (_, i) => i)));
                    }}
                  >
                    {openArticles.size === 15 ? 'Chiudi tutti' : 'Espandi tutti'}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground mb-3">Modifica il testo di ciascun articolo. Verranno inclusi nei PDF dei preventivi.</p>

                <div className="space-y-1">
                  {Array.from({ length: 15 }, (_, i) => {
                    const defaults = [
                      'Art. 1 — OGGETTO: Il Fornitore si impegna a realizzare per il Cliente i servizi descritti nel presente preventivo.',
                      "Art. 2 — COMPENSO: Il compenso per i servizi è quello indicato nell'offerta economica accettata.",
                      'Art. 3 — DURATA: Il presente contratto ha durata di 12 mesi dalla data di sottoscrizione.',
                      'Art. 4 — MODALITÀ DI PAGAMENTO: Il pagamento dovrà avvenire secondo le modalità indicate nel preventivo.',
                      'Art. 5 — RITARDO NEI PAGAMENTI: In caso di ritardo, il Fornitore si riserva di sospendere i servizi.',
                      'Art. 6 — PROPRIETÀ INTELLETTUALE: I diritti di proprietà intellettuale restano del Fornitore fino al saldo completo.',
                      'Art. 7 — RISERVATEZZA: Le parti si impegnano a mantenere riservate le informazioni scambiate.',
                      'Art. 8 — RECESSO: Ciascuna parte può recedere con preavviso scritto di 30 giorni.',
                      'Art. 9 — FORZA MAGGIORE: Nessuna parte sarà responsabile per inadempimenti dovuti a causa di forza maggiore.',
                      'Art. 10 — LIMITAZIONE DI RESPONSABILITÀ: La responsabilità del Fornitore è limitata al compenso ricevuto.',
                      'Art. 11 — GARANZIA: Il Fornitore garantisce la conformità dei servizi alle specifiche concordate.',
                      'Art. 12 — MODIFICHE AL CONTRATTO: Eventuali modifiche devono essere concordate per iscritto.',
                      'Art. 13 — CESSIONE: Il contratto non può essere ceduto a terzi senza consenso scritto.',
                      'Art. 14 — COMUNICAZIONI: Le comunicazioni ufficiali devono avvenire via PEC o raccomandata.',
                      'Art. 15 — FORO COMPETENTE: Per ogni controversia sarà competente il Tribunale indicato nelle impostazioni.',
                    ];
                    const articles: string[] = qs.contratto_articoli || quoteSettings.contratto_articoli || defaults;
                    const value = articles[i] || defaults[i];
                    const isOpen = openArticles.has(i);
                    const artTitle = value.match(/^(Art\.\s*\d+\s*—\s*[^:]+)/)?.[1] || `Art. ${i + 1}`;

                    return (
                      <div key={i} className="rounded-lg border bg-muted/20">
                        <button
                          type="button"
                          className="flex items-center justify-between w-full px-3 py-2 text-left text-xs font-medium hover:bg-muted/40 transition-colors rounded-lg"
                          onClick={() => toggleArticle(i)}
                        >
                          <span>{artTitle}</span>
                          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                        </button>
                        {isOpen && (
                          <div className="px-3 pb-3">
                            <Textarea
                              value={value}
                              onChange={(e) => {
                                const updated = [...articles];
                                updated[i] = e.target.value;
                                setQsField('contratto_articoli', updated);
                              }}
                              rows={3}
                              className="text-xs"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <Button onClick={saveQs} disabled={saveMutation.isPending || Object.keys(qs).length === 0}>
              {saveMutation.isPending ? 'Salvataggio...' : 'Salva impostazioni preventivi'}
            </Button>
          </>
        )}

        {/* === INTEGRAZIONI === */}
        {activeTab === 'integrazioni' && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Integrazioni</h2>
                <p className="text-sm text-muted-foreground">Stato delle connessioni con servizi esterni.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetchIntegrations()}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Verifica
              </Button>
            </div>

            <div className="space-y-3">
              {[
                { key: 'calcom', name: 'Cal.com', desc: 'Booking appuntamenti', category: 'Calendario' },
                { key: 'google_calendar', name: 'Google Calendar', desc: 'Sync eventi', category: 'Calendario' },
                { key: 'whatsapp', name: 'WhatsApp', desc: 'Evolution API — invio messaggi', category: 'Comunicazione' },
                { key: 'resend', name: 'Resend', desc: 'Email transazionali', category: 'Comunicazione' },
                { key: 'telegram', name: 'Telegram Bot', desc: 'Comandi + notifiche push', category: 'Comunicazione' },
                { key: 'turnstile', name: 'Turnstile', desc: 'Anti-bot per i form del sito', category: 'Sicurezza' },
                { key: 'openai', name: 'OpenAI', desc: 'AI Agent, chat, tool calling', category: 'AI & Generazione' },
                { key: 'anthropic', name: 'Anthropic', desc: 'Copy e email di qualità', category: 'AI & Generazione' },
                { key: 'perplexity', name: 'Perplexity', desc: 'Ricerca web per blog', category: 'AI & Generazione' },
                { key: 'zimage', name: 'Z-Image (KIE)', desc: 'Generazione cover blog AI', category: 'AI & Generazione' },
                { key: 'dalle', name: 'DALL-E', desc: 'Generazione immagini (usa OpenAI)', category: 'AI & Generazione' },
                { key: 'gemini', name: 'Google Gemini', desc: 'Fallback LLM aggiuntivo', category: 'AI & Generazione' },
                { key: 'unsplash', name: 'Unsplash', desc: 'Foto stock per cover blog', category: 'AI & Generazione' },
                { key: 'stripe', name: 'Stripe', desc: 'Pagamenti online', category: 'Pagamenti' },
                { key: 'bugsink', name: 'Bugsink', desc: 'Error tracking', category: 'Monitoring' },
              ].map((int, i, arr) => {
                const status = intStatus[int.key];
                const connected = status?.connected ?? false;
                const showCategory = i === 0 || arr[i - 1].category !== int.category;
                return (
                  <div key={int.key}>
                    {showCategory && (
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mt-4 mb-2 first:mt-0">{int.category}</p>
                    )}
                    <div className="rounded-xl border bg-card px-4 py-3.5 flex items-center gap-4">
                      <div className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                        connected ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-500'
                      )}>
                        {connected ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{int.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {connected ? (status?.detail || 'Connesso') : (status?.action || int.desc)}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn(
                        'text-[10px] px-2 shrink-0',
                        connected ? 'border-emerald-500/20 text-emerald-600 bg-emerald-500/5' : 'border-red-500/20 text-red-500 bg-red-500/5'
                      )}>
                        {connected ? 'Attivo' : 'Inattivo'}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* === SECOND BRAIN === */}
        {activeTab === 'brain' && (
          <>
            <div>
              <h2 className="text-lg font-semibold">Second Brain</h2>
              <p className="text-sm text-muted-foreground">Personalità, memoria e automazioni del tuo agente AI.</p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Sparkles className="h-4 w-4 text-muted-foreground" /> Personalità</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Nome dell'agent" value={getQs('brain_name', 'Brain')} onChange={(v) => setQsField('brain_name', v)} placeholder="Brain, Atlas, Cleo..." />
                <Field label="Tono comunicazione" value={getQs('brain_tone', 'diretto ma amichevole')} onChange={(v) => setQsField('brain_tone', v)} />
              </div>
              <Field label="Orari silenziosi (non disturbare)" value={getQs('brain_quiet_hours', '')} onChange={(v) => setQsField('brain_quiet_hours', v)} placeholder="Es. 21:00-08:00" description="L'agent non invierà notifiche Telegram in questi orari" />
              <Field label="Regole personalizzate" value={getQs('brain_custom_rules', '')} onChange={(v) => setQsField('brain_custom_rules', v)} rows={4} placeholder={"Preferisco email brevi\nNon mandare follow-up il lunedì\nPer siti web il prezzo minimo è 800€"} description="Una regola per riga. L'agent le seguirà in ogni interazione." />
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium"><Brain className="h-4 w-4 text-muted-foreground" /> Memoria</div>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-muted/40 p-4 text-center">
                  <p className="text-2xl font-bold">{(brainStats as any)?.facts ?? 0}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Fatti appresi</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-4 text-center">
                  <p className="text-2xl font-bold">{(brainStats as any)?.conversations ?? 0}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Conversazioni</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-4 text-center">
                  <p className="text-2xl font-bold">{(brainStats as any)?.preferences ?? 0}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Regole attive</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">La memoria si popola automaticamente dalle tue interazioni con l'AI.</p>
            </div>

            <div className="rounded-xl border bg-card p-6 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Zap className="h-4 w-4 text-muted-foreground" /> Analisi proattiva</div>
              <p className="text-xs text-muted-foreground">Ogni 6 ore il Brain analizza i tuoi dati e ti invia insight su Telegram:</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  'Lead stagnanti senza follow-up',
                  'Progetti a rischio scadenza',
                  'Clienti pronti per upsell',
                  'Preventivi non aperti',
                  'Revenue sotto la media',
                  'Domini in scadenza',
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="h-1.5 w-1.5 rounded-full bg-primary/40 shrink-0" />
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <Button onClick={saveQs} disabled={saveMutation.isPending || Object.keys(qs).length === 0}>
              {saveMutation.isPending ? 'Salvataggio...' : 'Salva impostazioni Brain'}
            </Button>
          </>
        )}

        {/* === COSTI AI === */}
        {activeTab === 'ai-costs' && (() => {
          const usage = (aiUsage || {}) as any;
          const totals = usage.totals || {};
          const byProvider = usage.byProvider || [];
          const recentCalls = usage.recentCalls || [];
          return (
            <>
              <div>
                <h2 className="text-lg font-semibold">Costi AI</h2>
                <p className="text-sm text-muted-foreground">Tracciamento completo di ogni chiamata LLM.</p>
              </div>

              {/* KPI */}
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">{totals.calls || 0}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Chiamate (30gg)</p>
                </div>
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">{((totals.total_tokens || 0) / 1000).toFixed(0)}k</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Token totali</p>
                </div>
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold text-primary">€{(totals.total_cost || 0).toFixed(4)}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Costo totale</p>
                </div>
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">€{totals.calls ? ((totals.total_cost || 0) / totals.calls).toFixed(4) : '0'}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Costo medio/call</p>
                </div>
              </div>

              {/* By provider */}
              {byProvider.length > 0 && (
                <div className="rounded-xl border bg-card p-5 space-y-3">
                  <h3 className="text-sm font-semibold">Per provider</h3>
                  <div className="space-y-2">
                    {byProvider.map((p: any) => (
                      <div key={p.provider} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-primary" />
                          <span className="text-sm">{p.provider}</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>{p.calls} calls</span>
                          <span>{(p.tokens / 1000).toFixed(0)}k token</span>
                          <span className="font-medium text-foreground">€{parseFloat(p.cost).toFixed(4)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent calls */}
              <div className="rounded-xl border bg-card overflow-hidden">
                <div className="px-5 py-3 border-b">
                  <h3 className="text-sm font-semibold">Ultime chiamate</h3>
                </div>
                {recentCalls.length === 0 ? (
                  <div className="p-8 text-center text-xs text-muted-foreground">Nessuna chiamata AI registrata.</div>
                ) : (
                  <div className="max-h-[400px] overflow-y-auto scrollbar-thin divide-y">
                    {recentCalls.map((call: any, i: number) => (
                      <div key={i} className="flex items-center gap-3 px-5 py-2.5 text-xs">
                        <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', call.success ? 'bg-emerald-500' : 'bg-red-500')} />
                        <div className="flex-1 min-w-0">
                          <span className="font-medium">{call.model}</span>
                          <span className="text-muted-foreground ml-2">{call.task_type} · {call.channel}</span>
                        </div>
                        <span className="text-muted-foreground">{call.input_tokens + call.output_tokens} tok</span>
                        <span className="text-muted-foreground">{call.duration_ms}ms</span>
                        <span className="font-medium w-16 text-right">€{parseFloat(call.cost_eur || 0).toFixed(5)}</span>
                        <span className="text-muted-foreground w-12 text-right">
                          {new Date(call.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {/* === API KEYS === */}
        {activeTab === 'api-keys' && (
          <>
            <div>
              <h2 className="text-lg font-semibold">API Keys</h2>
              <p className="text-sm text-muted-foreground">Chiavi di accesso per integrazioni esterne.</p>
            </div>

            {apiKeys.length === 0 ? (
              <EmptyState title="Nessuna API key" description="Le chiavi create appariranno qui" icon={Key} />
            ) : (
              <div className="rounded-xl border bg-card divide-y">
                {apiKeys.map((key: any) => (
                  <div key={key.id} className="flex items-center gap-3 px-5 py-3.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Key className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{key.name || 'API Key'}</p>
                      <p className="text-xs text-muted-foreground font-mono">{key.key_prefix || key.id?.slice(0, 8)}...</p>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {key.created_at ? new Date(key.created_at).toLocaleDateString('it-IT') : ''}
                    </span>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                      if (confirm('Eliminare?')) deleteKeyMutation.mutate(key.id);
                    }}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* === TOKEN MCP === */}
        {activeTab === 'mcp-tokens' && <McpTokensSection />}

        {/* === BACKUP === */}
        {activeTab === 'backup' && <BackupSection />}

        {/* === AUDIT LOG === */}
        {activeTab === 'audit' && (
          <>
            <div>
              <h2 className="text-lg font-semibold">Audit Log</h2>
              <p className="text-sm text-muted-foreground">Registro delle azioni eseguite nel gestionale.</p>
            </div>

            {auditLogs.length === 0 ? (
              <EmptyState title="Nessun evento registrato" description="Le azioni appariranno qui" icon={History} />
            ) : (
              <div className="rounded-xl border bg-card divide-y max-h-[60vh] overflow-y-auto scrollbar-thin">
                {auditLogs.map((entry: any, i: number) => (
                  <div key={entry.id || i} className="flex items-start gap-3 px-5 py-3.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
                      <History className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">{entry.action || entry.event_type || 'Azione'}</span>
                        {entry.entity_type && <span className="text-muted-foreground"> su {entry.entity_type}</span>}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {entry.created_at ? new Date(entry.created_at).toLocaleString('it-IT') : ''}
                        {entry.user_email ? ` · ${entry.user_email}` : ''}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const CONFIRM_TOKEN = 'RIPRISTINA-DATABASE';

function BackupSection() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [exporting, setExporting] = useState(false);

  const { data: info, isLoading } = useQuery({
    queryKey: ['backup-info'],
    queryFn: () => apiFetch('/api/backup/info'),
  });

  const exportBackup = async () => {
    setExporting(true);
    try {
      const res = await fetch(`${API_BASE}/api/backup/export`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `caldes-backup-${Date.now()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Backup scaricato');
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
    } catch (err) {
      toast.error((err as Error).message || 'Errore export');
    } finally {
      setExporting(false);
    }
  };

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('Seleziona un file di backup');
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('confirm', confirmText);
      return apiFetch('/api/backup/import', { method: 'POST', body: fd });
    },
    onSuccess: (data: any) => {
      toast.success(`Ripristino completato: ${data?.stats?.rowsInserted ?? 0} righe`);
      setSelectedFile(null);
      setConfirmText('');
      if (fileRef.current) fileRef.current.value = '';
      queryClient.invalidateQueries({ queryKey: ['backup-info'] });
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Errore ripristino'),
  });

  const canRestore = !!selectedFile && confirmText === CONFIRM_TOKEN && !restoreMutation.isPending;

  return (
    <>
      <div>
        <h2 className="text-lg font-semibold">Backup database</h2>
        <p className="text-sm text-muted-foreground">Esporta uno snapshot completo del database o ripristinalo da un file di backup.</p>
      </div>

      {/* Stats */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4 text-muted-foreground" /> Contenuto del database
        </div>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Caricamento...</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/40 p-4 text-center">
              <p className="text-2xl font-bold">{info?.tableCount ?? 0}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Tabelle</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-4 text-center">
              <p className="text-2xl font-bold">{(info?.totalRows ?? 0).toLocaleString('it-IT')}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Righe totali</p>
            </div>
          </div>
        )}
      </div>

      {/* Export */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Download className="h-4 w-4 text-muted-foreground" /> Esporta backup
        </div>
        <p className="text-xs text-muted-foreground">
          Scarica un file JSON contenente tutti i dati del database. Conservalo in un luogo sicuro:
          contiene anche dati sensibili (hash password, secret cifrati, dati clienti).
        </p>
        <Button onClick={exportBackup} disabled={exporting}>
          {exporting ? 'Esportazione...' : 'Scarica backup completo'}
        </Button>
      </div>

      {/* Restore */}
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.02] p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <Upload className="h-4 w-4" /> Ripristina da backup
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Operazione irreversibile</p>
            <p className="text-destructive/80">
              Il ripristino <strong>cancella tutti i dati attuali</strong> e li sostituisce con il contenuto del file.
              Verrà creato automaticamente un backup di sicurezza in <code>uploads/backups/</code> prima di procedere.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium">File di backup (.json)</Label>
          <Input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            className="text-sm h-9"
          />
          {selectedFile && (
            <p className="text-[10px] text-muted-foreground">
              {selectedFile.name} · {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium">
            Per confermare, digita <code className="text-destructive">{CONFIRM_TOKEN}</code>
          </Label>
          <Input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_TOKEN}
            className="text-sm h-9 font-mono"
            autoComplete="off"
          />
        </div>

        <Button
          variant="destructive"
          onClick={() => restoreMutation.mutate()}
          disabled={!canRestore}
        >
          {restoreMutation.isPending ? 'Ripristino in corso...' : 'Ripristina database'}
        </Button>
      </div>
    </>
  );
}
