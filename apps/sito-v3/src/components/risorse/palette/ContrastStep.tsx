'use client';

import { type ContrastKind, type PaletteRoles, contrast, contrastGrade } from '@calicchia/shared/palette';
import type { Locale } from '@/lib/i18n';
import { fmtRatio, type ToolStrings } from './strings';
import { Step } from './ui';

interface ContrastStepProps {
  t: ToolStrings;
  locale: Locale;
  roles: PaletteRoles;
  autofix: boolean;
  onAutofix: (value: boolean) => void;
}

export function ContrastStep({ t, locale, roles: r, autofix, onAutofix }: ContrastStepProps) {
  const rows: [string, string, string, ContrastKind][] = [
    [t.rowTextBg, r.text, r.bg, 'text'],
    [t.rowMutedBg, r.muted, r.bg, 'text'],
    [t.rowTextSurface, r.text, r.surface, 'text'],
    [t.rowOnPrimary, r.onPrimary, r.primaryUsed, 'text'],
    [t.rowAccentText, r.accentText, r.bg, 'text'],
    [t.rowAccentUi, r.accent, r.bg, 'ui'],
  ];
  const gradeLabel = { AAA: t.gradeAAA, AA: t.gradeAA, 'large-only': t.gradeLarge, 'ui-pass': t.gradeUi, fail: t.gradeFail } as const;
  const th = 'pb-2.5 pr-4 text-left font-mono text-[length:var(--text-mono-xs)] font-normal tracking-[0.05em]';
  const td = 'border-b py-3 pr-4 align-middle text-sm';

  return (
    <Step n="07" id="pds-contrasti" title={t.contrastTitle} help={t.contrastHelp}>
      <label htmlFor="pds-autofix" className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input
          id="pds-autofix"
          type="checkbox"
          checked={autofix}
          onChange={(e) => onAutofix(e.target.checked)}
          className="m-0 h-[1.05rem] w-[1.05rem]"
          style={{ accentColor: 'var(--color-ink)' }}
        />
        {t.autofix}
      </label>

      <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="pds-contrasti">
        <table className="w-full min-w-[30rem] border-collapse tabular-nums">
          <thead>
            <tr style={{ color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-ink)' }}>
              <th scope="col" className={th}>
                {t.thSample}
              </th>
              <th scope="col" className={th}>
                {t.thPair}
              </th>
              <th scope="col" className={th}>
                {t.thRatio}
              </th>
              <th scope="col" className={th}>
                {t.thGrade}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, fg, bg, kind]) => {
              const ratio = contrast(fg, bg);
              const { grade, pass } = contrastGrade(ratio, kind);
              return (
                <tr key={label}>
                  <td className={td} style={{ borderColor: 'var(--color-line)' }}>
                    <span
                      aria-hidden="true"
                      className="inline-grid h-8 w-11 place-items-center border text-[0.95rem] font-semibold"
                      style={{ background: bg, color: fg, borderColor: 'var(--color-line)' }}
                    >
                      Aa
                    </span>
                  </td>
                  <td className={td} style={{ borderColor: 'var(--color-line)' }}>
                    {label}
                  </td>
                  <td className={`${td} font-mono text-[0.85rem]`} style={{ borderColor: 'var(--color-line)' }}>
                    {fmtRatio(ratio, locale)}
                  </td>
                  <td className={td} style={{ borderColor: 'var(--color-line)' }}>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.08em]">
                      <i
                        aria-hidden="true"
                        className="inline-block h-2 w-2 flex-none"
                        style={{ background: pass ? 'var(--color-ink)' : 'var(--color-accent)' }}
                      />
                      {gradeLabel[grade]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-1.5 text-sm" style={{ color: 'var(--color-text-secondary)' }} aria-live="polite">
        {!autofix ? (
          <p>{t.autofixOff}</p>
        ) : !r.fixes.length ? (
          <p>{t.noFixes}</p>
        ) : (
          r.fixes.map((f) => {
            const what = f.kind === 'primary' ? t.fixPrimary : t.fixAccent;
            const note =
              f.kind === 'primary'
                ? t.fixPrimaryNote(fmtRatio(f.ratio, locale), f.on === '#FFFFFF')
                : t.fixAccentNote(fmtRatio(f.ratio, locale));
            const [a, arrow, reach] = t.fixLine(what);
            return (
              <p key={f.kind}>
                {a}
                <b className="font-mono text-[0.8rem] font-medium" style={{ color: 'var(--color-ink)' }}>
                  {f.from}
                </b>
                {arrow}
                <b className="font-mono text-[0.8rem] font-medium" style={{ color: 'var(--color-ink)' }}>
                  {f.to}
                </b>
                {reach}
                {note}.
              </p>
            );
          })
        )}
      </div>
    </Step>
  );
}
