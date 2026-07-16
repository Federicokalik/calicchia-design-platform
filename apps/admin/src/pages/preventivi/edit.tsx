import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
  ArrowLeft, Save, Plus, Trash2, FileText, Table2,
  Tag, AlertTriangle, Package, Clock, CreditCard, FileSignature,
  Sparkles, DollarSign,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DEFAULT_CONTRACT_ARTICLES, parseContractArticle } from '@calicchia/shared';
import { SectionWrapper } from '@/components/preventivi/section-wrapper';
import { PdfPreview } from '@/components/preventivi/pdf-preview';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';

// === Types ===
interface Statistica { valore: string; label: string; }
interface RigaComparativa { caratteristica: string; colonna_a: string; colonna_b: string; }
interface Offerta { id: string; nome: string; descrizione: string; prezzo: number; consigliata: boolean; include: string[]; esclude: string[]; }
interface ProblemaRisolto { problema: string; soluzione: string; }
interface Rata { percentuale: number; momento: string; }
interface ModalitaPagamento { id: string; nome: string; sconto_percentuale: number; rate: Rata[]; importo?: number; metodo?: string; }
interface FaseGantt { label: string; start_pct: number; width_pct: number; }

interface Section {
  id: string;
  type: 'premessa' | 'comparativa' | 'offerte' | 'problemi' | 'clausole' | 'materiali' | 'tempistiche' | 'pagamento' | 'contratto';
  data: any;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

const SECTION_TYPES = [
  { type: 'premessa', label: 'Premessa', icon: FileText },
  { type: 'comparativa', label: 'Tabella Comparativa', icon: Table2 },
  { type: 'offerte', label: 'Offerte', icon: Tag },
  { type: 'problemi', label: 'Problemi Risolti', icon: AlertTriangle },
  { type: 'clausole', label: 'Clausole Speciali', icon: AlertTriangle },
  { type: 'materiali', label: 'Materiali Necessari', icon: Package },
  { type: 'tempistiche', label: 'Tempistiche', icon: Clock },
  { type: 'pagamento', label: 'Modalità Pagamento', icon: CreditCard },
  { type: 'contratto', label: 'Contratto', icon: FileSignature },
] as const;

// Fallback when quote.settings.materiali_default hasn't loaded yet.
const DEFAULT_MATERIALI = ['Logo (vettoriale)', 'Testi / Copy', 'Foto / Immagini', 'Accessi (hosting, dominio)'];

// Default sections for new quote
const DEFAULT_SECTIONS: Section[] = [
  { id: uid(), type: 'offerte', data: { offerte: [{ id: uid(), nome: '', descrizione: '', prezzo: 0, consigliata: true, include: [''], esclude: [''] }] } },
  { id: uid(), type: 'materiali', data: { lista: DEFAULT_MATERIALI } },
  { id: uid(), type: 'tempistiche', data: { prima_bozza: '10-15 giorni lavorativi', nota: 'dalla ricezione dei materiali' } },
  { id: uid(), type: 'pagamento', data: { modalita: [{ id: uid(), nome: 'Saldo Unico (10% sconto)', sconto_percentuale: 10, rate: [] }, { id: uid(), nome: '2 Rate', sconto_percentuale: 0, rate: [{ percentuale: 50, momento: 'alla firma' }, { percentuale: 50, momento: 'al completamento' }] }] } },
  { id: uid(), type: 'contratto', data: { auto: true, servizi: [''], clausole: [''] } },
];

export default function PreventivoEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isNew = !id || id === 'new';

  // Non-binding customer matches from the Markdown import (router state) —
  // the admin confirms or dismisses; the quote is never auto-linked.
  const [suggestedCustomers, setSuggestedCustomers] = useState<any[]>(
    () => (location.state as any)?.suggestedCustomers || [],
  );
  // Client identity extracted from the brief's frontmatter — offered as
  // "create & link" when no existing customer matches.
  const [clientHint, setClientHint] = useState<{ nome: string; piva: string; referente: string } | null>(
    () => (location.state as any)?.clientHint || null,
  );
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const createAndLinkCustomer = async () => {
    if (!clientHint) return;
    setCreatingCustomer(true);
    try {
      const res = await apiFetch('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          company_name: clientHint.nome || null,
          contact_name: clientHint.referente || clientHint.nome,
          billing_address: clientHint.piva ? { vat_number: clientHint.piva } : {},
          createOnStripe: false,
        }),
      });
      if (res?.customer?.id) {
        setCustomerId(res.customer.id);
        setClientHint(null);
        setSuggestedCustomers([]);
        queryClient.invalidateQueries({ queryKey: ['customers-select'] });
        toast.success(`Cliente "${clientHint.nome || clientHint.referente}" creato e collegato — ricorda di salvare`);
      } else {
        toast.error('Creazione cliente fallita');
      }
    } catch (e: any) {
      toast.error(e?.message || 'Creazione cliente fallita');
    } finally {
      setCreatingCustomer(false);
    }
  };

  // Header fields
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('Preventivo e Contratto di Incarico');
  const [customerId, setCustomerId] = useState('');
  const [tipoCliente, setTipoCliente] = useState('azienda');
  const [validUntil, setValidUntil] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  // Sections
  const [sections, setSections] = useState<Section[]>(DEFAULT_SECTIONS);

  // Custom-HTML quotes: the document is the uploaded file, items/totals were
  // set at import. The editor must NOT overwrite them on save — we keep the
  // loaded template extras + items and send them back verbatim.
  const [isCustomDoc, setIsCustomDoc] = useState(false);
  const customTemplateExtrasRef = useRef<Record<string, any>>({});
  const originalItemsRef = useRef<any[] | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Fetch existing
  const { data } = useQuery({
    queryKey: ['quote-v2-edit', id],
    queryFn: () => apiFetch(`/api/quotes-v2/${id}`),
    enabled: !isNew,
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });

  // quote.settings drives the default materials list and the global contract
  // articles the per-quote override editor falls back to.
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings'),
    staleTime: 60_000,
  });
  const quoteSettings = (((settingsData as any)?.settings ?? settingsData) || {})['quote.settings'] || {};
  const globalArticles: string[] = Array.isArray(quoteSettings.contratto_articoli) && quoteSettings.contratto_articoli.length
    ? quoteSettings.contratto_articoli
    : DEFAULT_CONTRACT_ARTICLES;
  const [openOverrideIdx, setOpenOverrideIdx] = useState<number | null>(null);

  // New quote: swap the hardcoded materials fallback for the configured
  // default once settings load — only while the list is still untouched.
  useEffect(() => {
    const md = quoteSettings.materiali_default;
    if (!isNew || !Array.isArray(md) || !md.length) return;
    setSections((prev) => prev.map((s) =>
      s.type === 'materiali' && JSON.stringify(s.data?.lista) === JSON.stringify(DEFAULT_MATERIALI)
        ? { ...s, data: { ...s.data, lista: md } }
        : s,
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, settingsData]);

  // Populate from existing
  useEffect(() => {
    if (data?.quote) {
      const q = data.quote;
      setTitle(q.title || '');
      setSubtitle(q.description || 'Preventivo e Contratto di Incarico');
      setCustomerId(q.customer_id || '');
      setValidUntil(q.valid_until || '');
      setInternalNotes(q.internal_notes || '');
      // Restore sections. project_template can come back as a JSON *string*
      // (double-encoded jsonb) — the PDF renderer and sign page already parse
      // defensively; without this the editor silently fell back to the empty
      // defaults and a save would overwrite the imported/stored sections.
      try {
        const pt = typeof q.project_template === 'string' ? JSON.parse(q.project_template) : q.project_template;
        if (Array.isArray(pt?.sections) && pt.sections.length) {
          setSections(pt.sections);
        }
        if (pt && typeof pt === 'object') {
          const { sections: _s, ...extras } = pt;
          customTemplateExtrasRef.current = extras;
          if (extras.custom_html) {
            setIsCustomDoc(true);
            const rawItems = typeof q.items === 'string' ? JSON.parse(q.items) : q.items;
            originalItemsRef.current = Array.isArray(rawItems) ? rawItems : [];
          }
        }
      } catch { /* malformed template → keep defaults */ }
    }
  }, [data]);

  const customers = customersData?.customers || [];

  useTopbar({ title: isNew ? 'Nuovo Preventivo' : title || 'Modifica Preventivo' });

  // Calculate totals from offerte sections
  const allOfferte = sections
    .filter((s) => s.type === 'offerte')
    .flatMap((s) => s.data.offerte || []);
  const subtotal = allOfferte.reduce((sum: number, o: Offerta) => sum + (o.prezzo || 0), 0);

  // Section helpers
  const updateSection = (sectionId: string, newData: any) => {
    setSections((prev) => prev.map((s) => s.id === sectionId ? { ...s, data: newData } : s));
  };

  const removeSection = (sectionId: string) => {
    setSections((prev) => prev.filter((s) => s.id !== sectionId));
  };

  const addSection = (type: Section['type']) => {
    const defaults: Record<string, any> = {
      premessa: { testo: '', statistiche: [], problemi_critici: [] },
      comparativa: { titolo: '', intro: '', intestazione_a: 'Proposta', intestazione_b: 'Attuale', righe: [{ caratteristica: '', colonna_a: '', colonna_b: '' }] },
      offerte: { offerte: [{ id: uid(), nome: '', descrizione: '', prezzo: 0, consigliata: false, include: [''], esclude: [''] }] },
      problemi: { lista: [{ problema: '', soluzione: '' }] },
      clausole: { tipo: 'warning', titolo: '', testo: '', lista: [''] },
      materiali: { lista: [''] },
      tempistiche: { prima_bozza: '', nota: '' },
      pagamento: { modalita: [{ id: uid(), nome: '', sconto_percentuale: 0, rate: [] }] },
      contratto: { auto: true, servizi: [''], clausole: [''] },
    };
    setSections((prev) => [...prev, { id: uid(), type, data: defaults[type] || {} }]);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSections((prev) => {
        const oldIdx = prev.findIndex((s) => s.id === active.id);
        const newIdx = prev.findIndex((s) => s.id === over.id);
        return arrayMove(prev, oldIdx, newIdx);
      });
    }
  };

  // Save
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Custom-HTML docs: items/totals come from the import, not the section
      // builder — send them back unchanged so a save can't zero the quote.
      const items = isCustomDoc
        ? (originalItemsRef.current || [])
        : allOfferte.map((o: Offerta) => ({
            description: o.nome, quantity: 1, unit_price: o.prezzo, total: o.prezzo,
          }));
      const body = {
        customer_id: customerId || null,
        title,
        description: subtitle,
        items,
        tax_rate: 0, // Forfettario, no IVA
        valid_until: validUntil || null,
        internal_notes: internalNotes,
        materials_checklist: sections.find((s) => s.type === 'materiali')?.data.lista?.map((l: string) => ({ label: l, received: false })) || [],
        auto_create_project: sections.find((s) => s.type === 'contratto')?.data.auto ?? true,
        project_template: { ...customTemplateExtrasRef.current, sections },
      };
      if (isNew) return apiFetch('/api/quotes-v2', { method: 'POST', body: JSON.stringify(body) });
      return apiFetch(`/api/quotes-v2/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['quotes-v2'] });
      toast.success(isNew ? 'Preventivo creato' : 'Salvato');
      if (isNew && res?.quote?.id) navigate(`/preventivi/${res.quote.id}`, { replace: true });
    },
    onError: () => toast.error('Errore nel salvataggio'),
  });

  // === RENDER SECTION CONTENT ===
  const renderSection = (section: Section) => {
    const d = section.data;

    switch (section.type) {
      case 'premessa':
        return (
          <>
            <Textarea value={d.testo} onChange={(e) => updateSection(section.id, { ...d, testo: e.target.value })} rows={4} placeholder="Testo introduttivo per il cliente..." />
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs">Statistiche</Label>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => updateSection(section.id, { ...d, statistiche: [...(d.statistiche || []), { valore: '', label: '' }] })}>
                  <Plus className="h-3 w-3 mr-1" /> Aggiungi
                </Button>
              </div>
              {(d.statistiche || []).map((s: Statistica, i: number) => (
                <div key={i} className="flex gap-2 mb-1.5">
                  <Input className="w-20 h-7 text-xs" value={s.valore} placeholder="8" onChange={(e) => { const next = [...d.statistiche]; next[i] = { ...s, valore: e.target.value }; updateSection(section.id, { ...d, statistiche: next }); }} />
                  <Input className="flex-1 h-7 text-xs" value={s.label} placeholder="Pagine funzionanti" onChange={(e) => { const next = [...d.statistiche]; next[i] = { ...s, label: e.target.value }; updateSection(section.id, { ...d, statistiche: next }); }} />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { const next = d.statistiche.filter((_: any, j: number) => j !== i); updateSection(section.id, { ...d, statistiche: next }); }}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ))}
            </div>
          </>
        );

      case 'offerte':
        return (
          <>
            {(d.offerte || []).map((o: Offerta, oi: number) => (
              <div key={o.id} className="rounded-lg border p-3 space-y-2 bg-muted/20">
                <div className="flex items-center gap-2">
                  <Input className="flex-1 h-8 text-sm font-medium" value={o.nome} placeholder="Nome offerta" onChange={(e) => { const next = [...d.offerte]; next[oi] = { ...o, nome: e.target.value }; updateSection(section.id, { ...d, offerte: next }); }} />
                  <Input className="w-28 h-8 text-sm" type="number" value={o.prezzo} placeholder="€" onChange={(e) => { const next = [...d.offerte]; next[oi] = { ...o, prezzo: parseFloat(e.target.value) || 0 }; updateSection(section.id, { ...d, offerte: next }); }} />
                  <div className="flex items-center gap-1">
                    <Switch checked={o.consigliata} onCheckedChange={(v) => { const next = [...d.offerte]; next[oi] = { ...o, consigliata: v }; updateSection(section.id, { ...d, offerte: next }); }} />
                    <span className="text-[10px] text-muted-foreground">Top</span>
                  </div>
                  {d.offerte.length > 1 && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateSection(section.id, { ...d, offerte: d.offerte.filter((_: any, j: number) => j !== oi) })}><Trash2 className="h-3 w-3" /></Button>
                  )}
                </div>
                <Textarea className="text-xs" rows={1} value={o.descrizione} placeholder="Descrizione..." onChange={(e) => { const next = [...d.offerte]; next[oi] = { ...o, descrizione: e.target.value }; updateSection(section.id, { ...d, offerte: next }); }} />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px]">Include</Label>
                    {o.include.map((inc: string, ii: number) => (
                      <div key={ii} className="flex gap-1 mb-1">
                        <Input className="h-6 text-[11px]" value={inc} onChange={(e) => { const next = [...d.offerte]; const includes = [...o.include]; includes[ii] = e.target.value; next[oi] = { ...o, include: includes }; updateSection(section.id, { ...d, offerte: next }); }} />
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => { const next = [...d.offerte]; next[oi] = { ...o, include: o.include.filter((_: any, j: number) => j !== ii) }; updateSection(section.id, { ...d, offerte: next }); }}><Trash2 className="h-2.5 w-2.5" /></Button>
                      </div>
                    ))}
                    <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => { const next = [...d.offerte]; next[oi] = { ...o, include: [...o.include, ''] }; updateSection(section.id, { ...d, offerte: next }); }}>+ voce</Button>
                  </div>
                  <div>
                    <Label className="text-[10px]">Esclude</Label>
                    {o.esclude.map((exc: string, ei: number) => (
                      <div key={ei} className="flex gap-1 mb-1">
                        <Input className="h-6 text-[11px]" value={exc} onChange={(e) => { const next = [...d.offerte]; const esclude = [...o.esclude]; esclude[ei] = e.target.value; next[oi] = { ...o, esclude }; updateSection(section.id, { ...d, offerte: next }); }} />
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => { const next = [...d.offerte]; next[oi] = { ...o, esclude: o.esclude.filter((_: any, j: number) => j !== ei) }; updateSection(section.id, { ...d, offerte: next }); }}><Trash2 className="h-2.5 w-2.5" /></Button>
                      </div>
                    ))}
                    <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => { const next = [...d.offerte]; next[oi] = { ...o, esclude: [...o.esclude, ''] }; updateSection(section.id, { ...d, offerte: next }); }}>+ voce</Button>
                  </div>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => updateSection(section.id, { ...d, offerte: [...d.offerte, { id: uid(), nome: '', descrizione: '', prezzo: 0, consigliata: false, include: [''], esclude: [''] }] })}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Aggiungi offerta
            </Button>
          </>
        );

      case 'materiali':
        return (
          <>
            {(d.lista || []).map((item: string, i: number) => (
              <div key={i} className="flex gap-2">
                <Input className="h-7 text-xs" value={item} onChange={(e) => { const next = [...d.lista]; next[i] = e.target.value; updateSection(section.id, { ...d, lista: next }); }} placeholder="Es. Logo vettoriale" />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateSection(section.id, { ...d, lista: d.lista.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-3 w-3" /></Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => updateSection(section.id, { ...d, lista: [...(d.lista || []), ''] })}>
              <Plus className="h-3 w-3 mr-1" /> Aggiungi
            </Button>
          </>
        );

      case 'tempistiche':
        return (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Prima bozza</Label>
                <Input className="h-8 text-xs" value={d.prima_bozza} onChange={(e) => updateSection(section.id, { ...d, prima_bozza: e.target.value })} placeholder="10-15 giorni lavorativi" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Nota</Label>
                <Input className="h-8 text-xs" value={d.nota} onChange={(e) => updateSection(section.id, { ...d, nota: e.target.value })} placeholder="dalla ricezione dei materiali" />
              </div>
            </div>
            <div className="pt-2">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs">Fasi Gantt (opzionale — se presenti, il PDF mostra la timeline)</Label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">Settimane</span>
                  <Input
                    className="w-14 h-6 text-[11px]"
                    type="number"
                    min={2}
                    max={16}
                    value={d.settimane || 8}
                    onChange={(e) => updateSection(section.id, { ...d, settimane: parseInt(e.target.value) || 8 })}
                  />
                </div>
              </div>
              {(d.fasi || []).map((f: FaseGantt, fi: number) => (
                <div key={fi} className="flex gap-1.5 mb-1 items-center">
                  <Input className="flex-1 h-6 text-[11px]" value={f.label} placeholder="Nome fase" onChange={(e) => { const next = [...d.fasi]; next[fi] = { ...f, label: e.target.value }; updateSection(section.id, { ...d, fasi: next }); }} />
                  <Input className="w-16 h-6 text-[11px]" type="number" min={0} max={100} value={f.start_pct} title="Inizio %" onChange={(e) => { const next = [...d.fasi]; next[fi] = { ...f, start_pct: parseFloat(e.target.value) || 0 }; updateSection(section.id, { ...d, fasi: next }); }} />
                  <Input className="w-16 h-6 text-[11px]" type="number" min={1} max={100} value={f.width_pct} title="Durata %" onChange={(e) => { const next = [...d.fasi]; next[fi] = { ...f, width_pct: parseFloat(e.target.value) || 0 }; updateSection(section.id, { ...d, fasi: next }); }} />
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => updateSection(section.id, { ...d, fasi: d.fasi.filter((_: any, j: number) => j !== fi) })}><Trash2 className="h-2.5 w-2.5" /></Button>
                </div>
              ))}
              {(d.fasi || []).length > 0 && (
                <p className="text-[10px] text-muted-foreground mb-1">Colonne: nome fase · inizio % · durata % (sulla timeline)</p>
              )}
              <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => updateSection(section.id, { ...d, fasi: [...(d.fasi || []), { label: '', start_pct: 0, width_pct: 12.5 }] })}>+ fase</Button>
            </div>
          </>
        );

      case 'pagamento':
        return (
          <>
            {(d.modalita || []).map((m: ModalitaPagamento, mi: number) => (
              <div key={m.id} className="rounded border p-3 space-y-2 bg-muted/20">
                <div className="flex gap-2">
                  <Input className="flex-1 h-7 text-xs" value={m.nome} placeholder="Nome opzione (es. Saldo anticipato)" onChange={(e) => { const next = [...d.modalita]; next[mi] = { ...m, nome: e.target.value }; updateSection(section.id, { ...d, modalita: next }); }} />
                  <Input className="w-20 h-7 text-xs" type="number" value={m.sconto_percentuale} placeholder="Sconto %" title="Sconto % (alternativo all'importo)" onChange={(e) => { const next = [...d.modalita]; next[mi] = { ...m, sconto_percentuale: parseFloat(e.target.value) || 0 }; updateSection(section.id, { ...d, modalita: next }); }} />
                </div>
                <div className="flex gap-2">
                  <Input className="w-28 h-7 text-xs" type="number" value={m.importo ?? ''} placeholder="Importo € (opz.)" title="Totale specifico di questa opzione — ha priorità sullo sconto % (es. rate BNPL a costo maggiorato)" onChange={(e) => { const next = [...d.modalita]; next[mi] = { ...m, importo: e.target.value === '' ? undefined : parseFloat(e.target.value) || 0 }; updateSection(section.id, { ...d, modalita: next }); }} />
                  <Input className="flex-1 h-7 text-xs" value={m.metodo ?? ''} placeholder="Metodo (es. bonifico · carta · PayPal · Klarna)" onChange={(e) => { const next = [...d.modalita]; next[mi] = { ...m, metodo: e.target.value }; updateSection(section.id, { ...d, modalita: next }); }} />
                </div>
                <Label className="text-[10px]">Rate</Label>
                {m.rate.map((r: Rata, ri: number) => (
                  <div key={ri} className="flex gap-2">
                    <Input className="w-16 h-6 text-[11px]" type="number" value={r.percentuale} placeholder="%" onChange={(e) => { const next = [...d.modalita]; const rate = [...m.rate]; rate[ri] = { ...r, percentuale: parseFloat(e.target.value) || 0 }; next[mi] = { ...m, rate }; updateSection(section.id, { ...d, modalita: next }); }} />
                    <Input className="flex-1 h-6 text-[11px]" value={r.momento} placeholder="alla firma" onChange={(e) => { const next = [...d.modalita]; const rate = [...m.rate]; rate[ri] = { ...r, momento: e.target.value }; next[mi] = { ...m, rate }; updateSection(section.id, { ...d, modalita: next }); }} />
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => { const next = [...d.modalita]; next[mi] = { ...m, rate: [...m.rate, { percentuale: 0, momento: '' }] }; updateSection(section.id, { ...d, modalita: next }); }}>+ rata</Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => updateSection(section.id, { ...d, modalita: [...d.modalita, { id: uid(), nome: '', sconto_percentuale: 0, rate: [] }] })}>
              <Plus className="h-3 w-3 mr-1" /> Aggiungi opzione
            </Button>
          </>
        );

      case 'comparativa':
        return (
          <>
            <Input className="h-7 text-xs" value={d.titolo} placeholder="Titolo sezione" onChange={(e) => updateSection(section.id, { ...d, titolo: e.target.value })} />
            <Textarea className="text-xs" rows={2} value={d.intro} placeholder="Introduzione..." onChange={(e) => updateSection(section.id, { ...d, intro: e.target.value })} />
            <div className="grid grid-cols-[1fr_1fr_1fr] gap-1 text-[10px] font-medium text-muted-foreground">
              <span>Caratteristica</span>
              <Input className="h-5 text-[10px]" value={d.intestazione_a} onChange={(e) => updateSection(section.id, { ...d, intestazione_a: e.target.value })} />
              <Input className="h-5 text-[10px]" value={d.intestazione_b} onChange={(e) => updateSection(section.id, { ...d, intestazione_b: e.target.value })} />
            </div>
            {(d.righe || []).map((r: RigaComparativa, i: number) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_24px] gap-1">
                <Input className="h-6 text-[11px]" value={r.caratteristica} onChange={(e) => { const next = [...d.righe]; next[i] = { ...r, caratteristica: e.target.value }; updateSection(section.id, { ...d, righe: next }); }} />
                <Input className="h-6 text-[11px]" value={r.colonna_a} onChange={(e) => { const next = [...d.righe]; next[i] = { ...r, colonna_a: e.target.value }; updateSection(section.id, { ...d, righe: next }); }} />
                <Input className="h-6 text-[11px]" value={r.colonna_b} onChange={(e) => { const next = [...d.righe]; next[i] = { ...r, colonna_b: e.target.value }; updateSection(section.id, { ...d, righe: next }); }} />
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => updateSection(section.id, { ...d, righe: d.righe.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-2.5 w-2.5" /></Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => updateSection(section.id, { ...d, righe: [...(d.righe || []), { caratteristica: '', colonna_a: '', colonna_b: '' }] })}>+ riga</Button>
          </>
        );

      case 'problemi':
        return (
          <>
            {(d.lista || []).map((p: ProblemaRisolto, i: number) => (
              <div key={i} className="flex gap-2">
                <Input className="flex-1 h-7 text-xs" value={p.problema} placeholder="Problema" onChange={(e) => { const next = [...d.lista]; next[i] = { ...p, problema: e.target.value }; updateSection(section.id, { ...d, lista: next }); }} />
                <Input className="flex-1 h-7 text-xs" value={p.soluzione} placeholder="Soluzione" onChange={(e) => { const next = [...d.lista]; next[i] = { ...p, soluzione: e.target.value }; updateSection(section.id, { ...d, lista: next }); }} />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateSection(section.id, { ...d, lista: d.lista.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-3 w-3" /></Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => updateSection(section.id, { ...d, lista: [...(d.lista || []), { problema: '', soluzione: '' }] })}>
              <Plus className="h-3 w-3 mr-1" /> Aggiungi
            </Button>
          </>
        );

      case 'clausole':
        return (
          <>
            <div className="flex gap-2">
              <Select value={d.tipo} onValueChange={(v) => updateSection(section.id, { ...d, tipo: v })}>
                <SelectTrigger className="w-28 h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="success">Successo</SelectItem>
                </SelectContent>
              </Select>
              <Input className="flex-1 h-7 text-xs" value={d.titolo} placeholder="Titolo clausola" onChange={(e) => updateSection(section.id, { ...d, titolo: e.target.value })} />
            </div>
            <Textarea className="text-xs" rows={2} value={d.testo} placeholder="Testo..." onChange={(e) => updateSection(section.id, { ...d, testo: e.target.value })} />
          </>
        );

      case 'contratto': {
        const overrides: (string | null)[] = Array.isArray(d.articoli_override) ? d.articoli_override : [];
        return (
          <>
            <div className="flex items-center gap-2">
              <Switch checked={d.auto ?? true} onCheckedChange={(v) => updateSection(section.id, { ...d, auto: v })} />
              <Label className="text-xs">Genera contratto automaticamente</Label>
            </div>
            <div>
              <Label className="text-[10px]">Servizi nel perimetro</Label>
              {(d.servizi || []).map((s: string, i: number) => (
                <div key={i} className="flex gap-1 mb-1">
                  <Input className="h-6 text-[11px]" value={s} onChange={(e) => { const next = [...d.servizi]; next[i] = e.target.value; updateSection(section.id, { ...d, servizi: next }); }} />
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => updateSection(section.id, { ...d, servizi: d.servizi.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-2.5 w-2.5" /></Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => updateSection(section.id, { ...d, servizi: [...(d.servizi || []), ''] })}>+ servizio</Button>
            </div>
            <div className="pt-2">
              <Label className="text-[10px]">Articoli del contratto — override per questo preventivo</Label>
              <p className="text-[10px] text-muted-foreground mb-1.5">Di default valgono gli articoli globali (Impostazioni → Preventivi). Personalizza qui solo gli articoli specifici di questo progetto.</p>
              <div className="space-y-1">
                {globalArticles.map((globalText, i) => {
                  const hasOverride = typeof overrides[i] === 'string' && (overrides[i] as string).trim() !== '';
                  const effective = hasOverride ? (overrides[i] as string) : globalText;
                  const parsed = parseContractArticle(effective, i);
                  const isOpen = openOverrideIdx === i;
                  return (
                    <div key={i} className={`rounded border ${hasOverride ? 'border-primary/40 bg-primary/5' : 'bg-muted/20'}`}>
                      <button
                        type="button"
                        className="flex items-center justify-between w-full px-2 py-1.5 text-left text-[11px] font-medium"
                        onClick={() => setOpenOverrideIdx(isOpen ? null : i)}
                      >
                        <span>Art. {parsed.numero} — {parsed.titolo}{hasOverride ? ' · personalizzato' : ''}</span>
                        <span className="text-muted-foreground">{isOpen ? '▲' : '▼'}</span>
                      </button>
                      {isOpen && (
                        <div className="px-2 pb-2 space-y-1">
                          <Textarea
                            className="text-[11px]"
                            rows={3}
                            value={effective}
                            onChange={(e) => {
                              const next = [...overrides];
                              while (next.length < globalArticles.length) next.push(null);
                              next[i] = e.target.value;
                              updateSection(section.id, { ...d, articoli_override: next });
                            }}
                          />
                          {hasOverride && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 text-[10px]"
                              onClick={() => {
                                const next = [...overrides];
                                while (next.length < globalArticles.length) next.push(null);
                                next[i] = null;
                                updateSection(section.id, { ...d, articoli_override: next });
                              }}
                            >
                              Ripristina testo globale
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        );
      }

      default:
        return <p className="text-xs text-muted-foreground">Sezione non implementata</p>;
    }
  };

  const getSectionLabel = (type: string) => SECTION_TYPES.find((t) => t.type === type)?.label || type;

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/preventivi')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold tracking-tight flex-1 truncate">
          {isNew ? 'Nuovo Preventivo' : title || 'Modifica Preventivo'}
        </h1>
        <Button onClick={() => saveMutation.mutate()} disabled={!title.trim() || saveMutation.isPending} size="sm">
          <Save className="h-4 w-4 mr-1.5" />
          {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
        </Button>
      </div>

      {/* Custom-HTML doc notice */}
      {isCustomDoc && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <b>Documento HTML su misura</b> — il PDF usa il file caricato all'import, non le sezioni
          qui sotto. Da questa pagina gestisci intestazione, cliente e note; totale e pagamento
          sono quelli indicati all'import.
        </div>
      )}

      {/* Customer suggestion banner (Markdown import) */}
      {(suggestedCustomers.length > 0 || clientHint) && !customerId && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
          <p className="text-xs font-semibold">
            {suggestedCustomers.length > 0 ? 'Possibile cliente esistente trovato nel brief' : 'Cliente indicato nel brief'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {suggestedCustomers.map((s: any) => (
              <div key={s.id} className="flex items-center gap-2 rounded border bg-card px-2.5 py-1.5 text-xs">
                <span>
                  <b>{s.contact_name}</b>
                  {s.company_name ? ` · ${s.company_name}` : ''}
                  {s.vat_number ? ` · P.IVA ${s.vat_number}` : ''}
                </span>
                <Button
                  size="sm"
                  className="h-6 text-[11px]"
                  onClick={() => { setCustomerId(s.id); setSuggestedCustomers([]); setClientHint(null); toast.success('Cliente collegato — ricorda di salvare'); }}
                >
                  Collega
                </Button>
              </div>
            ))}
            {clientHint && (
              <div className="flex items-center gap-2 rounded border border-dashed bg-card px-2.5 py-1.5 text-xs">
                <span>
                  <b>{clientHint.nome || clientHint.referente}</b>
                  {clientHint.piva ? ` · P.IVA ${clientHint.piva}` : ''}
                  {clientHint.referente && clientHint.nome ? ` · Rif. ${clientHint.referente}` : ''}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[11px]"
                  disabled={creatingCustomer}
                  onClick={createAndLinkCustomer}
                >
                  {creatingCustomer ? 'Creazione…' : 'Crea e collega'}
                </Button>
              </div>
            )}
            <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => { setSuggestedCustomers([]); setClientHint(null); }}>
              Ignora
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* LEFT: Editor */}
        <div className="space-y-4">
          {/* Header card */}
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="space-y-1.5">
              <Label>Titolo preventivo *</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Es. Sito Web per Rossi Srl" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Cliente</Label>
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger><SelectValue placeholder="Seleziona..." /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>{c.contact_name}{c.company_name ? ` (${c.company_name})` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Valido fino al</Label>
                <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Sottotitolo</Label>
                <Input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Tipo cliente</Label>
                <Select value={tipoCliente} onValueChange={setTipoCliente}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="azienda">Azienda</SelectItem>
                    <SelectItem value="privato">Privato</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Sortable sections */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {sections.map((section) => (
                <SectionWrapper
                  key={section.id}
                  id={section.id}
                  title={getSectionLabel(section.type)}
                  removable
                  onRemove={() => removeSection(section.id)}
                >
                  {renderSection(section)}
                </SectionWrapper>
              ))}
            </SortableContext>
          </DndContext>

          {/* Add section */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full border-dashed">
                <Plus className="h-4 w-4 mr-2" /> Aggiungi sezione
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {SECTION_TYPES.map(({ type, label, icon: Icon }) => (
                <DropdownMenuItem key={type} onClick={() => addSection(type as Section['type'])}>
                  <Icon className="h-4 w-4 mr-2" /> {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* AI Assist */}
          <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-4 space-y-2">
            <p className="text-xs font-semibold text-primary flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Assistente AI
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={async () => {
                  if (!allOfferte.length) { toast.error('Aggiungi almeno un\'offerta'); return; }
                  toast.info('Calcolo tempistiche...');
                  try {
                    const res = await apiFetch('/api/ai/chat', {
                      method: 'POST',
                      body: JSON.stringify({
                        message: `Analizza queste voci di preventivo e genera tempistiche realistiche per un web designer freelance. Voci: ${allOfferte.map((o: any) => `${o.nome} (€${o.prezzo})`).join(', ')}. Rispondi con: 1) Prima bozza in X giorni 2) Tempo totale stimato 3) Nota (es. "dalla ricezione dei materiali"). Rispondi SOLO in formato conciso, 2-3 righe.`,
                        context: 'preventivi',
                      }),
                    });
                    // Find or create tempistiche section
                    const existing = sections.find((s) => s.type === 'tempistiche');
                    if (existing) {
                      const lines = (res.reply || '').split('\n').filter(Boolean);
                      updateSection(existing.id, { prima_bozza: lines[0] || res.reply, nota: lines[1] || '' });
                    } else {
                      addSection('tempistiche');
                    }
                    toast.success('Tempistiche generate!');
                  } catch { toast.error('Errore AI'); }
                }}
              >
                <Clock className="h-3 w-3 mr-1" /> Genera tempistiche
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={async () => {
                  if (!allOfferte.length) { toast.error('Aggiungi almeno un\'offerta'); return; }
                  toast.info('Generazione premessa...');
                  try {
                    const customerName = customers.find((c: any) => c.id === customerId)?.contact_name || '';
                    const companyName = customers.find((c: any) => c.id === customerId)?.company_name || '';
                    const res = await apiFetch('/api/ai/chat', {
                      method: 'POST',
                      body: JSON.stringify({
                        message: `Scrivi una premessa professionale per un preventivo di web design per ${customerName} (${companyName}). Servizi: ${allOfferte.map((o: any) => o.nome).join(', ')}. Totale: €${subtotal}. La premessa deve essere 2-3 paragrafi, tono professionale ma cordiale, in italiano. Spiega perché il cliente ha bisogno di questi servizi.`,
                        context: 'preventivi',
                      }),
                    });
                    const existing = sections.find((s) => s.type === 'premessa');
                    if (existing) {
                      updateSection(existing.id, { testo: res.reply || '' });
                    } else {
                      const newId = uid();
                      setSections((prev) => [{ id: newId, type: 'premessa', data: { testo: res.reply || '', statistiche: [], problemi_critici: [] } }, ...prev]);
                    }
                    toast.success('Premessa generata!');
                  } catch { toast.error('Errore AI'); }
                }}
              >
                <FileText className="h-3 w-3 mr-1" /> Genera premessa
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={async () => {
                  if (!allOfferte.length) { toast.error('Aggiungi almeno un\'offerta'); return; }
                  toast.info('Suggerimento prezzi...');
                  try {
                    const res = await apiFetch('/api/ai/chat', {
                      method: 'POST',
                      body: JSON.stringify({
                        message: `Come web designer freelance italiano, valuta se questi prezzi sono adeguati al mercato 2026: ${allOfferte.map((o: any) => `${o.nome}: €${o.prezzo}`).join(', ')}. Suggerisci aggiustamenti se necessario. Rispondi conciso, 3-5 righe.`,
                        context: 'preventivi',
                      }),
                    });
                    toast.info(res.reply || 'Nessun suggerimento', { duration: 10000 });
                  } catch { toast.error('Errore AI'); }
                }}
              >
                <DollarSign className="h-3 w-3 mr-1" /> Valuta prezzi
              </Button>
            </div>
          </div>

          {/* Internal notes */}
          <div className="rounded-lg border bg-card p-4 space-y-1.5">
            <Label>Note interne (non visibili al cliente)</Label>
            <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={2} placeholder="Appunti per te..." />
          </div>
        </div>

        {/* RIGHT: Summary + Preview */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 space-y-3 sticky top-20">
            <h3 className="text-sm font-semibold">Riepilogo</h3>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Offerte</span>
                <span>{allOfferte.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sezioni</span>
                <span>{sections.length}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold text-base">
                <span>Totale</span>
                <span>€{subtotal.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>
              </div>
              {subtotal > 77.47 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>+ Marca da bollo</span>
                  <span>€2,00</span>
                </div>
              )}
            </div>

            <Separator />

            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Preview PDF (live)</h4>
              <PdfPreview
                data={{
                  title,
                  subtitle,
                  customerName: customers.find((c: any) => c.id === customerId)?.contact_name || '',
                  customerCompany: customers.find((c: any) => c.id === customerId)?.company_name || '',
                  tipoCliente,
                  validUntil,
                  sections,
                  totale: subtotal,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
