import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface ReportPublishedInput {
  contactName?: string | null;
  reportTitle: string;
  period: string;
  summary?: string | null;
  reportUrl: string;
  lang?: 'it' | 'en';
}

export function renderReportPublishedEmail(input: ReportPublishedInput) {
  const lang = input.lang ?? 'it';
  const name = input.contactName?.trim() || '';
  const greeting = lang === 'en' ? `Hi ${name}`.trim() + ',' : `Ciao ${name}`.trim() + ',';

  const copy =
    lang === 'en'
      ? {
          subject: `New report — ${input.reportTitle}`,
          preview: `Your ${input.period} report is ready.`,
          headline: 'New report',
          intro: `The report for <strong>${esc(input.period)}</strong> is now available in your client area.`,
          cta: 'View report',
        }
      : {
          subject: `Nuovo report — ${input.reportTitle}`,
          preview: `Il report di ${input.period} è pronto.`,
          headline: 'Nuovo report',
          intro: `Il report per <strong>${esc(input.period)}</strong> è disponibile in area clienti.`,
          cta: 'Apri report',
        };

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(copy.headline)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(greeting)}</mj-text>
        <mj-text padding-top="12px">${copy.intro}</mj-text>
        <mj-text padding-top="12px" font-weight="500">${esc(input.reportTitle)}</mj-text>
        ${input.summary ? `<mj-text mj-class="muted" padding-top="6px">${esc(input.summary).replace(/\n/g, '<br/>')}</mj-text>` : ''}
        <mj-button href="${esc(input.reportUrl)}" padding-top="20px" align="left">${esc(copy.cta)}</mj-button>
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
