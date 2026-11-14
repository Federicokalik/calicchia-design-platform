'use client';

import { type Lab, type PaletteColor, type PaletteRoles, contrast, labToLch } from '@calicchia/shared/palette';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { Locale } from '@/lib/i18n';
import { fmt2, type ToolStrings } from './strings';
import { LinkButton, Step } from './ui';

interface PaletteStepProps {
  t: ToolStrings;
  locale: Locale;
  palette: readonly PaletteColor[];
  roles: PaletteRoles;
  lockedHexes: ReadonlySet<string>;
  status: string;
  regenDisabled: boolean;
  onToggleLock: (hex: string, lab: Lab) => void;
  onPrimary: (hex: string) => void;
  onRegenerate: () => void;
}

const INK = '#111111';
const WHITE = '#FFFFFF';

export function PaletteStep({
  t,
  locale,
  palette,
  roles: r,
  lockedHexes,
  status,
  regenDisabled,
  onToggleLock,
  onPrimary,
  onRegenerate,
}: PaletteStepProps) {
  const neutrals: [string, string][] = [
    [t.neutralBg, r.bg],
    [t.neutralSurface, r.surface],
    [t.neutralBorder, r.border],
    [t.neutralMuted, r.muted],
    [t.neutralText, r.text],
  ];

  return (
    <Step n="03" id="pds-palette" title={t.paletteTitle} help={t.paletteHelp}>
      <ul
        role="list"
        className="m-0 grid list-none border-t p-0 min-[720px]:grid-cols-5 min-[720px]:gap-4 min-[720px]:pt-4"
        style={{ borderColor: 'var(--color-ink)' }}
      >
        {palette.map((p) => {
          const [L, C, h] = labToLch(p.lab);
          const isLocked = lockedHexes.has(p.hex);
          const flag = p.fromLogo ? t.flagLogo : isLocked ? t.flagLocked : null;
          return (
            <li
              key={p.hex}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)] content-start gap-4 border-b py-3.5 min-[720px]:grid-cols-1 min-[720px]:gap-3 min-[720px]:border-b-0 min-[720px]:py-0"
              style={{ borderColor: 'var(--color-line)' }}
            >
              <div className="relative aspect-square w-full max-w-full min-[720px]:aspect-[4/5]" style={{ background: p.hex }}>
                {flag ? (
                  <span
                    className="absolute left-1.5 top-1.5 font-mono text-[0.62rem] uppercase tracking-[0.08em]"
                    style={{ color: contrast(p.hex, INK) > contrast(p.hex, WHITE) ? INK : WHITE }}
                  >
                    {flag}
                  </span>
                ) : null}
              </div>
              <div className="grid min-w-0 content-start gap-1">
                <span className="font-mono text-[0.95rem] tracking-[0.02em]">{p.hex}</span>
                <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
                  {`L ${fmt2(L, locale)} · C ${fmt2(C, locale)} · ${Math.round(h)}°`}
                </MonoLabel>
                <span className="min-h-[1.3em] text-sm font-semibold">
                  {p.hex === r.primary ? (
                    <>
                      {t.rolePrimary}
                      {r.primaryUsed !== r.primary ? (
                        <small className="block font-mono text-[length:var(--text-mono-xs)] font-normal" style={{ color: 'var(--color-text-secondary)' }}>
                          {t.rolePrimaryUsed(r.primaryUsed)}
                        </small>
                      ) : null}
                    </>
                  ) : p.hex === r.accent ? (
                    <>
                      {t.roleAccent}
                      {r.accentText !== r.accent ? (
                        <small className="block font-mono text-[length:var(--text-mono-xs)] font-normal" style={{ color: 'var(--color-text-secondary)' }}>
                          {t.roleAccentText(r.accentText)}
                        </small>
                      ) : null}
                    </>
                  ) : null}
                </span>
                <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1.5">
                  {!p.fromLogo ? (
                    <LinkButton
                      aria-pressed={isLocked}
                      aria-label={isLocked ? t.unlockAria(p.hex) : t.lockAria(p.hex)}
                      onClick={() => onToggleLock(p.hex, p.lab)}
                    >
                      {isLocked ? t.unlock : t.lock}
                    </LinkButton>
                  ) : null}
                  {p.hex !== r.primary ? (
                    <LinkButton aria-label={t.usePrimaryAria(p.hex)} onClick={() => onPrimary(p.hex)}>
                      {t.usePrimary}
                    </LinkButton>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
        <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
          {t.neutralsHead}
        </MonoLabel>
        <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
          {t.neutralsNote}
        </MonoLabel>
      </div>
      <ul role="list" className="m-0 grid list-none grid-cols-5 gap-[clamp(0.4rem,1.2vw,1rem)] p-0">
        {neutrals.map(([label, hex]) => (
          <li key={label} className="grid min-w-0 gap-1.5">
            <div className="h-10 border" style={{ background: hex, borderColor: 'var(--color-line)' }} />
            <span className="text-[0.78rem] leading-tight [overflow-wrap:anywhere]">{label}</span>
            <MonoLabel as="span" className="[overflow-wrap:anywhere]" style={{ lineHeight: 1.3 }}>
              {hex}
            </MonoLabel>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button type="button" variant="ghost" size="sm" disabled={regenDisabled} onClick={onRegenerate}>
          {t.regenerate}
        </Button>
        <MonoLabel as="span" aria-live="polite" style={{ lineHeight: 1.4 }}>
          {status}
        </MonoLabel>
      </div>
    </Step>
  );
}
