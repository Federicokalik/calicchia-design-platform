import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Maximize2, X } from 'lucide-react';
import {
  renderQuoteHtml,
  type QuoteTemplateInput,
  type QuoteTemplateSettings,
} from '@calicchia/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';

interface PdfPreviewProps {
  data: QuotePreviewData;
}

export interface QuotePreviewData {
  title: string;
  subtitle: string;
  customerName: string;
  customerCompany: string;
  tipoCliente: string;
  validUntil: string;
  sections: Array<{ id?: string; type: string; data: any }>;
  totale: number;
}

// Fonts are served by the api (apps/api/assets/fonts) — relative URLs resolve
// through the Vite dev proxy / reverse proxy, so the srcDoc iframe (which
// inherits the admin origin) loads them same-origin.
const FONT_BASE = '/api/assets/fonts';
const PREVIEW_FONT_CSS = `
@font-face { font-family: 'Funnel Display'; font-style: normal; font-weight: 300 800; font-display: swap; src: url('${FONT_BASE}/funnel-display-latin.woff2') format('woff2'); }
@font-face { font-family: 'Funnel Sans'; font-style: normal; font-weight: 300 800; font-display: swap; src: url('${FONT_BASE}/funnel-sans-normal-latin.woff2') format('woff2'); }
@font-face { font-family: 'Funnel Sans'; font-style: italic; font-weight: 300 800; font-display: swap; src: url('${FONT_BASE}/funnel-sans-italic-latin.woff2') format('woff2'); }
`;

export function PdfPreview({ data }: PdfPreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);

  // Same settings row the server passes to the PDF renderer — the preview and
  // the generated PDF share one template, so they must share its inputs too.
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings'),
    staleTime: 60_000,
  });
  const settings: QuoteTemplateSettings = useMemo(() => {
    const all = ((settingsData as any)?.settings ?? settingsData) || {};
    return (all['quote.settings'] || {}) as QuoteTemplateSettings;
  }, [settingsData]);

  const html = useMemo(() => {
    const input: QuoteTemplateInput = {
      title: data.title,
      description: data.subtitle,
      customer_name: data.customerName,
      company_name: data.customerCompany,
      total: data.totale,
      valid_until: data.validUntil || null,
      project_template: { sections: data.sections },
    };
    return renderQuoteHtml(input, settings, { fontFaceCss: PREVIEW_FONT_CSS, draft: true });
  }, [data, settings]);

  const iframe = (
    <iframe
      srcDoc={html}
      className="w-full h-full border-0 bg-white"
      title="Preview preventivo"
      sandbox="allow-same-origin"
    />
  );

  return (
    <>
      <div className="relative rounded-lg border bg-white overflow-hidden" style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}>
        <div className="absolute top-2 right-2 z-10">
          <Button variant="secondary" size="icon" className="h-7 w-7 shadow-sm" onClick={() => setFullscreen(true)}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="w-full h-full" style={{ transform: 'scale(0.6)', transformOrigin: 'top left', width: '166.66%', height: '166.66%' }}>
          {iframe}
        </div>
      </div>

      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="max-w-[90vw] h-[90vh] p-0 overflow-hidden">
          <div className="absolute top-3 right-3 z-10">
            <Button variant="secondary" size="icon" className="h-8 w-8" onClick={() => setFullscreen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="w-full h-full bg-white">
            {iframe}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
