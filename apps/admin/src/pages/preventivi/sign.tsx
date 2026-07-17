import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileText, Loader2, Send, PenTool } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { API_BASE } from '@/lib/api';

interface VessatoriaClause {
  numero: number;
  titolo: string;
  testo: string;
}

interface PagamentoOption {
  nome: string;
  importo: number | null;
  sconto_percentuale: number | null;
  rate: Array<{ percentuale: number; momento: string }>;
}

export default function QuoteSignPage() {
  const { token } = useParams();
  const [quote, setQuote] = useState<any>(null);
  const [pagamento, setPagamento] = useState<PagamentoOption[]>([]);
  const [vessatorie, setVessatorie] = useState<VessatoriaClause[]>([]);
  const [vessatorieApproved, setVessatorieApproved] = useState(false);
  const [expandedClause, setExpandedClause] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'view' | 'otp_sent' | 'sign' | 'done'>('view');
  const [otpInput, setOtpInput] = useState('');
  const [emailHint, setEmailHint] = useState('');
  const [signerName, setSignerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  // Fetch quote
  useEffect(() => {
    fetch(`${API_BASE}/api/quote-sign/${token}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else {
          setQuote(data.quote);
          setPagamento(Array.isArray(data.pagamento) ? data.pagamento : []);
          setVessatorie(Array.isArray(data.vessatorie) ? data.vessatorie : []);
        }
      })
      .catch(() => setError('Errore nel caricamento'))
      .finally(() => setLoading(false));
  }, [token]);

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1a1a';
  }, [step]);

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    setIsDrawing(true);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    setHasSignature(true);
  };

  const stopDraw = () => setIsDrawing(false);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  // Request OTP
  const requestOTP = async () => {
    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/quote-sign/${token}/otp`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setEmailHint(data.email_hint);
      setStep('otp_sent');
    } catch { setError('Errore invio OTP'); }
    finally { setIsSubmitting(false); }
  };

  // Verify OTP and show sign canvas
  const verifyAndSign = () => {
    if (otpInput.length !== 6) return;
    setStep('sign');
  };

  // Submit signature
  const submitSignature = async () => {
    if (!hasSignature || !otpInput) return;
    if (vessatorie.length && !vessatorieApproved) return;
    setIsSubmitting(true);
    const signatureImage = canvasRef.current?.toDataURL('image/png') || '';

    try {
      const res = await fetch(`${API_BASE}/api/quote-sign/${token}/sign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otp: otpInput,
          signature_image: signatureImage,
          signer_name: signerName,
          vessatorie_approved: vessatorie.length ? vessatorieApproved : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); setIsSubmitting(false); return; }
      setStep('done');
    } catch { setError('Errore durante la firma'); }
    finally { setIsSubmitting(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
      </div>
    );
  }

  if (error && !quote) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-lg font-medium text-gray-900">Preventivo non trovato</p>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md mx-auto px-4">
          <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Preventivo firmato!</h1>
          <p className="text-gray-600">Grazie per aver firmato il preventivo. Riceverai una conferma via email.</p>
        </div>
      </div>
    );
  }

  // items can arrive double-encoded from legacy rows (jsonb holding a JSON
  // string) — never call .map on a non-array or the whole page error-boundaries.
  const rawItems = typeof quote?.items === 'string'
    ? (() => { try { return JSON.parse(quote.items); } catch { return []; } })()
    : quote?.items;
  const items = Array.isArray(rawItems) ? rawItems : [];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-orange-500 flex items-center justify-center text-white font-bold text-sm">C</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Calicchia Design</p>
            <p className="text-xs text-gray-500">Preventivo</p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Quote details */}
        <div className="bg-white rounded-xl border p-6 mb-6">
          <h1 className="text-xl font-bold text-gray-900">{quote.title}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Per: {quote.customer_name || '—'}{quote.company_name ? ` · ${quote.company_name}` : ''}
          </p>

          {/* Items */}
          {items.length > 0 && (
            <div className="mt-6 border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                  <th className="px-4 py-2">Descrizione</th>
                  <th className="px-4 py-2 text-right">Importo</th>
                </tr></thead>
                <tbody>
                  {items.map((item: any, i: number) => (
                    <tr key={i} className="border-t">
                      <td className="px-4 py-3">{item.description}</td>
                      <td className="px-4 py-3 text-right font-medium">€{parseFloat(item.total || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-gray-50 font-semibold">
                    <td className="px-4 py-3">Totale</td>
                    <td className="px-4 py-3 text-right text-orange-600">€{parseFloat(quote.total || 0).toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Custom-HTML quotes: the items table above is just a stub — the
              real contract lives in the imported document. Embed it so the
              customer reads what they sign; new-tab link as fallback. */}
          {quote.has_document && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase font-medium">Documento completo</p>
                <a
                  href={`${API_BASE}/api/quote-sign/${token}/document`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-600 hover:text-orange-700"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Apri a schermo intero
                </a>
              </div>
              <iframe
                src={`${API_BASE}/api/quote-sign/${token}/document`}
                title="Documento preventivo completo"
                className="w-full rounded-lg border bg-white"
                style={{ height: '75vh' }}
              />
            </div>
          )}

          {/* Payment options — the customer must see "anticipato €549" etc.
              BEFORE signing, not only inside the document/PDF. */}
          {pagamento.length > 0 && (
            <div className="mt-4 border rounded-lg p-4">
              <p className="text-xs text-gray-500 uppercase font-medium mb-2">Modalità di pagamento</p>
              <ul className="space-y-2">
                {pagamento.map((p, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-gray-700">
                      {p.nome}
                      {p.rate.length > 0 && (
                        <span className="text-gray-400 text-xs block">
                          {p.rate.map((r) => `${r.percentuale}% ${r.momento}`).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      {p.importo != null && (
                        <span className="font-semibold text-gray-900">€{p.importo.toLocaleString('it-IT')}</span>
                      )}
                      {p.sconto_percentuale != null && (
                        <span className="ml-2 text-xs text-green-600 font-medium">-{p.sconto_percentuale}%</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {quote.notes && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">{quote.notes}</div>
          )}

          {quote.valid_until && (
            <p className="mt-3 text-xs text-gray-400">Valido fino al {new Date(quote.valid_until).toLocaleDateString('it-IT')}</p>
          )}
        </div>

        {/* Already signed */}
        {quote.status === 'signed' ? (
          <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
            <p className="font-semibold text-green-800">Questo preventivo è già stato firmato</p>
            <p className="text-sm text-green-600 mt-1">Firmato da {quote.signer_name} il {new Date(quote.signed_at).toLocaleDateString('it-IT')}</p>
          </div>
        ) : (
          <>
            {/* Step: View → Request OTP */}
            {step === 'view' && (
              <div className="bg-white rounded-xl border p-6 text-center">
                <PenTool className="h-8 w-8 text-orange-500 mx-auto mb-3" />
                <h2 className="text-lg font-semibold mb-1">Firma questo preventivo</h2>
                <p className="text-sm text-gray-500 mb-4">Ti invieremo un codice di verifica via email per confermare la tua identità.</p>
                <Button onClick={requestOTP} disabled={isSubmitting} className="bg-orange-500 hover:bg-orange-600">
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                  Invia codice di verifica
                </Button>
                {error && <p className="text-sm text-red-500 mt-3">{error}</p>}
              </div>
            )}

            {/* Step: OTP sent → Enter code */}
            {step === 'otp_sent' && (
              <div className="bg-white rounded-xl border p-6">
                <h2 className="text-lg font-semibold mb-1">Inserisci il codice</h2>
                <p className="text-sm text-gray-500 mb-4">Abbiamo inviato un codice a 6 cifre a <strong>{emailHint}</strong></p>
                <div className="max-w-xs mx-auto space-y-3">
                  <Input
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="text-center text-2xl tracking-[0.5em] h-12 font-mono"
                    maxLength={6}
                    autoFocus
                  />
                  <Button onClick={verifyAndSign} disabled={otpInput.length !== 6} className="w-full bg-orange-500 hover:bg-orange-600">
                    Verifica e procedi alla firma
                  </Button>
                  {error && <p className="text-sm text-red-500">{error}</p>}
                </div>
              </div>
            )}

            {/* Step: Sign → Canvas */}
            {step === 'sign' && (
              <div className="bg-white rounded-xl border p-6 space-y-4">
                <h2 className="text-lg font-semibold">Firma qui sotto</h2>
                <div className="space-y-2">
                  <Label className="text-sm">Il tuo nome</Label>
                  <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} placeholder="Nome e cognome" />
                </div>
                <div>
                  <Label className="text-sm">Firma</Label>
                  <div className="mt-1 border-2 border-dashed border-gray-300 rounded-lg bg-white relative" style={{ height: '160px' }}>
                    <canvas
                      ref={canvasRef}
                      className="w-full h-full cursor-crosshair touch-none"
                      onMouseDown={startDraw}
                      onMouseMove={draw}
                      onMouseUp={stopDraw}
                      onMouseLeave={stopDraw}
                      onTouchStart={startDraw}
                      onTouchMove={draw}
                      onTouchEnd={stopDraw}
                    />
                    {!hasSignature && (
                      <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-300 pointer-events-none">
                        Firma qui con il mouse o il dito
                      </p>
                    )}
                  </div>
                  <button onClick={clearCanvas} className="text-xs text-gray-400 hover:text-gray-600 mt-1">Cancella firma</button>
                </div>

                {/* Artt. 1341-1342 c.c. — specific approval of vessatorie clauses */}
                {vessatorie.length > 0 && (
                  <div className="border border-orange-200 bg-orange-50/50 rounded-lg p-4 space-y-3">
                    <p className="text-sm font-semibold text-gray-900">Clausole che richiedono approvazione specifica</p>
                    <p className="text-xs text-gray-500">
                      Ai sensi degli artt. 1341 e 1342 del Codice Civile, le seguenti clausole richiedono
                      la tua approvazione esplicita e distinta dalla firma del preventivo.
                    </p>
                    <ul className="space-y-1">
                      {vessatorie.map((clause) => (
                        <li key={clause.numero} className="text-sm">
                          <button
                            type="button"
                            className="text-left w-full hover:bg-orange-100/60 rounded px-2 py-1 transition-colors"
                            onClick={() => setExpandedClause(expandedClause === clause.numero ? null : clause.numero)}
                          >
                            <span className="font-medium text-gray-800">Art. {clause.numero} — {clause.titolo}</span>
                            <span className="text-gray-400 text-xs ml-1">{expandedClause === clause.numero ? '▲' : '▼'}</span>
                          </button>
                          {expandedClause === clause.numero && (
                            <p className="text-xs text-gray-600 px-2 pb-1 pt-0.5">{clause.testo}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-start gap-2 cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-orange-500"
                        checked={vessatorieApproved}
                        onChange={(e) => setVessatorieApproved(e.target.checked)}
                      />
                      <span className="text-sm text-gray-700">
                        Dichiaro di aver letto e compreso le clausole sopra elencate e le
                        <strong> approvo specificamente</strong> ai sensi degli artt. 1341-1342 c.c.
                      </span>
                    </label>
                  </div>
                )}

                <Button
                  onClick={submitSignature}
                  disabled={!hasSignature || isSubmitting || (vessatorie.length > 0 && !vessatorieApproved)}
                  className="w-full bg-orange-500 hover:bg-orange-600"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <PenTool className="h-4 w-4 mr-2" />}
                  Conferma e firma
                </Button>
                {error && <p className="text-sm text-red-500">{error}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
