export interface AuditEmail2Data {
  name: string;
  siteUrl: string;
  bookingUrl: string;
  finding?: string | null;
}

function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAuditEmail2(data: AuditEmail2Data): { subject: string; html: string } {
  const subject = "Ho dato un'occhiata al sito - 1 cosa che salta all'occhio";
  const finding =
    data.finding ||
    'Il form contatti carica una libreria di tracking prima del consenso cookie: questo può diventare un problema GDPR e rallenta la prima visualizzazione.';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;background:#ffffff;margin:0;padding:32px">
  <div style="max-width:620px;margin:0 auto;font-size:16px;line-height:1.6">
    <p>Ciao ${esc(data.name)},</p>
    <p>ho dato un'occhiata veloce a ${esc(data.siteUrl)}. Una cosa salta all'occhio:</p>
    <p>${esc(finding)}</p>
    <p>Vediamo se vale 15 minuti per parlarne? Slot disponibili qui: <a href="${esc(data.bookingUrl)}">${esc(data.bookingUrl)}</a>.</p>
    <p>Federico</p>
  </div>
</body>
</html>`;

  return { subject, html };
}
