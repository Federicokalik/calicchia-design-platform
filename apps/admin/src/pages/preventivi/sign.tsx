import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, Send, PenTool } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { API_BASE } from '@/lib/api';

export default function QuoteSignPage() {
  const { token } = useParams();
  const [quote, setQuote] = useState<any>(null);
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
        else setQuote(data.quote);
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
    setIsSubmitting(true);
    const signatureImage = canvasRef.current?.toDataURL('image/png') || '';

    try {
      const res = await fetch(`${API_BASE}/api/quote-sign/${token}/sign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: otpInput, signature_image: signatureImage, signer_name: signerName }),
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

  const items = quote?.items || [];

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
                <Button onClick={submitSignature} disabled={!hasSignature || isSubmitting} className="w-full bg-orange-500 hover:bg-orange-600">
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
