import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface ContactFormInput {
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  message: string;
  wantsMeet?: boolean;
  source?: string | null;
  adminUrl?: string | null;
}

export function renderContactFormEmail(input: ContactFormInput) {
  const subject = input.wantsMeet
    ? `[CALL] Nuovo contatto: ${input.name}`
    : `Nuovo contatto: ${input.name}`;

  const phoneRow = input.phone
    ? `<tr><td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Telefono</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;">${esc(input.phone)}</td></tr>`
    : '';
  const companyRow = input.company
    ? `<tr><td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Azienda</td><td style="padding:6px 0;text-align:right;">${esc(input.company)}</td></tr>`
    : '';
  const sourceRow = input.source
    ? `<tr><td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Provenienza</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;">${esc(input.source)}</td></tr>`
    : '';

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${input.wantsMeet ? 'CALL' : 'Lead'}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(input.name)}</mj-text>
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" />
        <mj-table>
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:6px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Email</td>
            <td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;">
              <a href="mailto:${esc(input.email)}" style="color:#111111;">${esc(input.email)}</a>
            </td>
          </tr>
          ${phoneRow}
          ${companyRow}
          ${sourceRow}
        </mj-table>
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" />
        <mj-text mj-class="eyebrow">Messaggio</mj-text>
        <mj-text padding-top="8px">${esc(input.message).replace(/\n/g, '<br/>')}</mj-text>
        ${
          input.adminUrl
            ? `<mj-button href="${esc(input.adminUrl)}" padding-top="24px" align="left">Apri in admin</mj-button>`
            : ''
        }
      </mj-column>
    </mj-section>
  `;

  return renderBrandedEmail({
    preview: input.wantsMeet ? `${input.name} vuole una call` : `Messaggio da ${input.name}`,
    title: subject,
    sectionsMjml: sections,
    lang: 'it',
  }).then((compiled) => ({ subject, ...compiled }));
}
