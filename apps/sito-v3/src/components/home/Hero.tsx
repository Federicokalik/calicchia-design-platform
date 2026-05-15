import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Heading } from '@/components/ui/Heading';
import { HeroCycle } from './HeroCycle';
import { AvailabilityBadge, type AvailabilitySnapshot } from './AvailabilityBadge';

interface HeroProps {
  years: number;
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const IS_LOCAL_API = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API_BASE);
const IS_PRODUCTION_BUILD =
  process.env.NEXT_PHASE === 'phase-production-build' ||
  process.env.npm_lifecycle_event === 'build';

async function fetchAvailability(): Promise<AvailabilitySnapshot | null> {
  // Evita 5xx in build statico quando l'API locale non gira (stesso pattern di blog-api.ts).
  if (IS_LOCAL_API && IS_PRODUCTION_BUILD) return null;

  try {
    const res = await fetch(`${API_BASE}/api/public/capacity`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as AvailabilitySnapshot;
  } catch {
    return null;
  }
}

/**
 * Hero — Swiss editorial declarative.
 *
 * H1 (decisione 2026-05-05):
 *   "Realizzazione siti web e [branding · sviluppo · SEO · e-commerce]"
 *   con cycling token sull'ultima posizione + sub Frosinone/Ciociaria + meta
 *   "lavoro con clienti in tutta Italia e all'estero".
 *
 * Static by design: the Swiss editorial direction keeps above-the-fold
 * hierarchy readable on first paint.
 */
export async function Hero({ years }: HeroProps) {
  const [t, availability] = await Promise.all([
    getTranslations('home.hero'),
    fetchAvailability(),
  ]);

  return (
    <section
      className="relative px-6 md:px-10 lg:px-14 pt-36 md:pt-48 pb-28 md:pb-40 max-w-[1600px] mx-auto min-h-[100dvh] flex flex-col"
    >
      <p
        className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {t('eyebrow', { year: new Date().getFullYear() })}
      </p>

      <div className="flex-1 flex items-center mt-12 md:mt-16">
        {/* H1 home: usa primitive `<Heading>` con size token + override fontSize/lineHeight
            esclusivo dell'hero (unica deroga di scala documentata, vedi tokens.css). */}
        <Heading
          as="h1"
          size="display-xl"
          style={{
            maxWidth: '100%',
            fontSize: 'clamp(2.75rem, 7vw, 8.5rem)',
            lineHeight: 0.95,
          }}
        >
          <span data-split="static">{t('h1Prefix')}</span>
          <span style={{ display: 'block' }}>
            <span data-split="static">{t('h1Connector')}</span>{' '}
            <span className="inline-block align-baseline">
              <HeroCycle />
            </span>
            <span aria-hidden="true">{t('h1Suffix')}</span>
          </span>
        </Heading>
      </div>

      <div className="mt-auto pt-12 md:pt-20">
        <p
          className="text-base md:text-lg leading-relaxed pt-6 mb-2"
          style={{ color: 'var(--color-ink-muted)', maxWidth: '55ch' }}
        >
          {t('meta')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-end pt-6">
          <div className="md:col-span-7">
            <p
              className="text-base md:text-lg leading-relaxed"
              style={{ color: 'var(--color-ink-muted)', maxWidth: '55ch' }}
            >
              {t('pitch', { years })}
            </p>
          </div>

          <div className="md:col-span-5 md:justify-self-end flex flex-col gap-5 md:items-end">
            <AvailabilityBadge snapshot={availability} />
            <Link
              href="/contatti"
              className="inline-flex items-center gap-3 text-base uppercase tracking-[0.18em] font-medium border-b transition-[gap] hover:gap-4 min-h-[44px] pb-2"
              style={{ borderColor: 'var(--color-ink)', color: 'var(--color-ink)' }}
            >
              {t('cta')}
              <ArrowRight size={16} weight="regular" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
