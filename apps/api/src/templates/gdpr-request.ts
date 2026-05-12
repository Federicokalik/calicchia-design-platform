import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface GdprRequestInput {
  requestType: 'access' | 'erasure' | 'rectification' | 'portability' | 'objection' | 'restriction';
  email: string;
  fullName?: string | null;
  message?: string | null;
  requestId: string;
  adminUrl?: string | null;
}

const TYPE_LABELS: Record<GdprRequestInput['requestType'], string> = {
  access: 'Accesso ai dati (art. 15)',
  erasure: 'Cancellazione (art. 17 — diritto all\'oblio)',
  rectification: 'Rettifica (art. 16)',
  portability: 'Portabilità (art. 20)',
  objection: 'Opposizione al trattamento (art. 21)',
  restriction: 'Limitazione del trattamento (art. 18)',
};

export function renderGdprRequestEmail(input: GdprRequestInput) {
  const subject = `GDPR — ${TYPE_LABELS[input.requestType]}`;

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">Richiesta GDPR</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(TYPE_LABELS[input.requestType])}</mj-text>
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" />
        <mj-table>
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">ID richiesta</td>
            <td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;">${esc(input.requestId)}</td>
          </tr>
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Email</td>
            <td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;">
              <a href="mailto:${esc(input.email)}" style="color:#111111;">${esc(input.email)}</a>
            </td>
          </tr>
          ${
            input.fullName
              ? `<tr><td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Nome</td><td style="padding:6px 0;text-align:right;">${esc(input.fullName)}</td></tr>`
              : ''
          }
        </mj-table>
        ${
          input.message
            ? `<mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" /><mj-text mj-class="eyebrow">Messaggio</mj-text><mj-text padding-top="8px">${esc(input.message).replace(/\n/g, '<br/>')}</mj-text>`
            : ''
        }
        ${
          input.adminUrl
            ? `<mj-button href="${esc(input.adminUrl)}" padding-top="24px" align="left">Gestisci richiesta</mj-button>`
            : ''
        }
        <mj-text mj-class="muted" padding-top="20px">
          Termine di risposta: 30 giorni (art. 12 GDPR). Documenta evasione nella schermata richieste.
        </mj-text>
      </mj-column>
    </mj-section>
  `;

  return renderBrandedEmail({
    preview: `Nuova richiesta GDPR: ${TYPE_LABELS[input.requestType]}`,
    title: subject,
    sectionsMjml: sections,
    lang: 'it',
  }).then((compiled) => ({ subject, ...compiled }));
}
