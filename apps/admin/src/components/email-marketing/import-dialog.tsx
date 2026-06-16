import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api';
import { parseCsv } from '@/lib/csv';

const CANONICAL_FIELDS = [
  'email', 'phone', 'first_name', 'last_name', 'company',
  'role', 'website', 'industry', 'city', 'country', 'ignore',
] as const;

interface PreviewResult {
  total: number;
  new: number;
  duplicate_existing: number;
  duplicate_in_file: number;
  phone_only: number;
  invalid: number;
  mapping: Record<string, string>;
  invalid_samples: { row: number; reason: string }[];
  sample: Record<string, unknown>[];
}

interface ListOption { id: string; name: string }

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // import config
  const [listMode, setListMode] = useState<'new' | 'existing' | 'none'>('new');
  const [newListName, setNewListName] = useState('');
  const [existingListId, setExistingListId] = useState('');
  const [audienceType, setAudienceType] = useState('cold');
  const [legalBasis, setLegalBasis] = useState('legitimate_interest_b2b');
  const [tagsInput, setTagsInput] = useState('');
  const [onDuplicate, setOnDuplicate] = useState<'merge' | 'skip'>('merge');

  const { data: listsData } = useQuery<{ lists: ListOption[] }>({
    queryKey: ['mkt-lists'],
    queryFn: () => apiFetch('/api/email-marketing/lists'),
    enabled: open,
  });

  function reset() {
    setRows([]); setFileName(''); setPreview(null); setMapping({});
    setNewListName(''); setTagsInput('');
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (!newListName) setNewListName(file.name.replace(/\.csv$/i, ''));
    const text = await file.text();
    const parsed = parseCsv(text);
    if (!parsed.length) { toast.error('CSV vuoto o non valido'); return; }
    setRows(parsed);
    await runPreview(parsed);
  }

  async function runPreview(theRows: Record<string, string>[], overrideMapping?: Record<string, string>) {
    setBusy(true);
    try {
      const res: PreviewResult = await apiFetch('/api/email-marketing/import/preview', {
        method: 'POST',
        body: JSON.stringify({ rows: theRows, mapping: overrideMapping }),
      });
      setPreview(res);
      setMapping(overrideMapping ?? res.mapping);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Anteprima fallita');
    } finally { setBusy(false); }
  }

  function updateMapping(header: string, field: string) {
    const next = { ...mapping, [header]: field };
    setMapping(next);
    runPreview(rows, next);
  }

  async function handleCommit() {
    setBusy(true);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await apiFetch('/api/email-marketing/import/commit', {
        method: 'POST',
        body: JSON.stringify({
          rows,
          mapping,
          list_id: listMode === 'existing' ? existingListId : undefined,
          new_list_name: listMode === 'new' ? newListName : undefined,
          audience_type: audienceType,
          email_legal_basis: legalBasis,
          consent_source: `import:${fileName || 'csv'}`,
          tags,
          on_duplicate: onDuplicate,
        }),
      });
      toast.success(`Importati ${res.imported} nuovi · ${res.merged} aggiornati · ${res.skipped + res.invalid} saltati`);
      queryClient.invalidateQueries({ queryKey: ['mkt-contacts'] });
      queryClient.invalidateQueries({ queryKey: ['mkt-lists'] });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import fallito');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importa contatti da CSV</DialogTitle>
          <DialogDescription>
            Standard Apify e simili. Le colonne riconosciute vengono mappate
            automaticamente; le altre sono conservate nei metadata.
          </DialogDescription>
        </DialogHeader>

        {!rows.length ? (
          <label className="flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-lg p-10 cursor-pointer hover:bg-muted/40">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Seleziona un file .csv</span>
            <Input type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
          </label>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{fileName}</span>
              <span className="text-muted-foreground">· {rows.length} righe</span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>Cambia file</Button>
            </div>

            {busy && !preview && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Analisi in corso…
              </div>
            )}

            {preview && (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat label="Nuovi" value={preview.new} tone="good" />
                  <Stat label="Già presenti" value={preview.duplicate_existing + preview.duplicate_in_file} tone="muted" />
                  <Stat label="Non validi" value={preview.invalid} tone={preview.invalid ? 'warn' : 'muted'} />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground">Mappatura colonne</Label>
                  <div className="rounded-lg border divide-y max-h-48 overflow-y-auto">
                    {Object.keys(mapping).map((header) => (
                      <div key={header} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="text-sm font-mono truncate flex-1">{header}</span>
                        <Select value={mapping[header]} onValueChange={(v) => updateMapping(header, v)}>
                          <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {CANONICAL_FIELDS.map((f) => (
                              <SelectItem key={f} value={f}>{f === 'ignore' ? '— ignora —' : f}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                {preview.invalid_samples.length > 0 && (
                  <div className="text-xs text-amber-600 flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{preview.invalid_samples.slice(0, 3).map((s) => `Riga ${s.row}: ${s.reason}`).join(' · ')}</span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 pt-2 border-t">
                  <div className="space-y-1.5 col-span-2">
                    <Label className="text-xs">Lista di destinazione</Label>
                    <div className="flex gap-2">
                      <Select value={listMode} onValueChange={(v) => setListMode(v as typeof listMode)}>
                        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new">Nuova lista</SelectItem>
                          <SelectItem value="existing">Lista esistente</SelectItem>
                          <SelectItem value="none">Nessuna</SelectItem>
                        </SelectContent>
                      </Select>
                      {listMode === 'new' && (
                        <Input value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="Nome lista" className="flex-1" />
                      )}
                      {listMode === 'existing' && (
                        <Select value={existingListId} onValueChange={setExistingListId}>
                          <SelectTrigger className="flex-1"><SelectValue placeholder="Scegli lista" /></SelectTrigger>
                          <SelectContent>
                            {(listsData?.lists ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Tipo audience</Label>
                    <Select value={audienceType} onValueChange={setAudienceType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cold">Freddo (scraped/B2B)</SelectItem>
                        <SelectItem value="warm">Caldo (ha interagito)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Base giuridica</Label>
                    <Select value={legalBasis} onValueChange={setLegalBasis}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="legitimate_interest_b2b">Legittimo interesse B2B</SelectItem>
                        <SelectItem value="soft_optin">Soft opt-in</SelectItem>
                        <SelectItem value="consent">Consenso esplicito</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Tag (separati da virgola)</Label>
                    <Input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="es. apify, milano" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Duplicati</Label>
                    <Select value={onDuplicate} onValueChange={(v) => setOnDuplicate(v as typeof onDuplicate)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="merge">Arricchisci (merge)</SelectItem>
                        <SelectItem value="skip">Salta esistenti</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>Annulla</Button>
          <Button
            onClick={handleCommit}
            disabled={busy || !preview || preview.new === 0 || (listMode === 'new' && !newListName) || (listMode === 'existing' && !existingListId)}
            className="gap-1.5"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Importa {preview ? `${preview.new} contatti` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'muted' }) {
  const cls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
  return (
    <div className="rounded-lg border p-3">
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
      <Badge variant="outline" className="text-[10px] mt-1">{label}</Badge>
    </div>
  );
}
