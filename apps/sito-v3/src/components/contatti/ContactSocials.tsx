import { getTranslations } from 'next-intl/server';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';
import { SITE } from '@/data/site';
import { getSocialIcon } from '@/data/social-icons';

/**
 * Lista social Pentagram-style: tabella editorial hairline, una riga per
 * social con icon + label + URL host.
 *
 * Reference Bierut: la lista È il visual (numbering left rail, mono labels,
 * hairline 1px between rows, single accent solo on hover hairline reveal).
 * Niente card+shadow, niente icon clouds, niente marquee.
 *
 * Server-only — fonte dati `SITE.social[]` da `@/data/site.ts`. Aggiungere
 * o riordinare social qui passa solo dal data file.
 */
export async function ContactSocials() {
  const t = await getTranslations('contatti.channels');

  if (!SITE.social || SITE.social.length === 0) return null;

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-10 mb-12 md:mb-16">
        <div className="col-span-12 md:col-span-7">
          <Eyebrow as="p" mono className="mb-6">
            {t('eyebrow')}
          </Eyebrow>
          <Heading
            as="h2"
            size="display-md"
            className="mb-2"
            style={{ maxWidth: '20ch' }}
          >
            {t('heading')}
          </Heading>
        </div>
      </div>

      <ul role="list" className="flex flex-col">
        {SITE.social.map((s, i) => {
          const Icon = getSocialIcon(s.icon);
          // Estrai host pulito dall'URL per visual hint editorial
          let host = '';
          try {
            host = new URL(s.url).host.replace(/^www\./, '');
          } catch {
            host = '';
          }
          return (
            <li
              key={s.url}
              className="border-t"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group grid grid-cols-12 gap-4 md:gap-8 items-center py-6 md:py-8 transition-colors hover:bg-[var(--color-surface-elev)] focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {/* Mono numbering left rail (Bierut metadata column) */}
                <span
                  className="col-span-1 tabular-nums hidden md:inline"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-mono-xs)',
                    letterSpacing: '0.05em',
                    color: 'var(--color-accent-deep)',
                  }}
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>

                {/* Icon hairline (Phosphor regular weight, 24px). Resta neutro
                    a riposo, eredita accent color sull'hover (gestito via class
                    sul parent <a>). */}
                <span
                  className="col-span-1 flex items-center justify-start md:justify-center transition-colors group-hover:text-[var(--color-accent-deep)]"
                  aria-hidden="true"
                  style={{ color: 'var(--color-ink)' }}
                >
                  <Icon size={22} weight="regular" />
                </span>

                {/* Label nome social (display) */}
                <span
                  className="col-span-5 md:col-span-4 font-[family-name:var(--font-display)] text-2xl md:text-3xl"
                  style={{
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}
                >
                  {s.label}
                </span>

                {/* Host URL pulito (mono small, hidden mobile) */}
                <MonoLabel
                  as="span"
                  className="col-span-12 md:col-span-5 hidden md:inline normal-case"
                  tone="muted"
                >
                  {host}
                </MonoLabel>

                {/* CTA arrow accent translate on hover */}
                <span
                  className="col-span-5 md:col-span-1 flex justify-end items-center transition-transform duration-200 group-hover:translate-x-1"
                  aria-hidden="true"
                  style={{ color: 'var(--color-accent-deep)' }}
                >
                  ↗
                </span>
              </a>
            </li>
          );
        })}
        {/* Closing border-bottom semantic (la lista chiude con hairline) */}
        <li
          aria-hidden="true"
          className="border-t"
          style={{ borderColor: 'var(--color-border)' }}
        />
      </ul>
    </Section>
  );
}
