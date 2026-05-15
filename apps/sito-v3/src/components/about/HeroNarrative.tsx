import Image from 'next/image';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { localizedPath } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';

export async function HeroNarrative() {
  const t = await getTranslations('perche.heroNarrative');
  const locale = (await getLocale()) as Locale;

  const breadcrumbs = [
    { name: t('breadcrumbHome'), url: localizedPath('/', locale) },
    { name: t('breadcrumbCurrent'), url: localizedPath('/perche-scegliere-me', locale) },
  ];

  return (
    <section
      className="relative overflow-hidden px-6 md:px-10 lg:px-14 pt-32 md:pt-40 pb-24 md:pb-32 max-w-[1600px] mx-auto"
      style={{ background: 'var(--color-bg)', color: 'var(--color-ink)' }}
    >
      <Breadcrumbs items={breadcrumbs} className="mb-8" />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-14">
        {/* Colonna sinistra: H1 + body + CTA, poi 01/02/03 + skills sotto. */}
        <div className="lg:col-span-8">
          <div className="mb-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <p
              className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.24em]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {t('eyebrowIndex')}
            </p>
            <span
              className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em]"
              style={{ color: 'var(--color-accent-deep)' }}
            >
              {t('eyebrowRole')}
            </span>
          </div>

          <h1
            className="font-[family-name:var(--font-display)] max-w-[80ch] whitespace-pre-line text-justify"
            style={{
              fontSize: 'var(--text-display-lg)',
              fontWeight: 500,
              letterSpacing: '-0.032em',
              lineHeight: 0.96,
            }}
          >
            {t('h1')}
          </h1>

          <p
            className="body-longform mt-8 text-xl md:text-2xl leading-snug max-w-[80ch] whitespace-pre-line text-justify"
            style={{
              color: 'var(--color-text-secondary)',
              fontWeight: 400,
              letterSpacing: '-0.005em',
            }}
          >
            {t('lead')}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href={localizedPath('/contatti', locale)}
              className="inline-flex min-h-[44px] items-center gap-3 border border-[var(--color-ink)] bg-[var(--color-ink)] px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-bg)] transition-colors hover:border-[var(--color-accent-deep)] hover:bg-[var(--color-accent-deep)]"
            >
              {t('ctaPrimary')}
              <ArrowRight size={16} weight="regular" aria-hidden />
            </Link>
            <Link
              href={localizedPath('/lavori', locale)}
              className="inline-flex min-h-[44px] items-center gap-3 border border-[var(--color-border-strong)] px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-elev)]"
            >
              {t('ctaSecondary')}
              <ArrowRight size={16} weight="regular" aria-hidden />
            </Link>
          </div>
        </div>

        {/* Colonna destra: foto Federico. */}
        <aside className="lg:col-span-4 lg:pt-12">
          <div className="flex flex-col gap-5 lg:max-w-[360px] lg:ml-auto">
            <figure
              className="relative overflow-hidden"
              style={{
                aspectRatio: '4 / 5',
                border: '1px solid var(--color-border)',
                background: 'var(--color-surface-elev)',
              }}
            >
              <Image
                src="/img/federico-calicchia-ritratto-web-designer.webp"
                alt={t('portraitAlt')}
                fill
                priority
                sizes="(min-width: 1024px) 360px, (min-width: 768px) 30vw, 100vw"
                className="object-cover"
              />
            </figure>
          </div>
        </aside>
      </div>
    </section>
  );
}
