import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { SmoothScrollProvider } from '@/components/providers/SmoothScrollProvider';
import { ViewTransitionsBootstrap } from '@/components/providers/ViewTransitionsBootstrap';
import { MorphTicker } from '@/components/layout/MorphTicker';
import { LanguagePromptBanner } from '@/components/layout/LanguagePromptBanner';
import { StructuredData } from '@/components/seo/StructuredData';
import { personSchema, localBusinessSchema, websiteSchema } from '@/data/structured-data';
import { SITE } from '@/data/site';
import './globals.css';

// next/font/local — Funnel Display + Funnel Sans self-hosted con preload
// automatico, size-adjust per minimizzare CLS, hashing static asset.
// Sostituisce i preload manuali e le @font-face in styles/fonts.css.
const funnelDisplay = localFont({
  src: [
    { path: '../../public/fonts/funnel-display-latin.woff2', weight: '300 800', style: 'normal' },
    { path: '../../public/fonts/funnel-display-latin-ext.woff2', weight: '300 800', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
  preload: true,
});

const funnelSans = localFont({
  src: [
    { path: '../../public/fonts/funnel-sans-normal-latin.woff2', weight: '300 800', style: 'normal' },
    { path: '../../public/fonts/funnel-sans-normal-latin-ext.woff2', weight: '300 800', style: 'normal' },
    { path: '../../public/fonts/funnel-sans-italic-latin.woff2', weight: '300 800', style: 'italic' },
    { path: '../../public/fonts/funnel-sans-italic-latin-ext.woff2', weight: '300 800', style: 'italic' },
  ],
  variable: '--font-sans',
  display: 'swap',
  preload: true,
});

const OG_DEFAULT = `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.brand} — ${SITE.legalName}`,
    template: `%s — ${SITE.brand}`,
  },
  description: SITE.description,
  applicationName: SITE.brand,
  authors: [{ name: SITE.legalName, url: SITE.url }],
  creator: SITE.legalName,
  openGraph: {
    type: 'website',
    locale: 'it_IT',
    url: SITE.url,
    siteName: SITE.brand,
    title: `${SITE.brand} — ${SITE.legalName}`,
    description: SITE.description,
    images: [
      {
        url: OG_DEFAULT,
        width: 1200,
        height: 630,
        alt: 'Federico Calicchia — Web Designer & Developer Freelance',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    creator: '@calicchiadesign',
    title: `${SITE.brand} — ${SITE.legalName}`,
    description: SITE.description,
    images: [OG_DEFAULT],
  },
  robots: { index: true, follow: true },
  verification: {
    // Add when you have the codes:
    // google: '...',
  },
};

export const viewport: Viewport = {
  themeColor: '#FAFAF7',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Locale + messages letti da next-intl (configurato in src/i18n/request.ts).
  // `getLocale()` legge il segment `[locale]` del path corrente o default.
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={`${funnelDisplay.variable} ${funnelSans.variable}`}>
      <head>
        {/* Phosphor CDN rimosso (F4.5 audit 2026-05-08): le classi "ph-*"
            nei file dati (services-content/*, seo-professions, seo-content/*)
            sono metadata orfane non renderizzate da nessun componente React.
            Le icone effettivamente in uso (MenuOverlay, FinalCTA, etc.) sono
            importate come componenti da `@phosphor-icons/react` con tree-shake
            via experimental.optimizePackageImports in next.config.ts. */}
      </head>
      <body suppressHydrationWarning>
        {/* Schema globali — Person, ProfessionalService (LocalBusiness),
            WebSite. Iniettati una volta sola per tutto il sito; le pagine
            specifiche aggiungono i propri schemi (Article, FAQPage, Breadcrumb). */}
        <StructuredData json={[personSchema(), localBusinessSchema(), websiteSchema()]} />

        <NextIntlClientProvider locale={locale} messages={messages}>
          <LanguagePromptBanner />
          <SmoothScrollProvider>
            <ViewTransitionsBootstrap />
            {children}
            {/* Swiss compliance unification 2026-05-09: MorphTicker e' la
                SOLA CTA bottom-right (responsive: pill horizontale su desktop,
                bottom sheet su mobile). Sostituisce ServiceFinderTrigger +
                ServiceFinderMobile rimossi. Master eccezione: "fixed
                consentiti solo per modali funzionali e CTA/finder bottom-right
                documentato" (singolare). */}
            <MorphTicker />
          </SmoothScrollProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
