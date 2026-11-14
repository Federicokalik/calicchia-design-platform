import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';
import { BUTTON_INK, palettePreview, presetLabel, swatchesTable, unsubscribeSection, type PaletteEmailBase } from './_palette';

/** Sequenza palette-onboarding, step 1 (subito): la palette del lead applicata. */
export type PaletteEmail1Data = PaletteEmailBase;

const COPY = {
  it: {
    subject: 'La tua palette, applicata',
    preview: 'I colori che hai scelto, su un sito vero',
    eyebrow: 'La tua palette',
    title: (name: string) => `Ciao ${name}, ecco i tuoi colori al lavoro`,
    intro: (style: string, sector: string | null) =>
      `Ho ricevuto il tuo messaggio con la palette${sector ? ` per ${sector}` : ''} in stile ${style.toLowerCase()}. Te la rimando qui sotto applicata a un pezzo di pagina: sfondo, testo e bottone principale.`,
    previewHeading: 'Il titolo della tua home',
    previewBody: 'Due righe che spiegano cosa fai e per chi. I colori fanno il resto.',
    previewCta: 'Prenota ora',
    note: 'Nei prossimi giorni ti scrivo come la userei sul tuo sito. Intanto puoi riaprirla, cambiarla o mandarla a chi lavora con te:',
    button: 'Apri la palette',
    sign: 'Federico Calicchia',
  },
  en: {
    subject: 'Your palette, applied',
    preview: 'The colours you picked, on a real page',
    eyebrow: 'Your palette',
    title: (name: string) => `Hi ${name}, here are your colours at work`,
    intro: (style: string, sector: string | null) =>
      `I got your message with the palette${sector ? ` for ${sector}` : ''} in the ${style.toLowerCase()} style. Here it is applied to a slice of a page: background, text and main button.`,
    previewHeading: 'Your homepage headline',
    previewBody: 'Two lines on what you do and who it is for. The colours do the rest.',
    previewCta: 'Book now',
    note: "Over the next few days I'll show you how I'd use it on your site. Meanwhile you can reopen it, tweak it or send it to whoever works with you:",
    button: 'Open the palette',
    sign: 'Federico Calicchia',
  },
} as const;

export async function renderPaletteEmail1(data: PaletteEmail1Data): Promise<{ subject: string; html: string; text: string }> {
  const t = COPY[data.locale];
  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(t.eyebrow)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(t.title(data.name))}</mj-text>
        <mj-text padding-top="12px">${esc(t.intro(presetLabel(data.preset, data.locale), data.sectorLabel))}</mj-text>
        ${swatchesTable(data.colors)}
        ${palettePreview(data.colors, data.primary, t.previewHeading, t.previewBody, t.previewCta)}
        <mj-text padding-top="20px">${esc(t.note)}</mj-text>
        <mj-button href="${esc(data.shareUrl)}" align="left" padding-top="12px" color="${BUTTON_INK}">${esc(t.button)}</mj-button>
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
