import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PortalLabel, PortalH2, PortalBody } from './ui/typography';

interface PortalCardProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Optional href — turns the whole card into a Link. */
  href?: string;
  /** Right-side meta line (e.g. status, date). */
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Portal card — squared island pattern matching shell:
 *   `border border-border bg-card rounded-sm`, no shadow, hover lifts bg
 *   slightly via muted/40. Type scale uses portal tokens (PortalH2/Body/Label).
 *
 * Optional `href` turns the card into a Link (group hover for the arrow).
 */
export async function PortalCard({
  eyebrow,
  title,
  description,
  href,
  meta,
  children,
  className,
}: PortalCardProps) {
  const t = await getTranslations('portal.card');
  const baseClass = cn(
    'flex flex-col p-5 md:p-6 border border-border bg-card rounded-sm transition-colors',
    href && 'hover:bg-muted/40 group',
    className
  );

  const content = (
    <>
      {(eyebrow || meta) && (
        <div className="flex items-baseline justify-between gap-3 mb-3">
          {eyebrow && <PortalLabel>{eyebrow}</PortalLabel>}
          {meta && <PortalLabel className="text-foreground">{meta}</PortalLabel>}
        </div>
      )}
      <PortalH2 className={children || description ? 'mb-2' : ''}>{title}</PortalH2>
      {description && (
        <PortalBody className="text-muted-foreground max-w-[55ch]">
          {description}
        </PortalBody>
      )}
      {children && <div className="mt-4">{children}</div>}
      {href && (
        <span
          aria-hidden
          className="mt-5 inline-flex items-center gap-1.5 text-portal-label uppercase tracking-[0.18em] text-foreground transition-transform group-hover:translate-x-0.5"
        >
          {t('open')} <ArrowRight className="h-3 w-3" strokeWidth={1.75} />
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={baseClass}>
        {content}
      </Link>
    );
  }
  return <article className={baseClass}>{content}</article>;
}
