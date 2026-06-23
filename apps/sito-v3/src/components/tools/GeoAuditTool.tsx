'use client';

import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { Field, FieldLabel, FieldError, Input } from '@/components/ui/form';
import { GdprCheckbox } from '@/components/forms/GdprCheckbox';
import { useCaptcha } from '@/hooks/useCaptcha';
import { reportEvent } from '@/instrumentation-client';
import type { Locale } from '@/lib/i18n';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const WHITEPAPER_PATH = '/risorse/dalla-seo-alla-geo';

interface Finding {
  id: string;
  label: string;
  passed: boolean | null;
}
interface ScanData {
  auditId: string;
  url: string;
  score: number;
  totalChecks: number;
  passedChecks: number;
  topFindings: Finding[];
}
interface Check {
  id: string;
  label: string;
  passed: boolean | null;
  weight: number;
  detail: string;
  anchor: string;
}
interface AdminAction {
  title: string;
  priority: string;
  why: string;
  how: string;
}
interface ReportData {
  url: string;
  score: number;
  checks: Check[];
  aiActions: { userSummary: string; adminActions: AdminAction[] };
}

type Phase = 'input' | 'teaser' | 'report';

interface Strings {
  urlLabel: string; urlPlaceholder: string; analyze: string; analyzing: string;
  scoreLabel: string; teaserTitle: string; teaserBody: string; emailLabel: string;
  nameLabel: string; intentLabel: string; intentHelp: string; intentDiy: string;
  unlock: string; unlocking: string; reportTitle: string; summaryTitle: string;
  actionsTitle: string; howFix: string; ctaHelpTitle: string; ctaHelpBody: string;
  ctaHelpBtn: string; ctaDiyTitle: string; ctaDiyBody: string; ctaDiyBtn: string;
  pass: string; fail: string; info: string; errGeneric: string;
}

const T: Record<Locale, Strings> = {
  it: {
    urlLabel: 'URL del sito da analizzare',
    urlPlaceholder: 'iltuosito.it',
    analyze: 'Analizza',
    analyzing: 'Analisi in corso…',
    scoreLabel: 'Readiness GEO',
    teaserTitle: 'Ecco l’anteprima del tuo score',
    teaserBody: 'Lascia la tua email per sbloccare il report completo: criteri tecnici, dettagli e piano di azioni. Lo score non promette citazioni: misura quanto il sito è leggibile e citabile.',
    emailLabel: 'La tua email',
    nameLabel: 'Nome (facoltativo)',
    intentLabel: 'Come vuoi procedere?',
    intentHelp: 'Voglio che ti occupi tu della GEO del mio sito',
    intentDiy: 'Voglio risolvere da solo (mandami solo il report)',
    unlock: 'Sblocca il report completo',
    unlocking: 'Generazione report…',
    reportTitle: 'Report GEO completo',
    summaryTitle: 'In sintesi',
    actionsTitle: 'Azioni consigliate',
    howFix: 'Come si risolve →',
    ctaHelpTitle: 'Vuoi che me ne occupi io?',
    ctaHelpBody: 'Sei già nella mia lista: ti ricontatto a breve con un piano concreto. Se vuoi anticipare i tempi:',
    ctaHelpBtn: 'Contattami',
    ctaDiyTitle: 'Preferisci fare da solo?',
    ctaDiyBody: 'Tutto ciò che serve è nel white paper: ogni criterio rimanda alla sezione che spiega come intervenire senza inseguire scorciatoie tipo llms.txt come fattore magico.',
    ctaDiyBtn: 'Apri il white paper →',
    pass: 'OK',
    fail: 'Da migliorare',
    info: 'Info',
    errGeneric: 'Qualcosa è andato storto. Riprova.',
  },
  en: {
    urlLabel: 'URL of the site to analyze',
    urlPlaceholder: 'yoursite.com',
    analyze: 'Analyze',
    analyzing: 'Analyzing…',
    scoreLabel: 'GEO readiness',
    teaserTitle: 'Here’s a preview of your score',
    teaserBody: 'Leave your email to unlock the full report: technical criteria, details and an action plan. The score does not promise citations: it measures how readable and citable the site is.',
    emailLabel: 'Your email',
    nameLabel: 'Name (optional)',
    intentLabel: 'How do you want to proceed?',
    intentHelp: 'I want you to handle my site’s GEO',
    intentDiy: 'I want to fix it myself (just send the report)',
    unlock: 'Unlock the full report',
    unlocking: 'Generating report…',
    reportTitle: 'Full GEO report',
    summaryTitle: 'Summary',
    actionsTitle: 'Recommended actions',
    howFix: 'How to fix →',
    ctaHelpTitle: 'Want me to handle it?',
    ctaHelpBody: 'You’re already on my list: I’ll get back to you shortly with a concrete plan. To move faster:',
    ctaHelpBtn: 'Contact me',
    ctaDiyTitle: 'Prefer to do it yourself?',
    ctaDiyBody: 'Everything you need is in the white paper: each criterion links to the section explaining how to act without chasing shortcuts like llms.txt as a magic factor.',
    ctaDiyBtn: 'Open the white paper →',
    pass: 'OK',
    fail: 'Needs work',
    info: 'Info',
    errGeneric: 'Something went wrong. Please try again.',
  },
};

function scoreColor(score: number): string {
  if (score >= 75) return '#1a8a4a';
  if (score >= 50) return '#b8860b';
  return '#b3261e';
}

export function GeoAuditTool({ locale }: { locale: Locale }) {
  const t = T[locale];
  const [phase, setPhase] = useState<Phase>('input');
  const [url, setUrl] = useState('');
  const [scan, setScan] = useState<ScanData | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [intent, setIntent] = useState<'help' | 'diy'>('help');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Anti-bot on lead creation (unlock). Reuses the public contact-form key.
  const captcha = useCaptcha('contact_form');

  async function runScan(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!url.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/geo-audit/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), locale }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t.errGeneric);
        return;
      }
      setScan(data);
      setPhase('teaser');
      reportEvent('geo_audit.scan', { url: data.url, score: data.score });
    } catch {
      setError(t.errGeneric);
    } finally {
      setLoading(false);
    }
  }

  async function runUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!scan) return;
    if (!consent) {
      setError(locale === 'it' ? 'Consenso GDPR richiesto.' : 'GDPR consent required.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/geo-audit/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audit_id: scan.auditId,
          email: email.trim(),
          name: name.trim() || undefined,
          gdpr_consent: true,
          wants_intervention: intent === 'help',
          turnstile_token: captcha.token ?? '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t.errGeneric);
        captcha.reset();
        return;
      }
      setReport(data);
      setPhase('report');
      reportEvent('geo_audit.unlock', { score: data.score, wants_intervention: intent === 'help' });
    } catch {
      setError(t.errGeneric);
      captcha.reset();
    } finally {
      setLoading(false);
    }
  }

  // ── Phase: input ────────────────────────────────────────────────────────────
  if (phase === 'input') {
    return (
      <form onSubmit={runScan} className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="geo-url">{t.urlLabel}</FieldLabel>
          <Input
            id="geo-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder={t.urlPlaceholder}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div>
          <Button type="submit" variant="solid" disabled={loading}>
            {loading ? t.analyzing : t.analyze}
          </Button>
        </div>
      </form>
    );
  }

  // ── Phase: teaser (score + email gate) ───────────────────────────────────────
  if (phase === 'teaser' && scan) {
    return (
      <div className="flex flex-col gap-10">
        <ScoreRing score={scan.score} label={t.scoreLabel} sub={`${scan.passedChecks}/${scan.totalChecks}`} />

        <div>
          <h2 className="text-xl font-medium mb-2">{t.teaserTitle}</h2>
          <ul className="flex flex-col gap-2 my-4">
            {scan.topFindings.map((f) => (
              <li key={f.id} className="flex items-center gap-3 text-sm">
                <Badge passed={f.passed} t={t} />
                <span>{f.label}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {t.teaserBody}
          </p>
        </div>

        <form onSubmit={runUnlock} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="geo-email">{t.emailLabel}</FieldLabel>
            <Input
              id="geo-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="geo-name">{t.nameLabel}</FieldLabel>
            <Input id="geo-name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              {t.intentLabel}
            </legend>
            <label className="flex items-center gap-3 text-sm cursor-pointer">
              <input type="radio" name="geo-intent" checked={intent === 'help'} onChange={() => setIntent('help')} style={{ accentColor: 'var(--color-accent)' }} />
              {t.intentHelp}
            </label>
            <label className="flex items-center gap-3 text-sm cursor-pointer">
              <input type="radio" name="geo-intent" checked={intent === 'diy'} onChange={() => setIntent('diy')} style={{ accentColor: 'var(--color-accent)' }} />
              {t.intentDiy}
            </label>
          </fieldset>

          <GdprCheckbox checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <div ref={captcha.containerRef} style={{ minWidth: 300 }} />
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button type="submit" variant="solid" disabled={loading}>
              {loading ? t.unlocking : t.unlock}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  // ── Phase: report ────────────────────────────────────────────────────────────
  if (phase === 'report' && report) {
    return (
      <div className="flex flex-col gap-12">
        <ScoreRing score={report.score} label={t.scoreLabel} />

        <section>
          <h2 className="text-xl font-medium mb-3">{t.summaryTitle}</h2>
          <p className="text-base leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {report.aiActions.userSummary}
          </p>
        </section>

        <section>
          <h2 className="text-xl font-medium mb-4">{t.reportTitle}</h2>
          <ul className="flex flex-col">
            {report.checks.map((ck, i) => (
              <li
                key={ck.id}
                className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-4"
                style={{ borderTop: i === 0 ? '1px solid var(--color-line)' : undefined, borderBottom: '1px solid var(--color-line)' }}
              >
                <Badge passed={ck.passed} t={t} />
                <div>
                  <p className="font-medium">{ck.label}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                    {ck.detail}
                  </p>
                  {ck.passed === false ? (
                    <Link
                      href={`${WHITEPAPER_PATH}#${ck.anchor}`}
                      className="inline-block mt-2 text-sm underline"
                      style={{ color: 'var(--color-accent-deep)' }}
                    >
                      {t.howFix}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {report.aiActions.adminActions.length ? (
          <section>
            <h2 className="text-xl font-medium mb-4">{t.actionsTitle}</h2>
            <ol className="flex flex-col gap-5">
              {report.aiActions.adminActions.map((a, i) => (
                <li key={i}>
                  <p className="font-medium">
                    <span style={{ color: 'var(--color-accent-deep)', fontFamily: 'var(--font-mono)', fontSize: 12, marginRight: 8 }}>
                      {a.priority.toUpperCase()}
                    </span>
                    {a.title}
                  </p>
                  <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>{a.why}</p>
                  <p className="text-sm mt-1">{a.how}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {/* Closing CTA — adapts to the chosen intent */}
        <section
          className="p-6"
          style={{ border: '1px solid var(--color-line)', background: 'var(--color-surface-elevated, transparent)' }}
        >
          {intent === 'help' ? (
            <>
              <h3 className="text-lg font-medium mb-2">{t.ctaHelpTitle}</h3>
              <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>{t.ctaHelpBody}</p>
              <Button href="/contatti" variant="solid">{t.ctaHelpBtn}</Button>
            </>
          ) : (
            <>
              <h3 className="text-lg font-medium mb-2">{t.ctaDiyTitle}</h3>
              <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>{t.ctaDiyBody}</p>
              <Button href={WHITEPAPER_PATH} variant="ghost">{t.ctaDiyBtn}</Button>
            </>
          )}
        </section>
      </div>
    );
  }

  return null;
}

function ScoreRing({ score, label, sub }: { score: number; label: string; sub?: string }) {
  const color = scoreColor(score);
  return (
    <div className="flex items-center gap-6">
      <div
        className="grid place-items-center rounded-full"
        style={{
          width: 120,
          height: 120,
          background: `conic-gradient(${color} ${score * 3.6}deg, var(--color-line) 0deg)`,
        }}
      >
        <div className="grid place-items-center rounded-full" style={{ width: 96, height: 96, background: 'var(--color-surface, #fff)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700, color }}>{score}</span>
        </div>
      </div>
      <div>
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          {label}
        </p>
        {sub ? <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>{sub}</p> : null}
      </div>
    </div>
  );
}

function Badge({ passed, t }: { passed: boolean | null; t: Strings }) {
  const label = passed === null ? t.info : passed ? t.pass : t.fail;
  const color = passed === null ? 'var(--color-text-secondary)' : passed ? '#1a8a4a' : '#b3261e';
  const glyph = passed === null ? 'ⓘ' : passed ? '✓' : '✕';
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap" style={{ color }}>
      <span aria-hidden>{glyph}</span> {label}
    </span>
  );
}
