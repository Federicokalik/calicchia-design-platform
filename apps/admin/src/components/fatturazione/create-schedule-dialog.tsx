import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch, API_BASE } from '@/lib/api';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CreateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

type OcrState = 'idle' | 'extracting' | 'done' | 'error';

interface ExtractedData {
  invoice_number?: string;
  customer_name?: string;
  customer_email?: string;
  description?: string;
  total?: number;
  tax_amount?: number;
  due_date?: string;
  line_items?: Array<{ description?: string; amount?: number }>;
}

export function CreateScheduleDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateScheduleDialogProps) {
  // Form state
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [scheduleType, setScheduleType] = useState('installment');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');

  // OCR state
  const [ocrState, setOcrState] = useState<OcrState>('idle');
  const [ocrExpanded, setOcrExpanded] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = useCallback(() => {
    setTitle('');
    setAmount('');
    setScheduleType('installment');
    setDueDate('');
    setNotes('');
    setCustomerId(null);
    setCustomerName('');
    setOcrState('idle');
    setOcrExpanded(true);
    setIsDragOver(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetForm();
      onOpenChange(next);
    },
    [onOpenChange, resetForm],
  );

  // --- OCR extraction ---
  const processFile = useCallback(async (file: File) => {
    setOcrState('extracting');
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${API_BASE}/api/ai/extract-invoice`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Errore durante l\'estrazione');
      }

      const { extracted } = (await res.json()) as { extracted: ExtractedData };

      // Pre-fill form fields
      if (extracted.description || extracted.invoice_number) {
        setTitle(extracted.description || `Fattura ${extracted.invoice_number}`);
      }
      if (extracted.total != null) {
        setAmount(String(extracted.total));
      }
      if (extracted.due_date) {
        // Normalise to YYYY-MM-DD if needed
        const d = new Date(extracted.due_date);
        if (!isNaN(d.getTime())) {
          setDueDate(d.toISOString().split('T')[0]);
        }
      }
      if (extracted.line_items?.length) {
        const summary = extracted.line_items
          .map((li) => `${li.description ?? ''}${li.amount != null ? ` — €${li.amount}` : ''}`)
          .join('\n');
        setNotes(summary);
      }

      // Try to match customer
      if (extracted.customer_name) {
        setCustomerName(extracted.customer_name);
        try {
          const customers = await apiFetch(
            `/api/customers?search=${encodeURIComponent(extracted.customer_name)}`,
          );
          const list = Array.isArray(customers) ? customers : customers?.data;
          if (list?.length) {
            setCustomerId(list[0].id);
            setCustomerName(list[0].name || list[0].company || extracted.customer_name);
          }
        } catch {
          // Customer match is best-effort
        }
      }

      setOcrState('done');
    } catch (err: any) {
      toast.error(err.message || 'Errore estrazione dati');
      setOcrState('error');
    }
  }, []);

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      // Reset input so same file can be re-selected
      e.target.value = '';
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  // --- Create mutation ---
  const createMutation = useMutation({
    mutationFn: async () => {
      return apiFetch('/api/payments/schedules', {
        method: 'POST',
        body: JSON.stringify({
          title,
          amount: parseFloat(amount),
          schedule_type: scheduleType,
          due_date: dueDate || undefined,
          notes: notes || undefined,
          ...(customerId ? { customer_id: customerId } : {}),
        }),
      });
    },
    onSuccess: () => {
      toast.success('Piano pagamento creato');
      onCreated();
      handleOpenChange(false);
    },
    onError: (err: any) => {
      toast.error(err.message || 'Errore durante la creazione');
    },
  });

  const canSubmit =
    title.trim() !== '' &&
    amount.trim() !== '' &&
    !isNaN(parseFloat(amount)) &&
    ocrState !== 'extracting' &&
    !createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo piano di pagamento</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* --- OCR Section --- */}
          <div className="rounded-lg border bg-muted/30">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors rounded-lg"
              onClick={() => setOcrExpanded((v) => !v)}
            >
              <span className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Importa da PDF / immagine (OCR)
              </span>
              {ocrExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>

            {ocrExpanded && (
              <div className="px-4 pb-4">
                <div
                  className={cn(
                    'relative flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors cursor-pointer',
                    isDragOver && 'border-primary bg-primary/5',
                    ocrState === 'idle' && !isDragOver && 'border-muted-foreground/25 hover:border-primary/50',
                    ocrState === 'extracting' && 'border-primary/40 bg-primary/5',
                    ocrState === 'done' && 'border-green-500/40 bg-green-500/5',
                    ocrState === 'error' && 'border-destructive/40 bg-destructive/5',
                  )}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={() => ocrState !== 'extracting' && fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.png,.jpg,.jpeg,.webp"
                    onChange={handleFileSelect}
                  />

                  {ocrState === 'idle' && (
                    <>
                      <Upload className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm text-muted-foreground">
                        Trascina un PDF fattura per estrarre i dati automaticamente
                      </p>
                      <p className="text-xs text-muted-foreground/60">
                        oppure clicca per selezionare un file
                      </p>
                    </>
                  )}

                  {ocrState === 'extracting' && (
                    <>
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <p className="text-sm font-medium text-primary">Analisi in corso...</p>
                    </>
                  )}

                  {ocrState === 'done' && (
                    <>
                      <CheckCircle2 className="h-8 w-8 text-green-500" />
                      <p className="text-sm font-medium text-green-600">
                        Dati estratti! Verifica e conferma.
                      </p>
                    </>
                  )}

                  {ocrState === 'error' && (
                    <>
                      <AlertCircle className="h-8 w-8 text-destructive" />
                      <p className="text-sm font-medium text-destructive">
                        Errore nell'estrazione. Riprova o compila manualmente.
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* --- Form fields --- */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sched-title">
                Titolo <span className="text-destructive">*</span>
              </Label>
              <Input
                id="sched-title"
                placeholder="Es. Acconto sito web, Rata 1/3..."
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sched-amount">
                  Importo &euro; <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="sched-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sched-type">Tipo</Label>
                <Select value={scheduleType} onValueChange={setScheduleType}>
                  <SelectTrigger id="sched-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deposit">Acconto</SelectItem>
                    <SelectItem value="milestone">Milestone</SelectItem>
                    <SelectItem value="balance">Saldo</SelectItem>
                    <SelectItem value="installment">Rata</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sched-due">Scadenza</Label>
              <Input
                id="sched-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>

            {customerName && (
              <div className="space-y-2">
                <Label>Cliente</Label>
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <span className="truncate">{customerName}</span>
                  {customerId && (
                    <span className="ml-auto shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                      trovato
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="sched-notes">Note</Label>
              <Textarea
                id="sched-notes"
                rows={3}
                placeholder="Note aggiuntive (opzionale)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Annulla
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creazione...
              </>
            ) : (
              'Crea'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
