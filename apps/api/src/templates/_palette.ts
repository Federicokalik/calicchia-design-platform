import { contrast, hexToLab, PRESETS, type PresetKey } from '@calicchia/shared/palette';
import { esc } from './_compile';

/**
 * Pezzi comuni delle email della sequenza "palette-onboarding"
 * (palette-email-1/2/3): fasce colore, anteprima della palette applicata e
 * piè di pagina con la disiscrizione.
 */

export type PaletteEmailLocale = 'it' | 'en';

export interface PaletteEmailBase {
  name: string;
  locale: PaletteEmailLocale;
  /** Hex #RRGGBB della palette salvata sul lead (brand_palette.colors). */
  colors: string[];
  /** Indice del primario in `colors`. */
  primary: number;
  preset: PresetKey;
  /** Etichetta del settore curato, se la palette viene da uno. */
  sectorLabel: string | null;
  /** Link "condividi" del tool con la stessa palette. */
  shareUrl: string;
  unsubscribeUrl: string;
}

const INK = '#111111';
const WHITE = '#FFFFFF';

/**
 * Testo dei bottoni arancio del layout: il bianco di default su #F57F44 si
 * ferma a 2,6:1, il nero arriva a 7,2:1 (stesso fix del sito).
 */
export const BUTTON_INK = INK;

/** Colore del testo leggibile su `bg` (nero o bianco, il contrasto più alto). */
export function readableOn(bg: string): string {
  return contrast(bg, INK) >= contrast(bg, WHITE) ? INK : WHITE;
}

/** Ruoli minimi per l'anteprima nell'email: sfondo chiaro, testo scuro, primario. */
export function previewRoles(colors: string[], primary: number): { bg: string; text: string; primary: string; onPrimary: string } {
  const byLightness = [...colors].sort((a, b) => hexToLab(b)[0] - hexToLab(a)[0]);
  const bg = byLightness[0] ?? WHITE;
  const darkest = byLightness[byLightness.length - 1] ?? INK;
  // Testo: il colore più scuro se si legge sullo sfondo, altrimenti nero/bianco.
  const text = contrast(bg, darkest) >= 4.5 ? darkest : readableOn(bg);
  const primaryHex = colors[primary] ?? colors[0] ?? INK;
  return { bg, text, primary: primaryHex, onPrimary: readableOn(primaryHex) };
}

export function presetLabel(preset: PresetKey, locale: PaletteEmailLocale): string {
  return PRESETS[preset]?.name[locale] ?? preset;
}

/** Fasce colore con l'hex sotto ciascuna: una riga di tabella, regge anche Outlook. */
export function swatchesTable(colors: string[]): string {
  const width = Math.floor(100 / Math.max(colors.length, 1));
  const cells = colors
    .map(
      (hex) => `<td width="${width}%" style="padding:0 2px;vertical-align:top;">
        <div style="background:${esc(hex)};height:64px;border:1px solid #E6E4DC;line-height:64px;font-size:0;">&nbsp;</div>
        <div style="padding-top:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#5C5C58;text-align:center;">${esc(hex)}</div>
      </td>`,
    )
    .join('');
  return `<mj-table padding="8px 0 0" cellpadding="0" cellspacing="0" width="100%"><tr>${cells}</tr></mj-table>`;
}

/** Mini anteprima "sito" con i colori della palette: titolo, testo e bottone. */
export function palettePreview(colors: string[], primary: number, heading: string, body: string, cta: string): string {
  const r = previewRoles(colors, primary);
  return `<mj-table padding="16px 0 0" cellpadding="0" cellspacing="0" width="100%">
    <tr><td style="background:${esc(r.bg)};padding:24px;border:1px solid #E6E4DC;">
      <div style="font-size:20px;line-height:26px;font-weight:600;color:${esc(r.text)};">${esc(heading)}</div>
      <div style="padding-top:8px;font-size:14px;line-height:22px;color:${esc(r.text)};">${esc(body)}</div>
      <div style="padding-top:16px;">
        <span style="display:inline-block;background:${esc(r.primary)};color:${esc(r.onPrimary)};padding:10px 18px;font-size:14px;font-weight:500;">${esc(cta)}</span>
      </div>
    </td></tr>
  </mj-table>`;
}

/** Sezione finale con il link di disiscrizione dalla sola sequenza palette. */
export function unsubscribeSection(url: string, locale: PaletteEmailLocale): string {
  const text =
    locale === 'en'
      ? `You're receiving this because you asked for a quote with your palette. <a href="${esc(url)}">Stop these emails</a>.`
      : `Ricevi questa email perché mi hai scritto con la tua palette. <a href="${esc(url)}">Non voglio più riceverle</a>.`;
  return `<mj-section padding="16px 24px 0">
      <mj-column>
        <mj-text mj-class="muted" align="center">${text}</mj-text>
      </mj-column>
    </mj-section>`;
}
