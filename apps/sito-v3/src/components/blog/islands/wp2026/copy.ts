import type { Locale } from '@/lib/i18n';

/**
 * Data + copy for the "WordPress nel 2026" article islands.
 * Figures come from the article sources (W3Techs, HTTP Archive, Patchstack,
 * Wordfence, Automattic contribution logs) — keep them in sync with the text
 * stored in blog_posts / blog_posts_translations.
 */

export interface BarDatum {
  label: string;
  /** Signed value in the chart's unit. */
  value: number;
  /** Text shown next to the bar. */
  display: string;
  tone?: 'ink' | 'accent' | 'hatch';
}

export interface BarChartSpec {
  title: string;
  caption: string;
  /** diverging = bars grow left/right from a centre zero line. */
  diverging?: boolean;
  /** Absolute value mapped to a full-length bar (half-length when diverging). */
  max: number;
  bars: BarDatum[];
  axis?: [string, string, string];
  legend?: { label: string; tone: 'ink' | 'accent' | 'hatch' }[];
}

export interface SharePoint {
  value: number;
  display: string;
  label: string;
}

interface Wp2026Copy {
  share: {
    title: string;
    caption: string;
    ariaLabel: string;
    points: SharePoint[];
    footLeft: string;
    footRight: string;
  };
  ecommerce: BarChartSpec;
  coreHours: BarChartSpec;
  cwv: BarChartSpec;
  waffle: {
    title: string;
    caption: string;
    ariaLabel: string;
    plugins: string;
    rest: string;
  };
  picker: {
    eyebrow: string;
    resultLabel: string;
    questions: {
      name: 'chi' | 'shop' | 'logica' | 'host';
      legend: string;
      options: { value: string; label: string }[];
    }[];
  };
}

const IT: Wp2026Copy = {
  share: {
    title: 'Quota di WordPress su tutti i siti web',
    caption: 'Rilevazioni W3Techs',
    ariaLabel:
      'Quota di WordPress: 43,6% a metà 2025, 43,2% a dicembre 2025, 41,9% a maggio 2026.',
    points: [
      { value: 43.6, display: '43,6%', label: 'picco, metà 2025' },
      { value: 43.2, display: '43,2%', label: 'dicembre 2025' },
      { value: 41.9, display: '41,9%', label: 'maggio 2026' },
    ],
    footLeft: 'Tre rilevazioni documentate, nessun dato interpolato.',
    footRight: "−1,3 punti in sei mesi: il doppio del calo dell'intero 2025.",
  },
  ecommerce: {
    title: 'Variazione annua dei siti rilevati per piattaforma e-commerce',
    caption: 'HTTP Archive, origin mobile, maggio 2026',
    diverging: true,
    max: 20,
    bars: [
      { label: 'Shopify', value: 11.7, display: '+11,7%', tone: 'accent' },
      { label: 'WooCommerce', value: -6.8, display: '−6,8%' },
      { label: 'PrestaShop', value: -16, display: '−16%' },
      { label: 'Magento', value: -19, display: '−19%' },
    ],
    axis: ['−20%', '0', '+20%'],
  },
  coreHours: {
    title: 'Ore settimanali di Automattic sul core di WordPress',
    caption: 'Prima e dopo il taglio di gennaio 2025',
    max: 3539,
    bars: [
      { label: '1 gen 2025', value: 3539, display: '3.539 h' },
      { label: 'Dopo il taglio', value: 45, display: 'circa 45 h', tone: 'accent' },
    ],
  },
  cwv: {
    title: 'Siti che superano i Core Web Vitals su mobile',
    caption:
      'Le barre tratteggiate vengono da analisi secondarie sugli stessi dati CrUX, non da HTTP Archive direttamente',
    max: 100,
    bars: [
      { label: 'Next.js', value: 68, display: '68%', tone: 'hatch' },
      { label: 'Astro', value: 60, display: '~60%', tone: 'hatch' },
      { label: 'WordPress', value: 46, display: '46%' },
    ],
    legend: [
      { label: 'HTTP Archive', tone: 'ink' },
      { label: 'Analisi secondarie', tone: 'hatch' },
    ],
  },
  waffle: {
    title: 'Dove nascono le vulnerabilità di WordPress',
    caption: "Ogni quadrato vale l'1% delle vulnerabilità scoperte nel 2024",
    ariaLabel: '96 per cento nei plugin, il restante 4 per cento tra temi e core.',
    plugins: 'Plugin: 96%',
    rest: 'Temi e core: 4%',
  },
  picker: {
    eyebrow: 'Quattro domande',
    resultLabel: 'Punto di partenza consigliato',
    questions: [
      {
        name: 'chi',
        legend: 'Chi aggiornerà i contenuti?',
        options: [
          { value: 'cliente', label: 'Io o il mio staff, spesso' },
          { value: 'dev', label: 'Lo sviluppatore, di rado' },
        ],
      },
      {
        name: 'shop',
        legend: 'Serve vendere online?',
        options: [
          { value: 'no', label: 'No' },
          { value: 'piccolo', label: 'Sì, catalogo contenuto' },
          { value: 'grande', label: 'Sì, catalogo ampio o marketplace' },
        ],
      },
      {
        name: 'logica',
        legend: 'Quanta logica su misura serve?',
        options: [
          { value: 'nessuna', label: 'Nessuna, solo contenuti' },
          { value: 'media', label: 'Qualche integrazione o area riservata' },
          { value: 'core', label: 'È il cuore del progetto' },
        ],
      },
      {
        name: 'host',
        legend: 'Che hosting è previsto?',
        options: [
          { value: 'condiviso', label: 'Hosting condiviso' },
          { value: 'vps', label: 'VPS o cloud' },
        ],
      },
    ],
  },
};

const EN: Wp2026Copy = {
  share: {
    title: 'WordPress share of all websites',
    caption: 'W3Techs surveys',
    ariaLabel:
      'WordPress share: 43.6% in mid-2025, 43.2% in December 2025, 41.9% in May 2026.',
    points: [
      { value: 43.6, display: '43.6%', label: 'peak, mid-2025' },
      { value: 43.2, display: '43.2%', label: 'December 2025' },
      { value: 41.9, display: '41.9%', label: 'May 2026' },
    ],
    footLeft: 'Three documented surveys, no interpolated data.',
    footRight: '−1.3 points in six months: twice the drop of the whole of 2025.',
  },
  ecommerce: {
    title: 'Year-on-year change in detected sites by e-commerce platform',
    caption: 'HTTP Archive, mobile origins, May 2026',
    diverging: true,
    max: 20,
    bars: [
      { label: 'Shopify', value: 11.7, display: '+11.7%', tone: 'accent' },
      { label: 'WooCommerce', value: -6.8, display: '−6.8%' },
      { label: 'PrestaShop', value: -16, display: '−16%' },
      { label: 'Magento', value: -19, display: '−19%' },
    ],
    axis: ['−20%', '0', '+20%'],
  },
  coreHours: {
    title: 'Weekly hours Automattic pledged to WordPress core',
    caption: 'Before and after the January 2025 cut',
    max: 3539,
    bars: [
      { label: 'Jan 1, 2025', value: 3539, display: '3,539 h' },
      { label: 'After the cut', value: 45, display: 'about 45 h', tone: 'accent' },
    ],
  },
  cwv: {
    title: 'Sites passing Core Web Vitals on mobile',
    caption:
      'Hatched bars come from secondary analyses of the same CrUX data, not from HTTP Archive directly',
    max: 100,
    bars: [
      { label: 'Next.js', value: 68, display: '68%', tone: 'hatch' },
      { label: 'Astro', value: 60, display: '~60%', tone: 'hatch' },
      { label: 'WordPress', value: 46, display: '46%' },
    ],
    legend: [
      { label: 'HTTP Archive', tone: 'ink' },
      { label: 'Secondary analyses', tone: 'hatch' },
    ],
  },
  waffle: {
    title: 'Where WordPress vulnerabilities come from',
    caption: 'Each square is 1% of the vulnerabilities disclosed in 2024',
    ariaLabel: '96 percent in plugins, the remaining 4 percent in themes and core.',
    plugins: 'Plugins: 96%',
    rest: 'Themes and core: 4%',
  },
  picker: {
    eyebrow: 'Four questions',
    resultLabel: 'Suggested starting point',
    questions: [
      {
        name: 'chi',
        legend: 'Who will update the content?',
        options: [
          { value: 'cliente', label: 'Me or my staff, often' },
          { value: 'dev', label: 'The developer, rarely' },
        ],
      },
      {
        name: 'shop',
        legend: 'Do you need to sell online?',
        options: [
          { value: 'no', label: 'No' },
          { value: 'piccolo', label: 'Yes, a small catalogue' },
          { value: 'grande', label: 'Yes, a large catalogue or marketplaces' },
        ],
      },
      {
        name: 'logica',
        legend: 'How much custom logic is needed?',
        options: [
          { value: 'nessuna', label: 'None, just content' },
          { value: 'media', label: 'Some integrations or a members area' },
          { value: 'core', label: "It's the heart of the project" },
        ],
      },
      {
        name: 'host',
        legend: 'What hosting is planned?',
        options: [
          { value: 'condiviso', label: 'Shared hosting' },
          { value: 'vps', label: 'VPS or cloud' },
        ],
      },
    ],
  },
};

export function wp2026Copy(locale: Locale): Wp2026Copy {
  return locale === 'en' ? EN : IT;
}
