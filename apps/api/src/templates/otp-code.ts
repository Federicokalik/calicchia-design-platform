import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface OtpCodeEmailInput {
  code: string;
  expiresMinutes: number;
  lang?: 'it' | 'en';
}

export function renderOtpCodeEmail(input: OtpCodeEmailInput) {
  const lang = input.lang ?? 'it';

  const copy =
    lang === 'en'
      ? {
          subject: 'Your verification code',
          preview: `Code valid ${input.expiresMinutes} minutes.`,
          headline: 'Verification code',
          intro: `Use the code below to continue. Valid for ${input.expiresMinutes} minutes.`,
          codeLabel: 'Code',
          footnote: 'If you did not request this code, you can ignore this email.',
        }
      : {
          subject: 'Il tuo codice di verifica',
          preview: `Codice valido ${input.expiresMinutes} minuti.`,
          headline: 'Codice di verifica',
          intro: `Usa il codice qui sotto per continuare. Valido ${input.expiresMinutes} minuti.`,
          codeLabel: 'Codice',
          footnote: 'Se non hai richiesto tu il codice, ignora questa email.',
        };

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(copy.headline)}</mj-text>
        <mj-text padding-top="12px">${esc(copy.intro)}</mj-text>
        <mj-text mj-class="muted" padding-top="20px">${esc(copy.codeLabel)}</mj-text>
        <mj-text font-family="ui-monospace, Menlo, Consolas, monospace" font-size="28px" font-weight="500" letter-spacing="6px" color="#F57F44" padding-top="4px">
          ${esc(input.code)}
        </mj-text>
        <mj-text mj-class="muted" padding-top="24px">${esc(copy.footnote)}</mj-text>
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
