import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { LockKey } from '@phosphor-icons/react/dist/ssr';
import { InlineCheckout, type PaymentProvider } from '@/components/portal/payment/InlineCheckout';
import {
  PortalDisplay,
  PortalLabel,
  PortalBody,
} from '@/components/portal/ui/typography';
import type { Locale } from '@/lib/i18n';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

interface PageProps {
  params: Promise<{ locale: Locale; linkId: string }>;
}

interface LinkData {
  id: string;
  provider: PaymentProvider | 'revolut';
  amount: number;
  currency: string;
  status: string;
  expires_at: string | null;
  description: string | null;
  project_name: string | null;
}

async function fetchLink(linkId: string): Promise<{ link: LinkData | null; status: number }> {
  try {
    const res = await fetch(`${API_BASE}/api/public-pay/${encodeURIComponent(linkId)}`, {
      cache: 'no-store',
    });
    if (res.status === 404) return { link: null, status: 404 };
    if (res.status === 410) {
      const data = (await res.json().catch(() => ({}))) as Partial<LinkData>;
      return { link: { ...(data as LinkData), status: 'expired' }, status: 410 };
    }
    if (!res.ok) {
      console.error('[pay/page] api error', res.status, await res.text().catch(() => ''));
      return { link: null, status: res.status };
    }
    return { link: (await res.json()) as LinkData, status: 200 };
  } catch (err) {
    console.error('[pay/page] fetch error', err);
    return { link: null, status: 500 };
  }
}

export default async function PayLinkPage({ params }: PageProps) {
  const { linkId } = await params;
  const [{ link, status }, t, locale] = await Promise.all([
    fetchLink(linkId),
    getTranslations('portal.payment'),
    getLocale(),
  ]);

  if (status === 404 || !link) notFound();

  const amountLabel = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'it-IT', {
    style: 'currency',
    currency: link.currency,
  }).format(link.amount);

  const isExpired = status === 410 || link.status === 'expired' || link.status === 'cancelled';
  const isPaid = link.status === 'paid';

  return (
    <div className="min-h-dvh flex flex-col">
      {/* Minimal header */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <span className="text-portal-label uppercase tracking-wider text-foreground">
            Calicchia Design
          </span>
          <span className="inline-flex items-center gap-1.5 text-portal-label uppercase tracking-wider text-muted-foreground">
            <LockKey size={14} weight="bold" aria-hidden />
            {t('publicPay.secure')}
          </span>
        </div>
      </header>

      <main className="flex-1 px-6 py-12">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          {/* Header block */}
          <header className="flex flex-col gap-3">
            <PortalLabel>{t('publicPay.eyebrow')}</PortalLabel>
            <PortalDisplay>{amountLabel}</PortalDisplay>
            {link.description && (
              <PortalBody className="text-muted-foreground max-w-[55ch]">
                {link.description}
                {link.project_name ? ` · ${link.project_name}` : ''}
              </PortalBody>
            )}
          </header>

          {/* Status-aware body */}
          {isPaid ? (
            <div className="rounded-sm border border-success/40 bg-success/5 p-5">
              <PortalLabel className="text-success">{t('success.eyebrow')}</PortalLabel>
              <p className="text-portal-body text-foreground mt-1">{t('success.intro')}</p>
            </div>
          ) : isExpired ? (
            <div className="rounded-sm border border-destructive/40 bg-destructive/5 p-5">
              <PortalLabel className="text-destructive">{t('publicPay.expiredEyebrow')}</PortalLabel>
              <p className="text-portal-body text-foreground mt-1">
                {t('publicPay.expiredBody')}
              </p>
            </div>
          ) : link.provider === 'revolut' ? (
            <p className="text-portal-body text-muted-foreground">
              {t('publicPay.providerUnsupported')}
            </p>
          ) : (
            <InlineCheckout
              linkId={link.id}
              singleProvider={link.provider}
              amount={link.amount}
              currency={link.currency}
            />
          )}

          {/* Footnote */}
          <footer className="border-t border-border pt-6 text-portal-label uppercase tracking-wider text-muted-foreground">
            <p>{t('publicPay.footnote')}</p>
          </footer>
        </div>
      </main>
    </div>
  );
}

