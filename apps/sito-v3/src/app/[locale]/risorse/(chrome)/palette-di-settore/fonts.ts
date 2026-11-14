import localFont from 'next/font/local';
import type { FontKey } from '@calicchia/shared/palette';

/**
 * Font dei quattro stili del tool "Palette di settore", self-hosted.
 *
 * Nessuna richiesta a fonts.googleapis.com / fonts.gstatic.com (vedi
 * GDPR-COMPLIANCE.md). I woff2 in `public/fonts/palette/` sono istanze
 * statiche dei TTF OFL di github.com/google/fonts, ridotte ai blocchi
 * latin + latin-ext (fontTools); le licenze sono in `licenses/`. Fraunces
 * resta variabile sull'asse opsz, con il peso fisso a 500.
 *
 * `preload: false`: servono solo all'anteprima, non al primo paint. Le
 * classi `.variable` vanno applicate alla sola radice del tool, così le
 * variabili non escono da questa pagina.
 */

const nunito = localFont({
  src: '../../../../../../public/fonts/palette/nunito-800.woff2',
  weight: '800',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--pf-nunito',
});

const nunitoSans = localFont({
  src: [
    { path: '../../../../../../public/fonts/palette/nunito-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../../../../../../public/fonts/palette/nunito-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  variable: '--pf-nunito-sans',
});

const schibstedGrotesk = localFont({
  src: '../../../../../../public/fonts/palette/schibsted-grotesk-700.woff2',
  weight: '700',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--pf-schibsted-grotesk',
});

const albertSans = localFont({
  src: [
    { path: '../../../../../../public/fonts/palette/albert-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../../../../../../public/fonts/palette/albert-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  variable: '--pf-albert-sans',
});

const fraunces = localFont({
  src: '../../../../../../public/fonts/palette/fraunces-opsz-500.woff2',
  weight: '500',
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Times New Roman',
  variable: '--pf-fraunces',
});

const instrumentSans = localFont({
  src: [
    { path: '../../../../../../public/fonts/palette/instrument-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../../../../../../public/fonts/palette/instrument-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  variable: '--pf-instrument-sans',
});

const ibmPlexSansCondensed = localFont({
  src: '../../../../../../public/fonts/palette/ibm-plex-sans-condensed-700.woff2',
  weight: '700',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--pf-ibm-plex-sans-condensed',
});

const ibmPlexSans = localFont({
  src: [
    { path: '../../../../../../public/fonts/palette/ibm-plex-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../../../../../../public/fonts/palette/ibm-plex-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  variable: '--pf-ibm-plex-sans',
});

const ibmPlexMono = localFont({
  src: '../../../../../../public/fonts/palette/ibm-plex-mono-500.woff2',
  weight: '500',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--pf-ibm-plex-mono',
});

/** Classi `.variable` da mettere sulla radice del tool. */
export const paletteFontsClassName = [
  nunito,
  nunitoSans,
  schibstedGrotesk,
  albertSans,
  fraunces,
  instrumentSans,
  ibmPlexSansCondensed,
  ibmPlexSans,
  ibmPlexMono,
]
  .map((f) => f.variable)
  .join(' ');

/** FontKey del motore → variabile CSS definita qui sopra. */
export const PALETTE_FONT_VARS: Record<FontKey, string> = {
  nunito: '--pf-nunito',
  'nunito-sans': '--pf-nunito-sans',
  'schibsted-grotesk': '--pf-schibsted-grotesk',
  'albert-sans': '--pf-albert-sans',
  fraunces: '--pf-fraunces',
  'instrument-sans': '--pf-instrument-sans',
  'ibm-plex-sans-condensed': '--pf-ibm-plex-sans-condensed',
  'ibm-plex-sans': '--pf-ibm-plex-sans',
  'ibm-plex-mono': '--pf-ibm-plex-mono',
};
