import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { getMatrixServices, getStandaloneServices } from '@/data/services';
import { PerChiLavoro } from '@/components/seo/PerChiLavoro';
import { PageHero } from '@/components/layout/PageHero';
import { ServiziCardLink } from '@/components/service-detail/ServiziCardLink';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical } from '@/lib/canonical';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('servizi.list.metadata');
  const locale = (await getLocale()) as Locale;

  return {
    title: {
      absolute: t('title'),
    },
    description: t('description'),
    alternates: buildI18nAlternates('/servizi', locale),
    openGraph: {
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical('/servizi', locale),
    },
  };
}

export default async function ServiziIndexPage() {
  const t = await getTranslations('servizi.list');
  const locale = (await getLocale()) as Locale;
  const ALL_SERVICES = [
    ...getMatrixServices(locale),
    ...getStandaloneServices(locale),
  ];

  return (
    <>
      <PageHero
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Servizi', url: '/servizi' },
        ]}
        eyebrow={t('eyebrowWithCount', { count: ALL_SERVICES.length })}
        title={t('pageTitle')}
        intro={t('pageLead')}
        trustBadge={false}
      />

      <section className="px-6 md:px-10 lg:px-14 pb-32 max-w-[1600px] mx-auto">
        <div className="flex flex-col">
          {ALL_SERVICES.map((s, idx) => (
            <ServiziCardLink
              key={s.slug}
              href={`/servizi/${s.slug}`}
              className="group grid grid-cols-12 gap-6 py-10 md:py-14 transition-hover-color hover:bg-[var(--color-surface-elev)]"
              style={{
                borderTop: idx === 0 ? '1px solid var(--color-border)' : 'none',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <span
                className="col-span-12 md:col-span-1 font-mono text-xs pt-2"
                style={{ color: 'var(--color-link-hover)' }}
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
              <h2
                className="col-span-12 md:col-span-5 font-[family-name:var(--font-display)] text-4xl md:text-5xl"
                style={{
                  fontWeight: 500,
                  letterSpacing: '-0.025em',
                  lineHeight: 1,
                }}
              >
                {s.title}
              </h2>
              <p
                className="col-span-12 md:col-span-5 text-base leading-relaxed self-center max-w-[50ch] whitespace-pre-line text-justify"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {s.lead}
              </p>
              <span
                className="col-span-12 md:col-span-1 self-center justify-self-end text-2xl transition-hover-transform group-hover:translate-x-2"
                aria-hidden
              >
                →
              </span>
            </ServiziCardLink>
          ))}
        </div>
      </section>

      <PerChiLavoro index="02" />
    </>
  );
}
