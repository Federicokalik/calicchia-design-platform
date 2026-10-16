'use client';

import { useRef, useState } from 'react';
import { EXPORT_FORMATS, type ExportFormat } from '@calicchia/shared/palette';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { ToolStrings } from './strings';
import { Chip, Step } from './ui';
import styles from './PaletteTool.module.css';

interface ExportStepProps {
  t: ToolStrings;
  tab: ExportFormat;
  code: string;
  /** Querystring del link condiviso; null se la palette non si può condividere. */
  shareQuery: string | null;
  /** Path localizzato della pagina `condividi`. */
  sharePath: string;
  onTab: (tab: ExportFormat) => void;
  onCopied: () => void;
  onShared: () => void;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    // Se il browser resta in attesa (permesso non concesso), dopo 2 s passo al ripiego.
    return await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  } catch {
    return false;
  }
}

export function ExportStep({ t, tab, code, shareQuery, sharePath, onTab, onCopied, onShared }: ExportStepProps) {
  const codeRef = useRef<HTMLPreElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [copyMsg, setCopyMsg] = useState<{ code: string; text: string } | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [shownQuery, setShownQuery] = useState<string | null>(null);

  async function copyCode() {
    onCopied();
    if (await writeClipboard(code)) {
      setCopyMsg({ code, text: t.copied });
      return;
    }
    // Ripiego: seleziono il testo e lascio fare all'utente.
    const el = codeRef.current;
    const sel = window.getSelection();
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setCopyMsg({ code, text: t.copyFallback });
  }

  async function share() {
    if (!shareQuery) return;
    onShared();
    setShownQuery(shareQuery);
    if (await writeClipboard(`${window.location.origin}${sharePath}?${shareQuery}`)) {
      setShareMsg(t.shareCopied);
    } else {
      setShareMsg(t.shareReady);
      requestAnimationFrame(() => linkRef.current?.select());
    }
  }

  // Il messaggio "copiato" vale solo per il codice che era a schermo.
  const copyText = copyMsg && copyMsg.code === code ? copyMsg.text : '';
  // L'URL completo si costruisce solo dopo il clic: in SSR non c'è window.
  const linkIsCurrent = shownQuery !== null && shownQuery === shareQuery;
  const shownUrl = linkIsCurrent ? `${window.location.origin}${sharePath}?${shownQuery}` : '';

  return (
    <Step n="08" id="pds-esporta" title={t.exportTitle} help={t.exportHelp}>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t.exportGroup}>
        {EXPORT_FORMATS.map((f) => (
          <Chip key={f} pressed={tab === f} onClick={() => onTab(f)}>
            {t.exportTabs[f]}
          </Chip>
        ))}
      </div>
      <pre ref={codeRef} className={styles.code} tabIndex={0} aria-label={t.codeAria}>
        {code}
      </pre>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button type="button" variant="ghost" size="sm" onClick={copyCode}>
          {t.copy}
        </Button>
        <MonoLabel as="span" aria-live="polite" style={{ lineHeight: 1.4 }}>
          {copyText}
        </MonoLabel>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 border-t pt-5" style={{ borderColor: 'var(--color-ink)' }}>
        <h3
          className="font-[family-name:var(--font-display)] text-2xl"
          style={{ fontWeight: 500, letterSpacing: '-0.018em', lineHeight: 1.15 }}
        >
          {t.shareTitle}
        </h3>
        <p className="max-w-[60ch]" style={{ color: 'var(--color-text-secondary)' }}>
          {t.shareText}
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button type="button" variant="ghost" size="sm" disabled={!shareQuery} onClick={share}>
            {t.share}
          </Button>
          <MonoLabel as="span" aria-live="polite" style={{ lineHeight: 1.4 }}>
            {linkIsCurrent ? shareMsg : ''}
          </MonoLabel>
        </div>
        {linkIsCurrent ? (
          <div className="flex flex-col">
            <label htmlFor="pds-share-link" className="text-xs uppercase tracking-[0.2em]" style={{ color: 'var(--color-text-secondary)' }}>
              {t.shareLinkLabel}
            </label>
            <input
              ref={linkRef}
              id="pds-share-link"
              type="text"
              readOnly
              value={shownUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-3 w-full min-w-0 border-b bg-transparent py-2 font-mono text-sm"
              style={{ borderColor: 'var(--color-border-strong)' }}
            />
          </div>
        ) : null}
        <MonoLabel as="p" style={{ lineHeight: 1.4 }}>
          {t.shareNote}
        </MonoLabel>
      </div>
    </Step>
  );
}
