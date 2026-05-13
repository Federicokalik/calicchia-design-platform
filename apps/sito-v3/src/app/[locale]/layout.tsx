import { notFound } from 'next/navigation';
import { isLocale, LOCALES } from '@/lib/i18n';
import { PublicAnalytics } from '@/components/analytics/PublicAnalytics';

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <>
      <PublicAnalytics />
      {children}
    </>
  );
}
