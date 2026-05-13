'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface SignableDoc {
  id: string;
  type: 'nda' | 'contract' | 'sow' | 'other';
  title: string;
  content_md: string;
  signer_name: string | null;
  signer_email: string | null;
  signer_phone: string | null;
  signature_method: 'email_otp' | 'sms_otp';
  status: 'draft' | 'sent' | 'viewed' | 'signed' | 'expired' | 'cancelled';
  signed_at: string | null;
  signature_image: string | null;
  expires_at: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  nda: 'Accordo di Riservatezza',
  contract: 'Contratto',
  sow: 'Statement of Work',
  other: 'Documento',
};

/**
 * Minimal markdown → JSX renderer (no dependency).
 * Supporta: headings #/##/###, paragrafi, **bold**, *italic*, horizontal rule ---.
 */
function renderMarkdown(md: string): React.ReactNode {
  const blocks = md.split(/\n\n+/);
  return blocks.map((block, i) => {
    const trimmed = block.trim();
    if (!trimmed) return null;
    if (trimmed === '---') return <hr key={i} className="my-6 border-t" style={{ borderColor: 'var(--color-line)' }} />;
    if (trimmed.startsWith('### ')) {
      return <h3 key={i} className="text-base font-semibold mt-6 mb-2">{renderInline(trimmed.slice(4))}</h3>;
    }
    if (trimmed.startsWith('## ')) {
      return <h2 key={i} className="text-lg font-semibold mt-8 mb-3">{renderInline(trimmed.slice(3))}</h2>;
    }
    if (trimmed.startsWith('# ')) {
      return <h1 key={i} className="text-2xl font-bold mt-8 mb-4">{renderInline(trimmed.slice(2))}</h1>;
    }
    return (
      <p key={i} className="text-sm leading-relaxed mb-3" style={{ color: 'var(--color-ink)' }}>
        {renderInline(trimmed)}
      </p>
    );
  });
}

function renderInline(text: string): React.ReactNode {
  // Bold then italic. Iterate via simple regex split.
  const boldParts = text.split(/(\*\*[^*]+\*\*)/g);
  return boldParts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    }
    // Inline italic
    const italicParts = p.split(/(\*[^*]+\*)/g);
    return italicParts.map((q, j) => {
      if (q.startsWith('*') && q.endsWith('*') && q.length > 2) {
        return <em key={`${i}-${j}`}>{q.slice(1, -1)}</em>;
      }
      return <span key={`${i}-${j}`}>{q}</span>;
    });
  });
}

type Step = 'review' | 'otp_sent' | 'sign' | 'done';

export function SignatureFlow({ token }: { token: string }) {
  const [doc, setDoc] = useState<SignableDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('review');
  const [otp, setOtp] = useState('');
  const [signerName, setSignerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [otpRequesting, setOtpRequesting] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasStrokesRef = useRef(false);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/sign/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Errore ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const d = data.document as SignableDoc;
        setDoc(d);
        setSignerName(d.signer_name || '');
        if (d.status === 'signed') setStep('done');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Errore caricamento');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  // Canvas drawing setup
  useEffect(() => {
    if (step !== 'sign') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';

    const getPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      drawingRef.current = true;
      hasStrokesRef.current = true;
      const { x, y } = getPos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      const { x, y } = getPos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    };
    const onUp = (e: PointerEvent) => {
      drawingRef.current = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [step]);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasStrokesRef.current = false;
  };

  const requestOtp = async () => {
    if (!doc) return;
    setOtpRequesting(true);
    try {
      const res = await fetch(`${API_BASE}/api/sign/${token}/request-otp`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Errore invio OTP');
      setStep('sign');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore invio OTP');
    } finally {
      setOtpRequesting(false);
    }
  };

  const submitSignature = async () => {
    if (!doc) return;
    const canvas = canvasRef.current;
    if (!canvas || !hasStrokesRef.current) {
      setError('Disegna la firma prima di confermare');
      return;
    }
    if (!otp.trim()) {
      setError('Inserisci il codice OTP ricevuto');
      return;
    }
    if (!signerName.trim()) {
      setError('Inserisci il tuo nome');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const signature_image = canvas.toDataURL('image/png');
      const res = await fetch(`${API_BASE}/api/sign/${token}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otp: otp.trim(),
          signature_image,
          signer_name: signerName.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Errore firma');
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore firma');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>Caricamento documento...</p>;
  }

  if (error && !doc) {
    return (
      <div className="rounded-lg border p-6" style={{ borderColor: 'var(--color-line)' }}>
        <div className="flex items-start gap-3">
          <WarningCircle size={24} weight="fill" className="text-red-500 shrink-0" />
          <div>
            <p className="font-semibold mb-1">Documento non disponibile</p>
            <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!doc) return null;

  return (
    <div className="space-y-8">
      <div>
        <p
          className="font-mono text-[10px] uppercase tracking-[0.25em] mb-2"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {TYPE_LABEL[doc.type] || 'Documento'}
        </p>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{doc.title}</h1>
        <p className="text-xs mt-2" style={{ color: 'var(--color-ink-muted)' }}>
          Firma elettronica avanzata · OTP via {doc.signature_method === 'sms_otp' ? 'SMS' : 'email'}
        </p>
      </div>

      {step === 'done' || doc.status === 'signed' ? (
        <div
          className="rounded-lg border p-6"
          style={{ borderColor: 'var(--color-line)', background: 'var(--color-bg-elev)' }}
        >
          <div className="flex items-start gap-3">
            <CheckCircle size={28} weight="fill" className="text-emerald-500 shrink-0" />
            <div>
              <p className="font-semibold mb-1">Documento firmato</p>
              <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
                {doc.signed_at
                  ? `Firmato il ${new Date(doc.signed_at).toLocaleString('it-IT', {
                      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}`
                  : 'Firma completata con successo.'}
              </p>
              <p className="text-xs mt-3" style={{ color: 'var(--color-ink-muted)' }}>
                Puoi chiudere questa pagina. Una copia del documento firmato è registrata nel
                sistema con audit immutabile.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Document content */}
          <article
            className="rounded-lg border p-6 md:p-8 max-h-[500px] overflow-y-auto"
            style={{ borderColor: 'var(--color-line)', background: 'var(--color-bg-elev)' }}
          >
            {renderMarkdown(doc.content_md)}
          </article>

          {/* Action panel */}
          {step === 'review' && (
            <div
              className="rounded-lg border p-6 space-y-4"
              style={{ borderColor: 'var(--color-line)' }}
            >
              <div>
                <p className="font-semibold mb-1">Pronto a firmare?</p>
                <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
                  Riceverai un codice OTP via {doc.signature_method === 'sms_otp' ? 'SMS al numero' : 'email'}
                  {doc.signature_method === 'sms_otp' && doc.signer_phone && (
                    <> <strong>{doc.signer_phone}</strong></>
                  )}
                  {doc.signature_method === 'email_otp' && doc.signer_email && (
                    <> <strong>{doc.signer_email}</strong></>
                  )}
                  . Il codice è valido per 10 minuti.
                </p>
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="button"
                onClick={requestOtp}
                disabled={otpRequesting}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium border-b transition-[gap] hover:gap-3 min-h-[44px]"
                style={{ borderColor: 'var(--color-ink)', color: 'var(--color-ink)' }}
              >
                {otpRequesting ? 'Invio in corso...' : 'Richiedi codice OTP'}
              </button>
            </div>
          )}

          {step === 'sign' && (
            <div
              className="rounded-lg border p-6 space-y-5"
              style={{ borderColor: 'var(--color-line)' }}
            >
              <div>
                <p className="font-semibold mb-1">Firma il documento</p>
                <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
                  Inserisci il codice OTP ricevuto, il tuo nome completo e disegna la firma nel riquadro.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider">Codice OTP</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full px-3 py-2 border bg-transparent text-base tabular-nums tracking-[0.5em] text-center"
                  style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider">Nome completo</label>
                <input
                  type="text"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  className="w-full px-3 py-2 border bg-transparent text-base"
                  style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium uppercase tracking-wider">Firma</label>
                  <button
                    type="button"
                    onClick={clearCanvas}
                    className="text-[10px] uppercase tracking-wider hover:underline"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    Cancella
                  </button>
                </div>
                <canvas
                  ref={canvasRef}
                  width={800}
                  height={240}
                  className="w-full border bg-white touch-none cursor-crosshair"
                  style={{ borderColor: 'var(--color-line)', aspectRatio: '800/240' }}
                />
                <p className="text-[10px]" style={{ color: 'var(--color-ink-muted)' }}>
                  Disegna la tua firma usando il mouse, il trackpad o il dito.
                </p>
              </div>

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button
                type="button"
                onClick={submitSignature}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium border-b transition-[gap] hover:gap-3 min-h-[44px]"
                style={{ borderColor: 'var(--color-ink)', color: 'var(--color-ink)' }}
              >
                {submitting ? 'Firma in corso...' : 'Conferma e firma'}
              </button>
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-center" style={{ color: 'var(--color-ink-muted)' }}>
        Firma elettronica avanzata (FEA) conforme al Codice dell'Amministrazione Digitale.
        IP e timestamp registrati per audit.
      </p>
    </div>
  );
}
