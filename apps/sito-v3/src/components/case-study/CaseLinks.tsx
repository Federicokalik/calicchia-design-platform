import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';

interface CaseLinksProps {
  liveUrl?: string | null;
  repoUrl?: string | null;
}

/**
 * External-link row under the hero: live site + repository.
 *
 * Same Pentagram register as CaseStaleNotice — hairline border-top, mono
 * uppercase, no buttons. Renders nothing when neither URL is set. The live
 * link here is a plain "visit the site"; CaseStaleNotice shows its own
 * (differently framed) link only when the project is over a year old.
 */
export async function CaseLinks({ liveUrl, repoUrl }: CaseLinksProps) {
  const t = await getTranslations('lavori.detail.links');

  const items = [
    liveUrl ? { href: liveUrl, label: t('live') } : null,
    repoUrl ? { href: repoUrl, label: t('repo') } : null,
  ].filter((x): x is { href: string; label: string } => x !== null);

  if (items.length === 0) return null;

  return (
    <Section spacing="compact" bordered="top">
      <nav
        className="flex flex-wrap items-center gap-x-8 gap-y-3 py-2"
        aria-label={t('ariaLabel')}
      >
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.18em] underline-offset-4 hover:underline"
            style={{ color: 'var(--color-ink)' }}
          >
            {item.label}
            <span aria-hidden>↗</span>
          </a>
        ))}
      </nav>
    </Section>
  );
}
