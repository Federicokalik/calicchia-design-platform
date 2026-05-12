import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';
import { TEAM } from '@/data/team';

interface TeamSectionProps {
  index?: string;
  eyebrow?: string;
}

/**
 * "Non lavoro da solo" — server component statico.
 * Due card team (Paolo + Davide) + CTA contattami.
 * Rinforza il messaggio "tu parli sempre con me, ma dietro c'è un team pronto".
 */
export async function TeamSection({ index = '05', eyebrow }: TeamSectionProps) {
  const t = await getTranslations('perche.team');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-12 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrow ?? t('eyebrow')}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('collaborators', { count: TEAM.length })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16 mb-20 md:mb-24">
        <div className="md:col-span-5">
          <h2
            className="font-[family-name:var(--font-display)] mb-8 max-w-[14ch]"
            style={{
              fontSize: 'clamp(2.5rem, 4.5vw, 4rem)',
              fontWeight: 500,
              letterSpacing: '-0.03em',
              lineHeight: 0.95,
            }}
          >
            {t('title')}
          </h2>
          <p
            className="text-lg md:text-xl leading-relaxed max-w-[42ch]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {t('lead')}
          </p>
        </div>

        <ul className="md:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-8">
          {TEAM.map((member) => (
            <li
              key={member.id}
              className="flex flex-col p-6 md:p-8"
              style={{ border: '1px solid var(--color-line)' }}
            >
              <div
                className="relative w-20 md:w-24 aspect-[3/4] mb-6 overflow-hidden"
                style={{ border: '1px solid var(--color-line)' }}
              >
                <Image
                  src={member.avatar.src}
                  alt={member.avatar.alt}
                  width={member.avatar.width}
                  height={member.avatar.height}
                  sizes="96px"
                  className="absolute inset-0 w-full h-full object-cover grayscale transition-[filter] duration-500 hover:grayscale-0"
                />
              </div>
              <h3
                className="font-[family-name:var(--font-display)] mb-2"
                style={{
                  fontSize: 'clamp(1.5rem, 2.2vw, 2rem)',
                  fontWeight: 500,
                  letterSpacing: '-0.02em',
                  lineHeight: 1.1,
                }}
              >
                {member.name}
              </h3>
              <p
                className="text-sm mb-6"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                {member.role}
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-2 mt-auto text-xs uppercase tracking-[0.15em]">
                {member.socials.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="border-b transition-opacity hover:opacity-70 pb-0.5"
                      style={{
                        borderColor: 'var(--color-ink-subtle)',
                        color: 'var(--color-ink)',
                      }}
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-8">
        <Link
          href="/contatti"
          className="inline-flex items-center gap-3 text-base uppercase tracking-[0.18em] font-medium border-b transition-[gap] hover:gap-4 min-h-[44px] pb-2"
          style={{ borderColor: 'var(--color-ink)', color: 'var(--color-ink)' }}
        >
          {t('cta')}
          <ArrowRight size={16} weight="regular" aria-hidden />
        </Link>
      </div>
    </Section>
  );
}
