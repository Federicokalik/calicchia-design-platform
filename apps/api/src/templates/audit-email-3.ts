export interface AuditEmail3Data {
  name: string;
  industrySimilar: string;
  microCase: string;
  bookingUrl: string;
}

function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAuditEmail3(data: AuditEmail3Data): { subject: string; html: string } {
  const subject = `Caso veloce - ${data.industrySimilar}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;background:#ffffff;margin:0;padding:32px">
  <div style="max-width:620px;margin:0 auto;font-size:16px;line-height:1.6">
    <p>Ciao ${esc(data.name)},</p>
    <p>prima di lasciar perdere: un caso simile al tuo.</p>
    <p>${esc(data.microCase)}</p>
    <p>Se ti suona, 15 minuti qui: <a href="${esc(data.bookingUrl)}">${esc(data.bookingUrl)}</a>.<br>
    Se non ti suona, nessun problema: non ti riscrivo.</p>
    <p>Federico</p>
  </div>
</body>
</html>`;

  return { subject, html };
}
