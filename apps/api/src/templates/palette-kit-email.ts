import { esc } from './_compile';
import { renderBrandedEmail } from './_layout';
import { BUTTON_INK, swatchesTable, type PaletteEmailLocale } from './_palette';

/**
 * Email del brand kit (fase 2 del tool "Palette di settore").
 *
 *  - Conferma: va a un indirizzo non ancora verificato, quindi niente testo
 *    scritto dal visitatore (né nome né settore): solo il bottone di conferma.
 *  - Benvenuto: dopo la conferma, con il PDF allegato e il link per
 *    disiscriversi dalla newsletter.
 */

const CONFIRM = {
  it: {
    subject: 'Conferma l’iscrizione per ricevere il brand kit',
    preview: 'Un clic e ti mando il PDF della tua palette',
    eyebrow: 'Palette di settore',
    title: 'Conferma l’iscrizione alla newsletter',
    body: 'Hai chiesto il brand kit in PDF della tua palette iscrivendoti alla newsletter di Calicchia Design. Conferma con il bottone qui sotto e il PDF arriva in pochi minuti.',
    button: 'Confermo l’iscrizione',
    ignore: 'Se non sei stato tu, ignora questa email: senza conferma non ti scrivo più e i dati vengono cancellati entro 7 giorni.',
  },
  en: {
    subject: 'Confirm your subscription to get the brand kit',
    preview: 'One click and I will send you the PDF of your palette',
    eyebrow: 'Industry colour palette',
    title: 'Confirm your newsletter subscription',
    body: 'You asked for the PDF brand kit of your palette by subscribing to the Calicchia Design newsletter. Confirm with the button below and the PDF arrives within a few minutes.',
    button: 'Confirm my subscription',
    ignore: 'If this was not you, ignore this email: without confirmation I will not write again and the data is deleted within 7 days.',
  },
} as const;

const WELCOME = {
  it: {
    subject: 'Il tuo brand kit in PDF',
    preview: 'Colori, codici, contrasti e anteprime della tua palette',
    eyebrow: 'Brand kit',
    title: (name: string | null) => (name ? `Ciao ${name}, ecco il tuo brand kit` : 'Ecco il tuo brand kit'),
    body: 'In allegato trovi il PDF con i colori e i loro codici, i ruoli sul sito, la tabella dei contrasti, i caratteri dello stile e qualche anteprima: home, biglietto da visita, insegna e post.',
    reopen: 'Puoi riaprire la palette nel tool quando vuoi, cambiarla o mandarla a chi lavora con te:',
    button: 'Apri la palette',
    newsletter: 'Da ora ricevi anche la newsletter: consigli pratici su siti, branding e marketing per attività locali.',
    sign: 'Federico Calicchia',
    footer: (url: string) => `Ricevi questa email perché ti sei iscritto alla newsletter dal tool Palette di settore. <a href="${esc(url)}">Disiscriviti</a>.`,
  },
  en: {
    subject: 'Your PDF brand kit',
    preview: 'Colours, codes, contrast and previews of your palette',
    eyebrow: 'Brand kit',
    title: (name: string | null) => (name ? `Hi ${name}, here is your brand kit` : 'Here is your brand kit'),
    body: 'Attached is the PDF with your colours and their codes, their roles on a website, the contrast table, the typefaces of your style and a few previews: home page, business card, shop sign and post.',
    reopen: 'You can reopen the palette in the tool whenever you like, change it or send it to whoever works with you:',
    button: 'Open the palette',
    newsletter: 'From now on you also get the newsletter: practical tips on websites, branding and marketing for local businesses.',
    sign: 'Federico Calicchia',
    footer: (url: string) => `You are receiving this because you subscribed to the newsletter from the Industry colour palette tool. <a href="${esc(url)}">Unsubscribe</a>.`,
  },
} as const;

export async function renderPaletteKitConfirmEmail(data: {
  locale: PaletteEmailLocale;
  confirmUrl: string;
}): Promise<{ subject: string; html: string; text: string }> {
  const t = CONFIRM[data.locale];
  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(t.eyebrow)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(t.title)}</mj-text>
        <mj-text padding-top="12px">${esc(t.body)}</mj-text>
        <mj-button href="${esc(data.confirmUrl)}" align="left" padding-top="16px" color="${BUTTON_INK}">${esc(t.button)}</mj-button>
        <mj-text mj-class="muted" padding-top="20px">${esc(t.ignore)}</mj-text>
      </mj-column>
    </mj-section>
  `;
  const compiled = await renderBrandedEmail({ preview: t.preview, title: t.subject, sectionsMjml: sections, lang: data.locale });
  return { subject: t.subject, ...compiled };
}

export async function renderPaletteKitEmail(data: {
  locale: PaletteEmailLocale;
  name: string | null;
  colors: string[];
  shareUrl: string;
  unsubscribeUrl: string;
}): Promise<{ subject: string; html: string; text: string }> {
  const t = WELCOME[data.locale];
  const sections = `
    <mj-section padding="0 24px">
      <mj-column mj-class="card">
        <mj-text mj-class="eyebrow">${esc(t.eyebrow)}</mj-text>
        <mj-text mj-class="display" padding-top="4px">${esc(t.title(data.name))}</mj-text>
        <mj-text padding-top="12px">${esc(t.body)}</mj-text>
        ${swatchesTable(data.colors)}
        <mj-text padding-top="20px">${esc(t.reopen)}</mj-text>
        <mj-button href="${esc(data.shareUrl)}" align="left" padding-top="12px" color="${BUTTON_INK}">${esc(t.button)}</mj-button>
        <mj-text padding-top="20px">${esc(t.newsletter)}</mj-text>
        <mj-text padding-top="12px">${esc(t.sign)}</mj-text>
      </mj-column>
    </mj-section>
    <mj-section padding="16px 24px 0">
      <mj-column>
        <mj-text mj-class="muted" align="center">${t.footer(data.unsubscribeUrl)}</mj-text>
      </mj-column>
    </mj-section>
  `;
  const compiled = await renderBrandedEmail({ preview: t.preview, title: t.subject, sectionsMjml: sections, lang: data.locale });
  return { subject: t.subject, ...compiled };
}
