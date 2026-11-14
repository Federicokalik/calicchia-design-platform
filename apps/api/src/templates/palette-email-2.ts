import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';
import { BUTTON_INK, swatchesTable, unsubscribeSection, type PaletteEmailBase } from './_palette';

/** Caso studio scelto dal job (progetto pubblicato), null se non ce ne sono. */
export interface PaletteCaseStudy {
  title: string;
  description: string | null;
  url: string;
}

/** Sequenza palette-onboarding, step 2 (+48 h): un caso studio pertinente. */
export interface PaletteEmail2Data extends PaletteEmailBase {
  caseStudy: PaletteCaseStudy | null;
  /** Pagina di tutti i lavori (/lavori, /en/works). */
  worksUrl: string;
}

const COPY = {
  it: {
    subject: 'Dalla palette al sito: un esempio',
    preview: 'Come i colori diventano un sito che porta contatti',
    eyebrow: 'Caso studio',
    hello: (name: string) => `Ciao ${name},`,
    title: 'I colori sono il punto di partenza, non il risultato',
    intro:
      'Una palette funziona quando ogni colore ha un compito: lo sfondo fa respirare, il testo si legge, il primario dice dove cliccare. Ecco un progetto in cui abbiamo lavorato proprio così.',
    fallback: 'Nei miei lavori trovi siti in cui i colori hanno un compito preciso: guidare verso il contatto.',
    cta: 'Leggi il caso studio',
    all: 'Vedi tutti i lavori',
    yours: 'Per riferimento, la tua palette:',
    sign: 'Federico Calicchia',
  },
  en: {
    subject: 'From palette to website: an example',
    preview: 'How colours become a site that brings enquiries',
    eyebrow: 'Case study',
    hello: (name: string) => `Hi ${name},`,
    title: 'Colours are the starting point, not the result',
    intro:
      'A palette works when every colour has a job: the background lets the page breathe, the text stays readable, the primary says where to click. Here is a project where we worked exactly like that.',
    fallback: 'In my work you will find sites where colour has a precise job: leading people to get in touch.',
    cta: 'Read the case study',
    all: 'See all projects',
    yours: 'For reference, your palette:',
    sign: 'Federico Calicchia',
  },
} as const;

export async function renderPaletteEmail2(data: PaletteEmail2Data): Promise<{ subject: string; html: string; text: string }> {
  const t = COPY[data.locale];
  const cs = data.caseStudy;
  const caseBlock = cs
    ? `<mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" />
        <mj-text font-weight="600" font-size="16px">${esc(cs.title)}</mj-text>
        ${cs.description ? `<mj-text padding-top="4px">${esc(cs.description)}</mj-text>` : ''}
        <mj-button href="${esc(cs.url)}" align="left" padding-top="12px" color="${BUTTON_INK}">${esc(t.cta)}</mj-button>
        <mj-text padding-top="8px"><a href="${esc(data.worksUrl)}">${esc(t.all)}</a></mj-text>`
    : `<mj-button href="${esc(data.worksUrl)}" align="left" padding-top="12px" color="${BUTTON_INK}">${esc(t.all)}</mj-button>`;

  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(t.eyebrow)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(t.title)}</mj-text>
        <mj-text padding-top="12px">${esc(t.hello(data.name))}</mj-text>
        <mj-text>${esc(cs ? t.intro : t.fallback)}</mj-text>
        ${caseBlock}
        <mj-divider border-color="#E6E4DC" border-width="1px" padding="16px 0" />
        <mj-text mj-class="muted">${esc(t.yours)}</mj-text>
        ${swatchesTable(data.colors)}
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
