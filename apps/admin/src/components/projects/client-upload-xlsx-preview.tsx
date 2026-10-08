import { useEffect, useMemo, useState } from 'react';
import { EyeOff, Info, Loader2 } from 'lucide-react';
import { useClientUploadBytes } from '@/hooks/use-client-uploads';
// Type-only: the parser (and SheetJS with it) lives in the worker bundle.
import type { XlsxPreviewResult, XlsxPreviewSheet } from '@/lib/xlsx-preview';
import { cn } from '@/lib/utils';

const PARSE_TIMEOUT_MS = 30_000;
const DEFAULT_COL_MIN_PX = 64;
const DEFAULT_COL_MAX_PX = 320;

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function firstVisibleSheet(sheets: XlsxPreviewSheet[]): number {
  const i = sheets.findIndex((s) => s.hidden === 0);
  return i >= 0 ? i : 0;
}

/**
 * Read-only XLSX table. Cell text is rendered by React (always escaped —
 * SheetJS' sheet_to_html is deliberately not used) and links are already
 * restricted to http(s)/mailto by the parser.
 */
export function XlsxPreview({
  fileId,
  onError,
}: {
  fileId: string;
  /** Fetch/parse failure: the lightbox swaps in its download fallback. */
  onError: (message: string) => void;
}) {
  const { data, error } = useClientUploadBytes(fileId);
  const [sheets, setSheets] = useState<XlsxPreviewSheet[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (error) onError(error instanceof Error ? error.message : 'Anteprima non disponibile.');
  }, [error, onError]);

  useEffect(() => {
    if (!data) return;
    const worker = new Worker(new URL('../../workers/xlsx-preview.worker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      onError('Il file è troppo pesante per l’anteprima: scaricalo per aprirlo.');
    }, PARSE_TIMEOUT_MS);
    const finish = () => {
      window.clearTimeout(timer);
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<XlsxPreviewResult>) => {
      finish();
      const result = event.data;
      if (!result.ok) {
        onError(result.error);
        return;
      }
      setSheets(result.sheets);
      setActive(firstVisibleSheet(result.sheets));
    };
    worker.onerror = () => {
      finish();
      onError('Errore durante la lettura del file Excel.');
    };

    // Transfer a copy: the cached bytes stay usable for the next open.
    const copy = data.slice(0);
    worker.postMessage(copy, [copy]);
    return finish;
  }, [data, onError]);

  const sheet = sheets?.[active] ?? null;

  const { spans, covered } = useMemo(() => {
    const spanMap = new Map<string, { rowSpan: number; colSpan: number }>();
    const coveredSet = new Set<string>();
    for (const m of sheet?.merges ?? []) {
      spanMap.set(`${m.r}:${m.c}`, { rowSpan: m.rowSpan, colSpan: m.colSpan });
      for (let r = m.r; r < m.r + m.rowSpan; r += 1) {
        for (let c = m.c; c < m.c + m.colSpan; c += 1) {
          if (r !== m.r || c !== m.c) coveredSet.add(`${r}:${c}`);
        }
      }
    }
    return { spans: spanMap, covered: coveredSet };
  }, [sheet]);

  if (!sheets || !sheet) {
    return <Loader2 className="h-6 w-6 animate-spin text-white/60" />;
  }

  const colCount = sheet.rows[0]?.length ?? 0;

  return (
    <div className="flex h-full w-full flex-col bg-white text-neutral-900">
      <div
        // Focusable so arrow keys scroll the grid once clicked (the lightbox
        // leaves them alone inside [data-lightbox-arrows="native"]).
        tabIndex={0}
        data-lightbox-arrows="native"
        className="min-h-0 flex-1 overflow-auto focus:outline-none"
      >
        {sheet.rows.length === 0 ? (
          <p className="p-6 text-sm text-neutral-500">Foglio vuoto.</p>
        ) : (
          <table className="border-separate border-spacing-0 text-[13px] leading-snug">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 min-w-[44px] border-b border-r border-neutral-300 bg-neutral-100" />
                {Array.from({ length: colCount }, (_, c) => (
                  <th
                    key={c}
                    className="sticky top-0 z-10 border-b border-r border-neutral-300 bg-neutral-100 px-1.5 py-0.5 text-center text-xs font-normal text-neutral-500"
                  >
                    {columnLetter(sheet.originCol + c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th className="sticky left-0 z-10 border-b border-r border-neutral-300 bg-neutral-100 px-1.5 text-right text-xs font-normal tabular-nums text-neutral-500">
                    {sheet.originRow + r + 1}
                  </th>
                  {row.map((cell, c) => {
                    const key = `${r}:${c}`;
                    if (covered.has(key)) return null;
                    const span = spans.get(key);
                    const width = sheet.colWidths[c];
                    return (
                      <td
                        key={c}
                        rowSpan={span?.rowSpan}
                        colSpan={span?.colSpan}
                        className={cn(
                          'border-b border-r border-neutral-200 px-1.5 py-0.5 align-bottom',
                          cell?.n && 'text-right tabular-nums',
                          span && 'text-center align-middle',
                        )}
                      >
                        <div
                          className="truncate"
                          title={cell?.v || undefined}
                          // Merged cells span several columns: no per-column cap.
                          style={span ? undefined : {
                            minWidth: width ?? DEFAULT_COL_MIN_PX,
                            maxWidth: width ?? DEFAULT_COL_MAX_PX,
                          }}
                        >
                          {cell?.href ? (
                            <a href={cell.href} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">
                              {cell.v || cell.href}
                            </a>
                          ) : (
                            cell?.v
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {sheet.truncated && (
        <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Anteprima limitata a {sheet.rows.length.toLocaleString('it-IT')} di {sheet.totalRows.toLocaleString('it-IT')} righe
          e {colCount} di {sheet.totalCols} colonne. Scarica il file per vederlo completo.
        </div>
      )}

      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-neutral-300 bg-neutral-100 px-2 py-1">
          {sheets.map((s, i) => (
            <button
              key={`${i}-${s.name}`}
              type="button"
              onClick={() => setActive(i)}
              title={s.hidden ? 'Foglio nascosto nel file originale' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-sm px-3 py-1 text-xs',
                i === active
                  ? 'bg-white font-medium text-emerald-700 shadow-sm'
                  : 'text-neutral-600 hover:bg-white/60',
                s.hidden !== 0 && 'italic',
              )}
            >
              {s.hidden !== 0 && <EyeOff className="h-3 w-3" />}
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
