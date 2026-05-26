'use client';

import { useState, useTransition } from 'react';
import { LEGAL_CONTENT } from '@/data/legal-content';
import { LegalDocumentReadable } from './LegalDocumentReadable';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/+$/, '');

interface LegalAcceptanceFormProps {
  customerEmail: string | null;
}

/**
 * Form di accettazione T&C + DPA per la pagina /clienti/accettazione-legale.
 *
 * - Due card collapsible: T&C aperta di default, DPA chiusa.
 * - Ogni card abilita il proprio checkbox solo dopo scroll-to-bottom
 *   (LegalDocumentReadable + useScrollToBottom).
 * - Submit POST /api/portal/legal/accept con `credentials: include`; lato
 *   server salva timestamp + IP + user-agent come prova art. 7 GDPR.
 * - On success: full reload via window.location.replace per evitare cache
 *   RSC stale (la prossima visita dovra` fetchare nuovo /legal/status che
 *   restituira` requires_acceptance: false).
 */
export function LegalAcceptanceForm({ customerEmail }: LegalAcceptanceFormProps) {
  const [tcAccepted, setTcAccepted] = useState(false);
  const [dpaAccepted, setDpaAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canSubmit = tcAccepted && dpaAccepted && !pending;

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/portal/legal/accept`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documents: ['termini-e-condizioni', 'dpa-clienti'],
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        // Full reload per evitare stale RSC cache; il prossimo render
        // di /clienti/dashboard verifichera` di nuovo lo status legale.
        window.location.replace('/clienti/dashboard');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Errore durante l’invio. Riprova.');
      }
    });
  };

  const tc = LEGAL_CONTENT['termini-e-condizioni'];
  const dpa = LEGAL_CONTENT['dpa-clienti'];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <p
          className="font-mono text-[10px] uppercase tracking-[0.24em]"
          style={{ color: 'var(--color-accent-deep)' }}
        >
          Prima di entrare
        </p>
        <h1
          className="font-[family-name:var(--font-display)] text-3xl md:text-4xl"
          style={{ letterSpacing: '-0.035em', lineHeight: 1.02, color: 'var(--color-ink)' }}
        >
          Accetta i documenti contrattuali.
        </h1>
        <p
          className="max-w-[60ch] text-sm md:text-base leading-relaxed"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Per l’accesso all’area clienti devi prendere visione e accettare i Termini e
          Condizioni e il Data Processing Agreement (art. 28 GDPR). Apri ogni documento,
          scorri fino in fondo e flagga “Ho letto e accetto”. Conservo timestamp, IP e
          user-agent dell’accettazione come prova del consenso ai sensi dell’art. 7 GDPR.
        </p>
        <p
          className="font-mono text-[11px] uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          Account: {customerEmail || 'accesso via codice'}
        </p>
      </header>

      <LegalDocumentReadable
        document={tc}
        checked={tcAccepted}
        onCheckedChange={setTcAccepted}
        defaultOpen
      />

      <LegalDocumentReadable
        document={dpa}
        checked={dpaAccepted}
        onCheckedChange={setDpaAccepted}
      />

      {error && (
        <div
          role="alert"
          className="border p-4 text-sm"
          style={{ borderColor: 'rgba(220,38,38,0.4)', color: '#b91c1c', background: 'rgba(220,38,38,0.04)' }}
        >
          {error}
        </div>
      )}

      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <a
          href="/clienti/logout"
          className="text-xs font-medium uppercase tracking-[0.18em] underline underline-offset-4 hover:opacity-70"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Esci senza accettare
        </a>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="min-h-[48px] border px-8 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-all disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: canSubmit ? 'var(--color-ink)' : 'transparent',
            color: canSubmit ? 'var(--color-bg)' : 'var(--color-text-secondary)',
            borderColor: 'var(--color-ink)',
          }}
        >
          {pending ? 'Invio in corso…' : 'Accetto e procedi'}
        </button>
      </div>
    </div>
  );
}
