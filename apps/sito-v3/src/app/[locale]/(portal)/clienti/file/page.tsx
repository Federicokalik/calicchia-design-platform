import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Upload } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import { Button } from '@/components/portal/ui/button';
import { Badge } from '@/components/portal/ui/badge';
import {
  PortalDisplay,
  PortalH3,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getFiles,
  PortalUnauthorizedError,
  type PortalFile,
} from '@/lib/portal-api';
import {
  formatPortalBytes,
  formatPortalDate,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

function fileTypeKey(contentType: string): 'pdf' | 'image' | 'video' | 'archive' | 'other' {
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('7z')) return 'archive';
  return 'other';
}

export default async function FilesPage({ params }: PageProps) {
  await params;

  try {
    const [customer, files, t, locale] = await Promise.all([
      getCustomer(),
      getFiles(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect('/clienti/file'));

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.files') },
          ]}
          right={
            <Button asChild size="sm">
              <Link href="/clienti/upload">
                <Upload className="h-3.5 w-3.5" />
                {t('files.uploadCta')}
              </Link>
            </Button>
          }
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('files.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('files.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('files.intro')}
            </PortalBody>
          </header>

          <PortalTable<PortalFile>
            rows={files}
            columns={[
              {
                key: 'original_name',
                header: t('files.columns.name'),
                width: 'flex-[2]',
                render: (file) => (
                  <PortalH3 className="font-[family-name:var(--font-display)] tracking-tight truncate">
                    {file.original_name}
                  </PortalH3>
                ),
              },
              {
                key: 'content_type',
                header: t('files.columns.type'),
                width: 'w-24',
                render: (file) => (
                  <Badge variant="outline">{t(`files.types.${fileTypeKey(file.content_type)}`)}</Badge>
                ),
              },
              {
                key: 'project_name',
                header: t('files.columns.project'),
                width: 'flex-1',
                render: (file) => (
                  <span className="text-portal-body text-muted-foreground">
                    {file.project_name ?? t('files.fallbackProject')}
                  </span>
                ),
              },
              {
                key: 'size',
                header: t('files.columns.size'),
                width: 'w-24',
                align: 'right',
                render: (file) => (
                  <span className="text-portal-caption text-muted-foreground tabular-nums">
                    {formatPortalBytes(file.size)}
                  </span>
                ),
              },
              {
                key: 'uploaded_at',
                header: t('files.columns.uploadedAt'),
                width: 'w-32',
                align: 'right',
                render: (file) => (
                  <span className="text-portal-caption text-muted-foreground tabular-nums">
                    {formatPortalDate(file.uploaded_at, locale)}
                  </span>
                ),
              },
            ]}
            emptyState={
              <PortalEmptyState
                eyebrow={t('files.empty.eyebrow')}
                title={t('files.empty.title')}
                description={t('files.empty.description')}
                action={
                  <Button asChild>
                    <Link href="/clienti/upload">
                      <Upload className="h-3.5 w-3.5" />
                      {t('files.uploadFirstCta')}
                    </Link>
                  </Button>
                }
              />
            }
          />
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/file'));
    }
    throw error;
  }
}
