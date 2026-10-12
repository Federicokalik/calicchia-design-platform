'use client';

import { PRESET_KEYS, PRESETS, type FontKey, type PresetKey } from '@calicchia/shared/palette';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { Locale } from '@/lib/i18n';
import type { ToolStrings } from './strings';
import { Square, Step } from './ui';

interface StyleStepProps {
  t: ToolStrings;
  locale: Locale;
  preset: PresetKey;
  suggested: PresetKey;
  reason: string;
  stackOf: (key: FontKey) => string;
  onPreset: (key: PresetKey) => void;
}

export function StyleStep({ t, locale, preset, suggested, reason, stackOf, onPreset }: StyleStepProps) {
  return (
    <Step n="04" id="pds-stile" title={t.styleTitle} help={t.styleHelp}>
      <div role="radiogroup" aria-label={t.styleGroup} className="grid grid-cols-2 gap-3 min-[720px]:grid-cols-4">
        {PRESET_KEYS.map((key) => {
          const p = PRESETS[key];
          const checked = preset === key;
          return (
            <label
              key={key}
              htmlFor={`pds-preset-${key}`}
              className="grid min-w-0 cursor-pointer content-start gap-2.5 border p-4 transition-colors hover:border-[var(--color-ink)] has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-[3px] has-[input:focus-visible]:outline-[var(--color-ink)]"
              style={{
                borderColor: checked ? 'var(--color-ink)' : 'var(--color-line-strong)',
                background: checked ? 'var(--color-ink)' : 'transparent',
                color: checked ? 'var(--color-bg)' : 'var(--color-ink)',
              }}
            >
              <input
                id={`pds-preset-${key}`}
                type="radio"
                name="pds-preset"
                value={key}
                checked={checked}
                onChange={() => onPreset(key)}
                className="sr-only"
              />
              <span aria-hidden="true" className="flex min-h-12 items-center gap-3">
                <span
                  className="text-[2.1rem] leading-none"
                  style={{
                    fontFamily: stackOf(p.fontHeading),
                    fontWeight: p.headingWeight,
                    textTransform: p.headingTransform,
                  }}
                >
                  Aa
                </span>
                <span
                  className="h-[1.6rem] min-w-0 flex-1"
                  style={{
                    borderRadius: p.buttonRadius,
                    border: `${Math.max(1, parseInt(p.borderWidth, 10))}px solid currentColor`,
                    boxShadow: p.sampleShadow,
                  }}
                />
              </span>
              <span className="font-semibold">{p.name[locale]}</span>
              <span className="text-[0.82rem] leading-snug opacity-80">{p.description[locale]}</span>
              {suggested === key ? (
                <span className="flex items-center gap-2 font-mono text-[length:var(--text-mono-xs)] tracking-[0.05em]">
                  <Square />
                  {t.suggested}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="grid max-w-[70ch] gap-1.5 border-t pt-3.5" style={{ borderColor: 'var(--color-line)' }}>
        <MonoLabel as="span">{t.reasonTitle}</MonoLabel>
        <p aria-live="polite">{reason}</p>
      </div>
    </Step>
  );
}
