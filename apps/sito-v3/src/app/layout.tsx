import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { SmoothScrollProvider } from '@/components/providers/SmoothScrollProvider';
import { ViewTransitionsBootstrap } from '@/components/providers/ViewTransitionsBootstrap';
import { RuntimeConfigProvider } from '@/lib/runtime-config';
import { SiteConfigProvider } from '@/lib/use-site-config';
import { MorphTicker } from '@/components/layout/MorphTicker';
import { LanguagePromptBanner } from '@/components/layout/LanguagePromptBanner';
import { AvailabilityTopbar } from '@/components/layout/AvailabilityTopbar';
import { StructuredData } from '@/components/seo/StructuredData';
import { LLMHint } from '@/components/seo/LLMHint';
import { personSchema, localBusinessSchema, websiteSchema, siteNavigationSchema } from '@/data/structured-data';
import { SITE } from '@/data/site';
import { getSiteConfig } from '@/lib/site-config';
import { getServiceCatalog } from '@/lib/cms';
import type { Locale } from '@/lib/i18n';
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

// Audit C-013/C-014: root metadata via generateMetadata. description/contact
// surfaces come from getSiteConfig() (DB → file fallback), but the title
// template, brand and tagline are SEO-load-bearing and hardcoded to SITE so
// they can never be corrupted by an editable admin setting.
// SITE.url stays from the file because it's the deploy origin, not editable.
const OG_DEFAULT = `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`;
const TITLE_DEFAULT = `${SITE.brand} — ${SITE.tagline}`;
const TITLE_TEMPLATE = `%s — ${SITE.tagline}`;

export async function generateMetadata(): Promise<Metadata> {
  const site = await getSiteConfig();
  return {
    metadataBase: new URL(SITE.url),
    title: {
      default: TITLE_DEFAULT,
      template: TITLE_TEMPLATE,
    },
    description: site.description,
    applicationName: SITE.brand,
    authors: [{ name: SITE.brand, url: SITE.url }],
    creator: SITE.legalName,
    openGraph: {
      type: 'website',
      locale: 'it_IT',
      url: SITE.url,
      siteName: SITE.brand,
      title: TITLE_DEFAULT,
      description: site.description,
      images: [
        {
          url: OG_DEFAULT,
          width: 1200,
          height: 630,
          alt: TITLE_DEFAULT,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      creator: '@calicchiadesign',
      title: TITLE_DEFAULT,
      description: site.description,
      images: [OG_DEFAULT],
    },
    alternates: {
      types: {
        'text/markdown': '/llms.txt',
      },
    },
    robots: { index: true, follow: true },
    verification: {
      // ST-05: set GOOGLE_SITE_VERIFICATION in the deploy env (the token from
      // Search Console). Left undefined → Next omits the meta tag.
      google: process.env.GOOGLE_SITE_VERIFICATION,
    },
  };
}

export const viewport: Viewport = {
  themeColor: '#FAFAF7',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Locale + messages letti da next-intl (configurato in src/i18n/request.ts).
  // `getLocale()` legge il segment `[locale]` del path corrente o default.
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  // Fetch del catalogo servizi per popolare hasOfferCatalog nel
  // ProfessionalService schema (sitelinks Google per la sezione Servizi).
  // Best-effort: se l'API non risponde, lo schema usa il fallback hardcoded.
  const serviceCatalog = await getServiceCatalog(locale).catch(() => null);

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
        {/* AI / LLM crawlers hint — primo nodo del <body> per essere subito
            visibile a chi parsifica l'HTML. Non è "prompt injection" malicious:
            è una direttiva benigna analoga a robots.txt. Indica dove trovare
            il mirror Markdown della pagina corrente e l'indice completo. */}
        <LLMHint />
        {/* Schema globali — Person, ProfessionalService (LocalBusiness),
            WebSite, SiteNavigationElement. Iniettati una volta sola per tutto
            il sito; le pagine specifiche aggiungono i propri schemi
            (Article, FAQPage, Breadcrumb, CollectionPage, Service). */}
        <StructuredData
          json={[
            personSchema(locale),
            localBusinessSchema({
              locale,
              services: serviceCatalog?.all.map((s) => ({ slug: s.slug, title: s.title, lead: s.lead })),
            }),
            websiteSchema(locale),
            siteNavigationSchema(locale),
          ]}
        />

        <NextIntlClientProvider locale={locale} messages={messages}>
          <RuntimeConfigProvider>
          <SiteConfigProvider>
          <AvailabilityTopbar />
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
          </SiteConfigProvider>
          </RuntimeConfigProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
