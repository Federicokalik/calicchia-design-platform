export interface AuditEmail1Data {
  name: string;
  service: string;
  bookingUrl: string;
  siteUrl: string;
}

function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAuditEmail1(data: AuditEmail1Data): { subject: string; html: string } {
  const subject = 'Conferma richiesta audit - 3 domande';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;background:#ffffff;margin:0;padding:32px">
  <div style="max-width:620px;margin:0 auto;font-size:16px;line-height:1.6">
    <p>Ciao ${esc(data.name)},</p>
    <p>ho ricevuto la tua richiesta di audit per ${esc(data.service)}. 15 minuti su Meet, niente preventivo prima.</p>
    <p>Per arrivare preparato a chiamarti, mi servono 3 cose (rispondi a questa email):</p>
    <ol>
      <li>URL del sito attuale (anche se è "in costruzione")</li>
      <li>Cosa secondo te non funziona oggi</li>
      <li>Cosa vuoi che funzioni tra 6 mesi</li>
    </ol>
    <p>Ti ricontatto entro 24 ore con uno slot. Se preferisci tu, scegli qui: <a href="${esc(data.bookingUrl)}">${esc(data.bookingUrl)}</a>.</p>
    <p>Federico Calicchia<br><a href="${esc(data.siteUrl)}">${esc(data.siteUrl)}</a></p>
  </div>
</body>
</html>`;

  return { subject, html };
}
