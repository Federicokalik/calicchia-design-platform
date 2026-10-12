import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';
import { BUTTON_INK, swatchesTable, unsubscribeSection, type PaletteEmailBase } from './_palette';

/** Sequenza palette-onboarding, step 3 (+72 h): invito alla call. */
export interface PaletteEmail3Data extends PaletteEmailBase {
  /** Stessa pagina di prenotazione della sequenza audit. */
  bookingUrl: string;
}

const COPY = {
  it: {
    subject: '15 minuti sulla tua palette?',
    preview: 'Una call breve per capire come usarla sul tuo sito',
    eyebrow: 'Prossimo passo',
    title: 'Ne parliamo 15 minuti?',
    hello: (name: string) => `Ciao ${name},`,
    body:
      'Una palette da sola non porta clienti: serve un sito che la usi con criterio. Se vuoi, in 15 minuti di videochiamata guardiamo insieme dove applicarla e cosa cambierebbe sul tuo sito. Niente preventivo prima, niente impegno.',
    button: 'Scegli un orario',
    reply: 'Preferisci scrivermi? Rispondi a questa email.',
    sign: 'Federico Calicchia',
  },
  en: {
    subject: '15 minutes on your palette?',
    preview: 'A short call on how to use it on your site',
    eyebrow: 'Next step',
    title: 'Shall we talk for 15 minutes?',
    hello: (name: string) => `Hi ${name},`,
    body:
      "A palette alone doesn't bring clients: you need a site that uses it with intent. If you like, in a 15-minute video call we can look at where to apply it and what would change on your site. No quote upfront, no commitment.",
    button: 'Pick a time',
    reply: 'Rather write? Just reply to this email.',
    sign: 'Federico Calicchia',
  },
} as const;

export async function renderPaletteEmail3(data: PaletteEmail3Data): Promise<{ subject: string; html: string; text: string }> {
  const t = COPY[data.locale];
  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(t.eyebrow)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(t.title)}</mj-text>
        <mj-text padding-top="12px">${esc(t.hello(data.name))}</mj-text>
        <mj-text>${esc(t.body)}</mj-text>
        ${swatchesTable(data.colors)}
        <mj-button href="${esc(data.bookingUrl)}" align="left" padding-top="20px" color="${BUTTON_INK}">${esc(t.button)}</mj-button>
        <mj-text padding-top="12px">${esc(t.reply)}</mj-text>
        <mj-text padding-top="20px">${esc(t.sign)}</mj-text>
      </mj-column>
    </mj-section>
    ${unsubscribeSection(data.unsubscribeUrl, data.locale)}
  `;

  const compiled = await renderBrandedEmail({
    preview: t.preview,
    title: t.subject,
    sectionsMjml: sections,
    lang: data.locale,
  });
  return { subject: t.subject, ...compiled };
}
