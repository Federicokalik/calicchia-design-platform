'use client';

import { useState, useTransition } from 'react';
import { Lock, MessageCircle, Mail, Check, AlertCircle } from 'lucide-react';

export interface PublicPreferences {
  id: string;
  whatsapp_transactional: boolean;
  whatsapp_operational: boolean;
  whatsapp_marketing: boolean;
  email_operational: boolean;
  email_marketing: boolean;
  sms_transactional: boolean;
  preferences_token: string;
}

interface Props {
  token: string;
  initial: PublicPreferences;
}

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

type ToggleField =
  | 'whatsapp_operational'
  | 'whatsapp_marketing'
  | 'email_operational'
  | 'email_marketing';

export function PublicPreferencesForm({ token, initial }: Props) {
  const [prefs, setPrefs] = useState<PublicPreferences>(initial);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string>('');
  const [isPending, startTransition] = useTransition();

  function toggle(field: ToggleField) {
    const next = { ...prefs, [field]: !prefs[field] };
    setPrefs(next);
    setStatus('idle');
    startTransition(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/preferences/${encodeURIComponent(token)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: next[field] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data?.preferences) setPrefs(data.preferences);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 2500);
      } catch (err) {
        setStatus('error');
        setError((err as Error).message);
        setPrefs((p) => ({ ...p, [field]: !next[field] }));
      }
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6 space-y-5">
        <header className="flex items-center gap-2.5">
          <MessageCircle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">WhatsApp</h2>
        </header>
        <Row
          label="Essenziali"
          description="Fatture, scadenze, avvisi di sicurezza."
          checked={prefs.whatsapp_transactional}
          readOnly
          icon={<Lock className="h-3.5 w-3.5" />}
        />
        <Row
          label="Operative"
          description="Reminder appuntamenti, follow-up progetti."
          checked={prefs.whatsapp_operational}
          onChange={() => toggle('whatsapp_operational')}
          disabled={isPending}
        />
        <Row
          label="Marketing"
          description="Offerte e contenuti promozionali."
          checked={prefs.whatsapp_marketing}
          onChange={() => toggle('whatsapp_marketing')}
          disabled={isPending}
        />
      </section>

      <section className="rounded-xl border bg-card p-6 space-y-5">
        <header className="flex items-center gap-2.5">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Email</h2>
        </header>
        <Row
          label="Operative"
          description="Aggiornamenti progetti, reminder."
          checked={prefs.email_operational}
          onChange={() => toggle('email_operational')}
          disabled={isPending}
        />
        <Row
          label="Marketing"
          description="Newsletter, offerte."
          checked={prefs.email_marketing}
          onChange={() => toggle('email_marketing')}
          disabled={isPending}
        />
      </section>

      <div className="flex items-center justify-center gap-2 text-xs h-5">
        {status === 'saved' && (
          <span className="flex items-center gap-1 text-emerald-700">
            <Check className="h-3.5 w-3.5" /> Salvato
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1 text-rose-700">
            <AlertCircle className="h-3.5 w-3.5" /> Errore: {error}
          </span>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  icon?: React.ReactNode;
}

function Row({ label, description, checked, onChange, disabled, readOnly, icon }: RowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium">{label}</p>
          {icon}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => !readOnly && !disabled && onChange?.()}
        disabled={disabled || readOnly}
        className={[
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
          (disabled || readOnly) && 'opacity-60 cursor-not-allowed',
        ].filter(Boolean).join(' ')}
      >
        <span
          className={[
            'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          ].join(' ')}
        />
      </button>
    </div>
  );
}
