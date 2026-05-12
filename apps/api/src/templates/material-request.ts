import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface MaterialRequestInput {
  contactName?: string | null;
  projectName: string;
  title: string;
  description?: string | null;
  uploadUrl: string;
  lang?: 'it' | 'en';
}

export function renderMaterialRequestEmail(input: MaterialRequestInput) {
  const lang = input.lang ?? 'it';
  const name = input.contactName?.trim() || '';
  const greeting = lang === 'en' ? `Hi ${name}`.trim() + ',' : `Ciao ${name}`.trim() + ',';

  const copy =
    lang === 'en'
      ? {
          subject: `Material requested — ${input.projectName}`,
          preview: `${input.title} requested for your project.`,
          headline: 'Material requested',
          intro: `For project <strong>${esc(input.projectName)}</strong> we need:`,
          cta: 'Upload material',
          fallback: 'Or open the link in your browser:',
        }
      : {
          subject: `Materiale richiesto — ${input.projectName}`,
          preview: `${input.title} richiesto per il tuo progetto.`,
          headline: 'Materiale richiesto',
          intro: `Per il progetto <strong>${esc(input.projectName)}</strong> abbiamo bisogno di:`,
          cta: 'Carica materiale',
          fallback: 'Oppure apri il link nel browser:',
        };

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(copy.headline)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(greeting)}</mj-text>
        <mj-text padding-top="12px">${copy.intro}</mj-text>
        <mj-text background-color="#FAFAF7" padding="16px" font-weight="500" container-background-color="#FAFAF7">
          ${esc(input.title)}
        </mj-text>
        ${input.description ? `<mj-text padding-top="12px">${esc(input.description).replace(/\n/g, '<br/>')}</mj-text>` : ''}
        <mj-button href="${esc(input.uploadUrl)}" padding-top="20px" align="left">${esc(copy.cta)}</mj-button>
        <mj-text mj-class="muted" padding-top="20px">${esc(copy.fallback)}<br/>
          <a href="${esc(input.uploadUrl)}" style="color:#5C5C58;word-break:break-all;">${esc(input.uploadUrl)}</a>
        </mj-text>
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
