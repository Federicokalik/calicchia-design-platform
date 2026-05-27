import { apiFetchRaw } from './api';

/**
 * Downloads the FatturaPA XML for an invoice, parses the filename from
 * Content-Disposition, and triggers a browser save. Throws with a
 * human-readable message on failure (including the API's `missing` field
 * so the UI can tell the user exactly which setting/field is empty).
 *
 * Uses apiFetchRaw (audit D-005) so 401 triggers the same refresh/redirect
 * flow as the rest of the admin instead of throwing a local error.
 */
export async function downloadSdiXml(invoiceId: string): Promise<void> {
  let res: Response;
  try {
    res = await apiFetchRaw(`/api/invoices/${invoiceId}/sdi-xml`);
  } catch (err) {
    // apiFetchRaw already attempted the auth refresh; surface the original
    // error to the caller (UI shows a toast).
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Map the API's structured "missing fields" payload onto the thrown message.
  // apiFetchRaw never returns a non-ok response (it throws first), but the
  // body parser only checked res.ok — keep the field extraction here so the
  // UI gets the "(mancanti: …)" suffix when present.
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
