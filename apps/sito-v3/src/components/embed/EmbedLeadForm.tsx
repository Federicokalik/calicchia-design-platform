'use client';

import { useEffect, useRef, useState } from 'react';
import { useTurnstile } from '@/hooks/useTurnstile';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

interface UtmParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

interface Props {
  sourceToken?: string;
  utm: UtmParams;
}

/**
 * Posta l'altezza corrente al parent (per auto-resize dell'iframe).
 * Usato dopo render iniziale e dopo cambio stato (success).
 */
function postHeight() {
  if (typeof window === 'undefined') return;
  const h = document.documentElement.scrollHeight;
  window.parent?.postMessage({ type: 'calicchia:lead-embed:resize', height: h }, '*');
}

export function EmbedLeadForm({ sourceToken, utm }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const { containerRef, token, ready, reset } = useTurnstile(TURNSTILE_SITE_KEY);

  // Resize observer: report height to parent ogni volta che cambia
  useEffect(() => {
    if (typeof window === 'undefined') return;
    postHeight();
    const obs = new ResizeObserver(() => postHeight());
    obs.observe(document.documentElement);
    return () => obs.disconnect();
  }, [success]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim()) {
      setError('Nome ed email sono obbligatori.');
      return;
    }
    if (!token) {
      setError('Attendi la verifica anti-bot e riprova.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/public-leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          company: company.trim() || undefined,
          message: message.trim() || undefined,
          source_token: sourceToken,
          utm_source: utm.utm_source,
          utm_medium: utm.utm_medium,
          utm_campaign: utm.utm_campaign,
          utm_content: utm.utm_content,
          utm_term: utm.utm_term,
          turnstile_token: token,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Errore ${res.status}`);

      setSuccess(true);
      window.parent?.postMessage({ type: 'calicchia:lead-embed:success' }, '*');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore invio');
      reset();
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="max-w-md mx-auto py-12 text-center">
        <p className="text-2xl font-semibold mb-3 text-zinc-900">Grazie!</p>
        <p className="text-sm text-zinc-600">
          Abbiamo ricevuto la tua richiesta. Ti risponderemo entro 24 ore lavorative.
        </p>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="max-w-md mx-auto space-y-4">
      <div className="space-y-1">
        <label htmlFor="name" className="text-xs font-medium uppercase tracking-wider text-zinc-700">
          Nome *
        </label>
        <input
          id="name"
          name="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          className="w-full px-3 py-2 border border-zinc-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="email" className="text-xs font-medium uppercase tracking-wider text-zinc-700">
          Email *
        </label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          maxLength={255}
          className="w-full px-3 py-2 border border-zinc-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="phone" className="text-xs font-medium uppercase tracking-wider text-zinc-700">
            Telefono
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={32}
            className="w-full px-3 py-2 border border-zinc-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="company" className="text-xs font-medium uppercase tracking-wider text-zinc-700">
            Azienda
          </label>
          <input
            id="company"
            name="company"
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={120}
            className="w-full px-3 py-2 border border-zinc-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="message" className="text-xs font-medium uppercase tracking-wider text-zinc-700">
          Messaggio
        </label>
        <textarea
          id="message"
          name="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={2000}
          rows={3}
          className="w-full px-3 py-2 border border-zinc-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </div>

      <div ref={containerRef} />

      {error && <p className="text-xs text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !ready}
        className="w-full px-4 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded hover:bg-zinc-800 disabled:bg-zinc-400 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? 'Invio...' : 'Invia richiesta'}
      </button>

      <p className="text-[10px] text-zinc-500 text-center">
        Inviando il form accetti la nostra Privacy Policy. I dati non saranno condivisi con terzi.
      </p>
    </form>
  );
}
