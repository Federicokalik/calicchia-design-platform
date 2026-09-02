import { type ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';

interface CaseNoteProps {
  /** Testo libero (già risolto i18n dall'API). Paragrafi separati da riga vuota. */
  text: string;
}

// Bare URL o dominio con path — es. `farmacia-querqui.it/prenota`,
// `https://esempio.it`. TLD ≥ 2 char per evitare falsi positivi ("es. ").
const URL_RE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"')\]]*)?)/gi;

function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    const raw = match[0];
    // La punteggiatura di fine frase appartiene alla prosa, non all'URL.
    const clean = raw.replace(/[.,;:!?)]+$/, '');
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const href = clean.startsWith('http') ? clean : `https://${clean}`;
    nodes.push(
      <a
        key={`lnk-${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-4 transition-opacity hover:opacity-70"
        style={{ color: 'var(--color-ink)' }}
      >
        {clean}
      </a>,
    );
    if (raw.length > clean.length) nodes.push(raw.slice(clean.length));
    last = match.index + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Nota editoriale opzionale sul case study (Migration 150) — es. una
 * limitazione da comunicare ("dati reali, niente altri screenshot") con il
 * rimando a cosa resta pubblicamente visitabile.
 *
 * Registro Pentagram come CaseLinks / CaseStaleNotice: hairline border-top,
 * label mono, testo che respira. Rende `null` se il testo è vuoto.
 */
export async function CaseNote({ text }: CaseNoteProps) {
  const t = await getTranslations('lavori.detail');
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return null;

  return (
    <Section
      id="case-note"
      spacing="compact"
      bordered="top"
      style={{ scrollMarginTop: 'calc(var(--availability-banner-height, 0px) + 6rem)' }}
    >
      <div className="grid grid-cols-12 gap-6 md:gap-10">
        <div className="col-span-12 md:col-span-3">
          <p
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em]"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {t('note.label')}
          </p>
        </div>
        <div className="col-span-12 md:col-span-8 space-y-4">
          {paragraphs.map((p, i) => (
            <p
              key={i}
              className="text-base leading-relaxed md:text-lg"
              style={{ color: 'var(--color-text-secondary)', maxWidth: '62ch' }}
            >
              {linkify(p)}
            </p>
          ))}
        </div>
      </div>
    </Section>
  );
}
