import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface ContractSignedInput {
  contactName?: string | null;
  quoteNumber: string;
  totalLabel: string;
  signedAt: string;
  quoteUrl?: string | null;
  lang?: 'it' | 'en';
}

export function renderContractSignedEmail(input: ContractSignedInput) {
  const lang = input.lang ?? 'it';
  const name = input.contactName?.trim() || '';
  const greeting = lang === 'en' ? `Hi ${name}`.trim() + ',' : `Ciao ${name}`.trim() + ',';

  const copy =
    lang === 'en'
      ? {
          subject: `Quote ${input.quoteNumber} signed — Calicchia Design`,
          preview: 'Confirmation: we received your signed quote.',
          headline: 'Quote signed',
          intro: `We confirm receipt of your signed quote ${input.quoteNumber}. Work starts according to the agreed timeline.`,
          quoteLabel: 'Quote',
          totalLabel: 'Total',
          dateLabel: 'Signed on',
          cta: 'View signed quote',
          nextSteps: 'You will receive next-step communications from us in the coming days.',
        }
      : {
          subject: `Preventivo ${input.quoteNumber} firmato — Calicchia Design`,
          preview: 'Conferma: abbiamo ricevuto il preventivo firmato.',
          headline: 'Preventivo firmato',
          intro: `Confermiamo la ricezione del preventivo firmato ${input.quoteNumber}. I lavori partono secondo la timeline concordata.`,
          quoteLabel: 'Preventivo',
          totalLabel: 'Totale',
          dateLabel: 'Data firma',
          cta: 'Apri preventivo firmato',
          nextSteps: 'Riceverai le comunicazioni successive nei prossimi giorni.',
        };

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(copy.headline)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(greeting)}</mj-text>
        <mj-text padding-top="12px">${esc(copy.intro)}</mj-text>
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="20px 0" />
        <mj-table>
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.quoteLabel)}</td>
            <td style="padding:8px 0;text-align:right;font-weight:500;">${esc(input.quoteNumber)}</td>
          </tr>
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.totalLabel)}</td>
            <td style="padding:8px 0;text-align:right;font-weight:500;">${esc(input.totalLabel)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.dateLabel)}</td>
            <td style="padding:8px 0;text-align:right;">${esc(input.signedAt)}</td>
          </tr>
        </mj-table>
        ${
          input.quoteUrl
            ? `<mj-button href="${esc(input.quoteUrl)}" padding-top="20px" align="left">${esc(copy.cta)}</mj-button>`
            : ''
        }
        <mj-text padding-top="20px">${esc(copy.nextSteps)}</mj-text>
      </mj-column>
    </mj-section>
  `;

  return renderBrandedEmail({
    preview: copy.preview,
    title: copy.subject,
    sectionsMjml: sections,
    lang,
  }).then((compiled) => ({ subject: copy.subject, ...compiled }));
}
