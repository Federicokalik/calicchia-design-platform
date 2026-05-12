import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
interface ModalitaPagamento { id: string; nome: string; sconto_percentuale: number; rate: Rata[]; }

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

// Default sections for new quote
const DEFAULT_SECTIONS: Section[] = [
  { id: uid(), type: 'offerte', data: { offerte: [{ id: uid(), nome: '', descrizione: '', prezzo: 0, consigliata: true, include: [''], esclude: [''] }] } },
  { id: uid(), type: 'materiali', data: { lista: ['Logo (vettoriale)', 'Testi / Copy', 'Foto / Immagini', 'Accessi (hosting, dominio)'] } },
  { id: uid(), type: 'tempistiche', data: { prima_bozza: '10-15 giorni lavorativi', nota: 'dalla ricezione dei materiali' } },
  { id: uid(), type: 'pagamento', data: { modalita: [{ id: uid(), nome: 'Saldo Unico (10% sconto)', sconto_percentuale: 10, rate: [] }, { id: uid(), nome: '2 Rate', sconto_percentuale: 0, rate: [{ percentuale: 50, momento: 'alla firma' }, { percentuale: 50, momento: 'al completamento' }] }] } },
  { id: uid(), type: 'contratto', data: { auto: true, servizi: [''], clausole: [''] } },
];

export default function PreventivoEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !id || id === 'new';

  // Header fields
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('Preventivo e Contratto di Incarico');
  const [customerId, setCustomerId] = useState('');
  const [tipoCliente, setTipoCliente] = useState('azienda');
  const [validUntil, setValidUntil] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  // Sections
  const [sections, setSections] = useState<Section[]>(DEFAULT_SECTIONS);

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

  // Populate from existing
  useEffect(() => {
    if (data?.quote) {
      const q = data.quote;
      setTitle(q.title || '');
      setSubtitle(q.description || 'Preventivo e Contratto di Incarico');
      setCustomerId(q.customer_id || '');
      setValidUntil(q.valid_until || '');
      setInternalNotes(q.internal_notes || '');
      // Restore sections from items/metadata if stored
      if (q.project_template?.sections) {
        setSections(q.project_template.sections);
      }
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
      const items = allOfferte.map((o: Offerta) => ({
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
        project_template: { sections },
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
        );

      case 'pagamento':
        return (
          <>
            {(d.modalita || []).map((m: ModalitaPagamento, mi: number) => (
              <div key={m.id} className="rounded border p-3 space-y-2 bg-muted/20">
                <div className="flex gap-2">
                  <Input className="flex-1 h-7 text-xs" value={m.nome} placeholder="Nome opzione" onChange={(e) => { const next = [...d.modalita]; next[mi] = { ...m, nome: e.target.value }; updateSection(section.id, { ...d, modalita: next }); }} />
                  <Input className="w-20 h-7 text-xs" type="number" value={m.sconto_percentuale} placeholder="Sconto %" onChange={(e) => { const next = [...d.modalita]; next[mi] = { ...m, sconto_percentuale: parseFloat(e.target.value) || 0 }; updateSection(section.id, { ...d, modalita: next }); }} />
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

      case 'contratto':
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
          </>
        );

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
        <h1 className="text-xl font-bold tracking-tight flex-1 truncate">
          {isNew ? 'Nuovo Preventivo' : title || 'Modifica Preventivo'}
        </h1>
        <Button onClick={() => saveMutation.mutate()} disabled={!title.trim() || saveMutation.isPending} size="sm">
          <Save className="h-4 w-4 mr-1.5" />
          {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
        </Button>
      </div>

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
