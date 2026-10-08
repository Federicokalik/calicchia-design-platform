import { read, SSF, utils, type CellObject, type WorkSheet } from 'xlsx';

// Rendering caps: a DOM table past this size freezes the tab, and nobody
// reviews 50k rows in a preview — the file is one click away.
export const XLSX_PREVIEW_MAX_ROWS = 1000;
export const XLSX_PREVIEW_MAX_COLS = 50;

export interface XlsxPreviewCell {
  /** Formatted text, as Excel displays it (number formats, dates). */
  v: string;
  /** Numeric cell → right-aligned like in Excel. */
  n?: true;
  /** Sanitized hyperlink (http/https/mailto only). */
  href?: string;
}

export interface XlsxPreviewMerge {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
}

export interface XlsxPreviewSheet {
  name: string;
  /** 1 = hidden, 2 = "very hidden" (only visible from VBA). */
  hidden: 0 | 1 | 2;
  /** Absolute coordinates of the first rendered cell (sheets can start at B3). */
  originRow: number;
  originCol: number;
  /** Rendered window, null = empty cell. Indexes are relative to the origin. */
  rows: Array<Array<XlsxPreviewCell | null>>;
  /** Merges clipped to the window, relative to the origin. */
  merges: XlsxPreviewMerge[];
  /** Column widths in px from the file, null = default. */
  colWidths: Array<number | null>;
  totalRows: number;
  totalCols: number;
  truncated: boolean;
}

export type XlsxPreviewResult =
  | { ok: true; sheets: XlsxPreviewSheet[] }
  | { ok: false; error: string };

const SAFE_HREF = /^(https?:|mailto:)/i;

/**
 * SheetJS renders number formats with en-US separators ("1,200.50 €"), which
 * an Italian reader takes for 1,2. Swap them, but only between two digits so
 * literal text inside a format ("EUR.") is left alone.
 */
function toItalianNumber(text: string): string {
  return text.replace(/(?<=\d)[.,](?=\d)/g, (sep) => (sep === '.' ? ',' : '.'));
}

function cellText(cell: CellObject): string {
  if (cell.t === 'z' || cell.v == null) return cell.w ?? '';
  try {
    return utils.format_cell(cell);
  } catch {
    return cell.w ?? String(cell.v);
  }
}

function previewSheet(name: string, hidden: 0 | 1 | 2, ws: WorkSheet): XlsxPreviewSheet {
  const empty: XlsxPreviewSheet = {
    name, hidden, originRow: 0, originCol: 0, rows: [], merges: [], colWidths: [],
    totalRows: 0, totalCols: 0, truncated: false,
  };
  if (!ws['!ref']) return empty;

  // With `sheetRows`, !ref is the truncated range and !fullref the real one.
  const window = utils.decode_range(ws['!ref']);
  const full = utils.decode_range(ws['!fullref'] ?? ws['!ref']);
  const totalRows = full.e.r - full.s.r + 1;
  const totalCols = full.e.c - full.s.c + 1;

  const r0 = window.s.r;
  const c0 = window.s.c;
  const rEnd = Math.min(window.e.r, r0 + XLSX_PREVIEW_MAX_ROWS - 1);
  const cEnd = Math.min(window.e.c, c0 + XLSX_PREVIEW_MAX_COLS - 1);

  const rows: XlsxPreviewSheet['rows'] = [];
  for (let r = r0; r <= rEnd; r += 1) {
    const row: Array<XlsxPreviewCell | null> = [];
    for (let c = c0; c <= cEnd; c += 1) {
      const cell = ws[utils.encode_cell({ r, c })] as CellObject | undefined;
      if (!cell) {
        row.push(null);
        continue;
      }
      const out: XlsxPreviewCell = { v: cellText(cell) };
      if (cell.t === 'n') {
        out.n = true;
        // Dates are numbers too: their separators (15.01.2026) must not move.
        if (!SSF.is_date(cell.z ?? 'General')) out.v = toItalianNumber(out.v);
      }
      const target = cell.l?.Target?.trim();
      if (target && SAFE_HREF.test(target)) out.href = target;
      row.push(out.v || out.href ? out : null);
    }
    rows.push(row);
  }

  const merges: XlsxPreviewMerge[] = [];
  for (const m of ws['!merges'] ?? []) {
    // Keep merges anchored inside the window; clip their far edge to it.
    if (m.s.r < r0 || m.s.c < c0 || m.s.r > rEnd || m.s.c > cEnd) continue;
    merges.push({
      r: m.s.r - r0,
      c: m.s.c - c0,
      rowSpan: Math.min(m.e.r, rEnd) - m.s.r + 1,
      colSpan: Math.min(m.e.c, cEnd) - m.s.c + 1,
    });
  }

  const colWidths: Array<number | null> = [];
  for (let c = c0; c <= cEnd; c += 1) {
    // Hidden columns are shown anyway: the admin wants to see everything.
    const col = ws['!cols']?.[c];
    if (col?.wpx) colWidths.push(Math.round(col.wpx));
    else if (col?.wch) colWidths.push(Math.round(col.wch * 7 + 5));
    else colWidths.push(null);
  }

  return {
    name,
    hidden,
    originRow: r0,
    originCol: c0,
    rows,
    merges,
    colWidths,
    totalRows,
    totalCols,
    truncated: totalRows > rows.length || totalCols > (cEnd - c0 + 1),
  };
}

/**
 * Parse an XLSX into a plain, render-ready structure. Formulas are never
 * evaluated: cells carry the values Excel cached when the file was saved.
 * Runs inside a Web Worker (see workers/xlsx-preview.worker.ts).
 */
export function parseXlsxPreview(data: ArrayBuffer): XlsxPreviewResult {
  // XLSX is a ZIP. Without this check SheetJS falls back to parsing unknown
  // bytes as CSV/text and "succeeds" with garbage cells.
  const sig = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  if (sig.length < 4 || sig[0] !== 0x50 || sig[1] !== 0x4b || sig[2] !== 0x03 || sig[3] !== 0x04) {
    return { ok: false, error: 'Il file non è un Excel (.xlsx) valido' };
  }
  try {
    const wb = read(data, {
      type: 'array',
      // Stop parsing rows past the cap: a 25 MB sheet otherwise costs seconds.
      sheetRows: XLSX_PREVIEW_MAX_ROWS,
      cellFormula: false,
      cellHTML: false,
      cellNF: true, // keep .z: tells dates from plain numbers
      cellStyles: true, // needed for !cols widths
      cellDates: false,
    });

    const sheets = wb.SheetNames.map((name, i) => {
      const hidden = (wb.Workbook?.Sheets?.[i]?.Hidden ?? 0) as 0 | 1 | 2;
      return previewSheet(name, hidden, wb.Sheets[name]);
    });
    return { ok: true, sheets };
  } catch (err) {
    return { ok: false, error: `File Excel non leggibile${err instanceof Error ? ` (${err.message})` : ''}` };
  }
}
