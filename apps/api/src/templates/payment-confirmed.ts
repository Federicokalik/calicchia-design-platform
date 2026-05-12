import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface PaymentConfirmedInput {
  contactName?: string | null;
  invoiceNumber: string;
  amountLabel: string; // already formatted "€ 1.234,56"
  paidAt: string; // already formatted date
  invoiceUrl?: string | null;
  receiptUrl?: string | null;
  lang?: 'it' | 'en';
}

export function renderPaymentConfirmedEmail(input: PaymentConfirmedInput) {
  const lang = input.lang ?? 'it';
  const name = input.contactName?.trim() || '';
  const greeting = lang === 'en' ? `Hi ${name}`.trim() + ',' : `Ciao ${name}`.trim() + ',';

  const copy =
    lang === 'en'
      ? {
          subject: `Payment received — Invoice ${input.invoiceNumber}`,
          preview: `${input.amountLabel} received. Thanks!`,
          headline: 'Payment received',
          intro: `We confirm we received your payment for invoice ${input.invoiceNumber}.`,
          amountLabel: 'Amount',
          dateLabel: 'Paid on',
          invoiceLabel: 'Invoice',
          cta: 'View invoice',
          receiptCta: 'Download receipt',
          thanks: 'Thanks for your trust.',
        }
      : {
          subject: `Pagamento ricevuto — Fattura ${input.invoiceNumber}`,
          preview: `${input.amountLabel} ricevuti. Grazie!`,
          headline: 'Pagamento ricevuto',
          intro: `Confermiamo di aver ricevuto il pagamento per la fattura ${input.invoiceNumber}.`,
          amountLabel: 'Importo',
          dateLabel: 'Data pagamento',
          invoiceLabel: 'Fattura',
          cta: 'Apri fattura',
          receiptCta: 'Scarica ricevuta',
          thanks: 'Grazie per la fiducia.',
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
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.invoiceLabel)}</td>
            <td style="padding:8px 0;text-align:right;font-weight:500;">${esc(input.invoiceNumber)}</td>
          </tr>
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.amountLabel)}</td>
            <td style="padding:8px 0;text-align:right;font-weight:500;color:#F57F44;">${esc(input.amountLabel)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.dateLabel)}</td>
            <td style="padding:8px 0;text-align:right;">${esc(input.paidAt)}</td>
          </tr>
        </mj-table>
        ${
          input.invoiceUrl
            ? `<mj-button href="${esc(input.invoiceUrl)}" padding-top="20px" align="left">${esc(copy.cta)}</mj-button>`
            : ''
        }
        ${
          input.receiptUrl
            ? `<mj-button href="${esc(input.receiptUrl)}" padding-top="8px" align="left" background-color="#171717">${esc(copy.receiptCta)}</mj-button>`
            : ''
        }
        <mj-text padding-top="20px">${esc(copy.thanks)}</mj-text>
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
