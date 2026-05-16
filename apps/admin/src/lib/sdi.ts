import { API_BASE } from './api';

/**
 * Downloads the FatturaPA XML for an invoice, parses the filename from
 * Content-Disposition, and triggers a browser save. Throws with a
 * human-readable message on failure (including the API's `missing` field
 * so the UI can tell the user exactly which setting/field is empty).
 */
export async function downloadSdiXml(invoiceId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/invoices/${invoiceId}/sdi-xml`, {
    credentials: 'include',
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
      if (Array.isArray(body?.missing) && body.missing.length > 0) {
        detail += ` (mancanti: ${body.missing.join(', ')})`;
      }
    } catch { /* response wasn't JSON */ }
    throw new Error(detail);
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] || `fattura-${invoiceId}.xml`;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
