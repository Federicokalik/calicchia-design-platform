import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface QuoteInviteInput {
  contactName?: string | null;
  quoteNumber: string;
  projectScope?: string | null;
  totalLabel: string;
  validUntil?: string | null;
  quoteUrl: string;
  lang?: 'it' | 'en';
}

export function renderQuoteInviteEmail(input: QuoteInviteInput) {
  const lang = input.lang ?? 'it';
  const name = input.contactName?.trim() || '';
  const greeting = lang === 'en' ? `Hi ${name}`.trim() + ',' : `Ciao ${name}`.trim() + ',';

  const copy =
    lang === 'en'
      ? {
          subject: `Quote ${input.quoteNumber} — Calicchia Design`,
          preview: `Your quote is ready to review.`,
          headline: 'Your quote is ready',
          intro: `I've prepared a quote for your project. You can review it and sign it online.`,
          quoteLabel: 'Quote',
          scopeLabel: 'Scope',
          totalLabel: 'Total',
          validLabel: 'Valid until',
          cta: 'Review quote',
          footnote: 'If you have questions, just reply to this email.',
        }
      : {
          subject: `Preventivo ${input.quoteNumber} — Calicchia Design`,
          preview: `Il tuo preventivo è pronto.`,
          headline: 'Il tuo preventivo è pronto',
          intro: `Ho preparato il preventivo per il tuo progetto. Puoi visualizzarlo e firmarlo online.`,
          quoteLabel: 'Preventivo',
          scopeLabel: 'Ambito',
          totalLabel: 'Totale',
          validLabel: 'Valido fino al',
          cta: 'Apri preventivo',
          footnote: 'Per qualsiasi domanda rispondi a questa email.',
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
          ${
            input.projectScope
              ? `<tr style="border-bottom:1px solid #E6E4DC;"><td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.scopeLabel)}</td><td style="padding:8px 0;text-align:right;">${esc(input.projectScope)}</td></tr>`
              : ''
          }
          <tr style="border-bottom:1px solid #E6E4DC;">
            <td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.totalLabel)}</td>
            <td style="padding:8px 0;text-align:right;font-weight:500;color:#F57F44;">${esc(input.totalLabel)}</td>
          </tr>
          ${
            input.validUntil
              ? `<tr><td style="padding:8px 0;color:#5C5C58;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${esc(copy.validLabel)}</td><td style="padding:8px 0;text-align:right;">${esc(input.validUntil)}</td></tr>`
              : ''
          }
        </mj-table>
        <mj-button href="${esc(input.quoteUrl)}" padding-top="20px" align="left">${esc(copy.cta)}</mj-button>
        <mj-text mj-class="muted" padding-top="20px">${esc(copy.footnote)}</mj-text>
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
