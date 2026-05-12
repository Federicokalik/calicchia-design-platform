import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Logo } from '@/components/Logo/Logo';
import { LanguageSwitcher } from '@/components/layout/LanguageSwitcher';
import {
  PortalDisplay,
  PortalBody,
  PortalCaption,
  PortalLabel,
} from '@/components/portal/ui/typography';
import { PortalLoginForm } from './PortalLoginForm';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function ClientiLoginPage({ params }: PageProps) {
  await params;
  const t = await getTranslations('portal.login');

  return (
    <div className="grid min-h-svh lg:grid-cols-2 bg-background">
      {/* Left — brand cover (sito-v3 light, no stock photo) */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 xl:p-16 bg-card border-r border-border">
        <Link href="/" aria-label={t('logoAriaLabel')} className="inline-flex items-start">
          <Logo className="h-6 w-auto" />
        </Link>

        <div className="space-y-5 max-w-md">
          <PortalDisplay>{t('cover.headline')}</PortalDisplay>
          <PortalBody className="text-muted-foreground max-w-sm leading-relaxed">
            {t('cover.description')}
          </PortalBody>
        </div>

        <ul className="space-y-2">
          <li>
            <PortalLabel>{t('cover.bullets.activeOnly')}</PortalLabel>
          </li>
          <li>
            <PortalLabel>{t('cover.bullets.noTracking')}</PortalLabel>
          </li>
        </ul>
      </div>

      {/* Right — form */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-8">
          {/* Mobile logo */}
          <div className="lg:hidden flex justify-center">
            <Link href="/" aria-label={t('logoAriaLabel')}>
              <Logo className="h-6 w-auto" />
            </Link>
          </div>

          <div className="space-y-2">
            <PortalDisplay as="h1">{t('title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground">{t('intro')}</PortalBody>
          </div>

          <Suspense fallback={null}>
            <PortalLoginForm />
          </Suspense>

          <div className="space-y-3 text-center">
            <PortalCaption>
              {t('footer.noAccess')}{' '}
              <a
                href="mailto:hi@calicchiadesign.it"
                className="text-foreground hover:underline underline-offset-4"
              >
                {t('footer.writeMe')}
              </a>
            </PortalCaption>
            <PortalLabel
              as={Link}
              href="/"
              className="inline-block hover:text-foreground transition-colors"
            >
              {t('footer.backToSite')}
            </PortalLabel>
            <div className="flex justify-center pt-2">
              <LanguageSwitcher variant="light" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
