import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';

export interface MagicLinkInput {
  contactName?: string | null;
  link: string;
  expiresMinutes: number;
  lang?: 'it' | 'en';
}

export function renderMagicLinkEmail(input: MagicLinkInput) {
  const lang = input.lang ?? 'it';
  const name = input.contactName?.trim() || '';
  const greeting = lang === 'en' ? `Hi ${name}`.trim() + ',' : `Ciao ${name}`.trim() + ',';

  const copy =
    lang === 'en'
      ? {
          subject: 'Sign in to your client area — Calicchia Design',
          preview: `Your sign-in link expires in ${input.expiresMinutes} minutes.`,
          intro: `You requested access to your client area. Tap the button below to sign in. The link expires in ${input.expiresMinutes} minutes and works only once.`,
          cta: 'Sign in',
          fallback: 'If the button does not work, copy and paste this URL into your browser:',
          footnote: `If you did not request this, you can ignore this email. Link valid ${input.expiresMinutes} min.`,
        }
      : {
          subject: 'Accesso area clienti — Calicchia Design',
          preview: `Il tuo link di accesso scade tra ${input.expiresMinutes} minuti.`,
          intro: `Hai richiesto l'accesso all'area clienti. Clicca il pulsante per entrare. Il link scade tra ${input.expiresMinutes} minuti e funziona una sola volta.`,
          cta: 'Accedi al portale',
          fallback: 'Se il pulsante non funziona, copia e incolla questo URL nel browser:',
          footnote: `Se non hai richiesto tu l'accesso, puoi ignorare questa email. Link valido ${input.expiresMinutes} min.`,
        };

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="display">${esc(greeting)}</mj-text>
        <mj-text padding-top="12px">${esc(copy.intro)}</mj-text>
        <mj-button href="${esc(input.link)}" padding-top="20px" padding-bottom="8px" align="left">
          ${esc(copy.cta)}
        </mj-button>
        <mj-text mj-class="muted" padding-top="16px">${esc(copy.footnote)}</mj-text>
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="20px 0" />
        <mj-text mj-class="muted">${esc(copy.fallback)}</mj-text>
        <mj-text mj-class="muted" padding-top="4px">
          <a href="${esc(input.link)}" style="color:#5C5C58;word-break:break-all;">${esc(input.link)}</a>
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
