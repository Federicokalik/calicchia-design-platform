/**
 * Minimal RFC-4180-ish CSV parser (no deps). Handles quoted fields, escaped
 * quotes (""), commas and newlines inside quotes, and CRLF. Auto-detects the
 * delimiter between comma and semicolon (common in IT/Excel exports).
 * Returns an array of objects keyed by the header row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // strip BOM
  const delimiter = detectDelimiter(clean);
  const rows = parseRows(clean, delimiter);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
      return obj;
    });
}

function detectDelimiter(text: string): string {
  const nl = text.indexOf('\n');
  const firstLine = text.slice(0, nl >= 0 ? nl : text.length);
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // swallow — \n handles the row break
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
