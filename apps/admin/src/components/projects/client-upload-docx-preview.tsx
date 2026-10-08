import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useClientUploadBytes } from '@/hooks/use-client-uploads';

// The DOCX is client-controlled content rendered into the admin, so it gets
// its own sandboxed document:
// - no `allow-scripts`: nothing inside can run, `javascript:` hrefs included;
// - `allow-same-origin` only so this component can render into its DOM;
// - `allow-popups(-to-escape-sandbox)` so plain http(s) links open in a tab;
// - a deny-all CSP (data: images/fonts only — docx-preview inlines them with
//   useBase64URL) so the document can't beacon to remote hosts;
// - it also isolates the admin's Tailwind preflight from the Word styles.
const IFRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
const IFRAME_SRCDOC = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>html,body{margin:0;background:#525659}.docx-wrapper{background:#525659!important}</style>
</head><body data-ready="1"><div id="docx-styles"></div><div id="docx-body"></div></body></html>`;

const SAFE_HREF = /^(https?:|mailto:|#)/i;

/** Links come straight from the DOCX relationships: keep only http(s),
 *  mailto and in-document anchors, and open external ones in a new tab. */
function sanitizeLinks(doc: Document) {
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')?.trim() ?? '';
    if (!SAFE_HREF.test(href)) {
      a.removeAttribute('href');
      return;
    }
    if (!href.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

export function DocxPreview({
  fileId,
  onError,
}: {
  fileId: string;
  /** Fetch/parse failure: the lightbox swaps in its download fallback. */
  onError: (message: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [rendered, setRendered] = useState(false);
  const { data, error } = useClientUploadBytes(fileId);

  useEffect(() => {
    if (error) onError(error instanceof Error ? error.message : 'Anteprima non disponibile.');
  }, [error, onError]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!data || !iframe) return;
    let cancelled = false;

    const render = async () => {
      const doc = iframe.contentDocument;
      const body = doc?.getElementById('docx-body');
      const styles = doc?.getElementById('docx-styles');
      if (!doc || !body || !styles) return;
      try {
        // Lazy chunk: docx-preview + jszip only load when a DOCX is opened.
        const { renderAsync } = await import('docx-preview');
        // docx-preview may hold on to the buffer: give it a copy so the
        // cached bytes stay reusable for the next open.
        await renderAsync(data.slice(0), body, styles, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          // altChunk = raw HTML embedded in the DOCX, rendered by docx-preview
          // as an unsandboxed srcdoc iframe. Never.
          renderAltChunks: false,
          experimental: false,
        });
        if (cancelled) return;
        sanitizeLinks(doc);
        setRendered(true);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? `DOCX non leggibile: ${err.message}` : 'DOCX non leggibile.');
      }
    };

    // srcdoc loads asynchronously; before that the iframe holds about:blank.
    if (iframe.contentDocument?.body?.dataset.ready === '1') void render();
    else iframe.addEventListener('load', render, { once: true });

    return () => {
      cancelled = true;
      iframe.removeEventListener('load', render);
    };
  }, [data, onError]);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        title="Anteprima documento Word"
        sandbox={IFRAME_SANDBOX}
        srcDoc={IFRAME_SRCDOC}
        className="h-full w-full border-0"
      />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-950">
          <Loader2 className="h-6 w-6 animate-spin text-white/60" />
        </div>
      )}
    </div>
  );
}
