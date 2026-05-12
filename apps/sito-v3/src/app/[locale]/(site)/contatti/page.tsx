import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { SITE } from '@/data/site';
import { ContactFormClient } from '@/components/forms/ContactFormClient';
import { ContactSocials } from '@/components/contatti/ContactSocials';
import { PageHero } from '@/components/layout/PageHero';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical } from '@/lib/canonical';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('contatti.metadata');
  const locale = (await getLocale()) as Locale;

  return {
    title: {
      absolute: t('title'),
    },
    description: t('description'),
    alternates: buildI18nAlternates('/contatti', locale),
    openGraph: {
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical('/contatti', locale),
    },
  };
}

export default function ContattiPage() {
  return (
    <>
      <PageHero
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Contatti', url: '/contatti' },
        ]}
        eyebrow="Studio - Ceccano FR"
        title="Contatti. Niente PowerPoint, niente promesse vuote."
        intro="Una chiamata di 30 minuti per capire se ha senso lavorare insieme. Web Designer & Developer Freelance a Ceccano (FR) — siti, e-commerce, sviluppo, SEO, WordPress. Risposta entro 24 ore. Niente impegno, niente presentazioni in PowerPoint."
        actions={[
          { label: 'Prenota una call', href: SITE.contact.cal, variant: 'primary' },
          { label: 'Scrivimi', href: `mailto:${SITE.contact.email}`, variant: 'underline' },
        ]}
      />

      <section className="px-6 md:px-10 lg:px-14 pb-32 max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-12">
          <div className="md:col-span-7">
            <Suspense fallback={<div className="py-12" aria-hidden style={{ minHeight: 480 }} />}>
              <ContactFormClient />
            </Suspense>
          </div>

          <aside className="md:col-span-4 md:col-start-9 flex flex-col gap-8">
            <div className="flex flex-col gap-2">
              <span
                className="text-xs uppercase tracking-[0.18em]"
                style={{ color: 'var(--color-ink-subtle)' }}
              >
                Email
              </span>
              <a
                href={`mailto:${SITE.contact.email}`}
                className="text-lg hover:[color:var(--color-accent-deep)] transition-colors"
              >
                {SITE.contact.email}
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <span
                className="text-xs uppercase tracking-[0.18em]"
                style={{ color: 'var(--color-ink-subtle)' }}
              >
                Telefono
              </span>
              <a
                href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`}
                className="text-lg hover:[color:var(--color-accent-deep)] transition-colors"
              >
                {SITE.contact.phone}
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <span
                className="text-xs uppercase tracking-[0.18em]"
                style={{ color: 'var(--color-ink-subtle)' }}
              >
                Indirizzo
              </span>
              <p className="text-base" style={{ color: 'var(--color-ink-muted)' }}>
                {SITE.contact.address}
              </p>
              <p className="text-sm" style={{ color: 'var(--color-ink-subtle)' }}>
                {SITE.contact.vat}
              </p>
            </div>
          </aside>
        </div>
      </section>

      <ContactSocials />
    </>
  );
}
