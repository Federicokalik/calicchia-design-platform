'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { FieldLabel, Input } from '@/components/ui/form';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { SectorIndexEntry } from '@/data/risorse/palette/types';
import type { Locale } from '@/lib/i18n';
import type { SectorState } from './state';
import type { ToolStrings } from './strings';
import { Chip, Notice, Step } from './ui';

interface SectorStepProps {
  t: ToolStrings;
  locale: Locale;
  sector: SectorState;
  chips: readonly SectorIndexEntry[];
  loading: boolean;
  onPick: (slug: string) => void;
  onSearch: (text: string) => void;
}

export function SectorStep({ t, locale, sector, chips, loading, onPick, onSearch }: SectorStepProps) {
  const message = sector.message;

  return (
    <Step n="01" id="pds-settore" title={t.sectorTitle} help={t.sectorHelp}>
      {/* key: quando il settore cambia da fuori (chip), il campo riparte dalla sua etichetta. */}
      <SectorForm key={sector.key} t={t} initial={sector.label} loading={loading} onSearch={onSearch} />

      {chips.length ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t.chipsLabel}>
          {chips.map((c) => (
            <Chip key={c.slug} pressed={sector.slug === c.slug} disabled={loading} onClick={() => onPick(c.slug)}>
              {c.label[locale]}
            </Chip>
          ))}
        </div>
      ) : null}

      <MonoLabel as="p" className="[overflow-wrap:anywhere]" style={{ lineHeight: 1.4 }}>
        {sector.queries.length ? (
          <>
            {t.queryPrefix}
            {sector.queries.map((q, i) => (
              <span key={q}>
                {i ? ' · ' : ''}
                <b className="font-normal" style={{ color: 'var(--color-text-primary)' }}>
                  {q}
                </b>
              </span>
            ))}
          </>
        ) : (
          t.queryLocal
        )}
      </MonoLabel>

      <div aria-live="polite">
        {message?.kind === 'simulated' ? <Notice>{t.msgSimulated(message.text)}</Notice> : null}
        {message?.kind === 'photosMissing' ? <Notice>{t.msgSectorPhotosMissing}</Notice> : null}
      </div>
    </Step>
  );
}

function SectorForm({
  t,
  initial,
  loading,
  onSearch,
}: {
  t: ToolStrings;
  initial: string;
  loading: boolean;
  onSearch: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [tooShort, setTooShort] = useState(false);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = text.trim();
    if (value.length < 2) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    onSearch(value);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col">
      <FieldLabel htmlFor="pds-sector-input">{t.sectorLabel}</FieldLabel>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <Input
          id="pds-sector-input"
          name="sector"
          type="text"
          autoComplete="off"
          maxLength={40}
          placeholder={t.sectorPlaceholder}
          value={text}
          invalid={tooShort}
          aria-describedby={tooShort ? 'pds-sector-error' : undefined}
          onChange={(e) => setText(e.target.value)}
          className="w-full min-w-0 flex-[1_1_18rem] placeholder:text-[var(--color-line-strong)]"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-display-sm)',
            fontWeight: 500,
            lineHeight: 1.15,
            letterSpacing: '-0.018em',
          }}
        />
        <Button type="submit" variant="ghost" disabled={loading} aria-busy={loading}>
          {loading ? t.searching : t.generate}
        </Button>
      </div>
      {tooShort ? (
        <span id="pds-sector-error" role="alert" className="mt-2 text-xs" style={{ color: 'var(--color-text-error)' }}>
          {t.msgTooShort}
        </span>
      ) : null}
    </form>
  );
}
