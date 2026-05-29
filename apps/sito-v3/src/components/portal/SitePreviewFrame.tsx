'use client';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
import { Button } from '@/components/portal/ui/button';
import { Badge } from '@/components/portal/ui/badge';
import { cn } from '@/lib/utils';
import type { PortalProjectPreview } from '@/lib/portal-api';

type Device = 'desktop' | 'tablet' | 'mobile';

const DEVICE_WIDTH: Record<Device, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

const DEVICE_LABEL: Record<Device, string> = {
  desktop: 'Desktop',
  tablet: 'Tablet',
  mobile: 'Mobile',
};

const DEVICE_ICON = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

function providerLabel(provider: PortalProjectPreview['provider']) {
  if (provider === 'netlify') return 'Netlify';
  if (provider === 'vercel') return 'Vercel';
  if (provider === 'wordpress') return 'WordPress';
  return 'Custom';
}

export function SitePreviewFrame({
  previews,
  labels,
}: {
  previews: PortalProjectPreview[];
  labels: {
    openExternal: string;
    refresh: string;
    blockedHint: string;
    loading: string;
  };
}) {
  const [activeId, setActiveId] = useState(previews[0]?.id ?? '');
  const [device, setDevice] = useState<Device>('desktop');
  const [frameKey, setFrameKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);

  const active = useMemo(
    () => previews.find((preview) => preview.id === activeId) ?? previews[0],
    [activeId, previews],
  );

  useEffect(() => {
    if (!active) return;
    setLoaded(false);
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 4500);
    return () => window.clearTimeout(timer);
  }, [active, frameKey]);

  if (!active) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {previews.length > 1 ? (
          <div className="flex max-w-full gap-1 overflow-x-auto border border-border bg-card p-1">
            {previews.map((preview) => (
              <button
                key={preview.id}
                type="button"
                onClick={() => setActiveId(preview.id)}
                className={cn(
                  'shrink-0 px-3 py-1.5 text-portal-caption transition-colors',
                  active.id === preview.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {preview.title}
              </button>
            ))}
          </div>
        ) : (
          <Badge variant="muted">{active.title}</Badge>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{providerLabel(active.provider)}</Badge>
          <div className="flex border border-border bg-card p-1">
            {(['desktop', 'tablet', 'mobile'] as const).map((key) => {
              const Icon = DEVICE_ICON[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={DEVICE_LABEL[key]}
                  onClick={() => setDevice(key)}
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center transition-colors',
                    device === key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFrameKey((value) => value + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {labels.refresh}
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={active.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              {labels.openExternal}
            </a>
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto border border-border bg-muted/40 p-2">
        <div
          className="mx-auto overflow-hidden border border-border bg-background transition-[width] duration-200"
          style={{ width: DEVICE_WIDTH[device], maxWidth: '100%' }}
        >
          <div className="relative aspect-[16/10] min-h-[520px]">
            {!loaded && (
              <div className="absolute inset-0 grid place-items-center bg-background text-portal-caption text-muted-foreground">
                {slow ? labels.blockedHint : labels.loading}
              </div>
            )}
            <iframe
              key={`${active.id}-${frameKey}`}
              title={active.title}
              src={active.url}
              className="h-full w-full"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              onLoad={() => setLoaded(true)}
            />
          </div>
        </div>
      </div>

      {slow && (
        <p className="text-portal-caption text-muted-foreground">
          {labels.blockedHint}
        </p>
      )}
    </div>
  );
}
