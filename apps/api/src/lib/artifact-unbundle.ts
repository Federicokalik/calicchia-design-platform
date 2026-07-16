/**
 * Unbundler for claude.ai artifact exports ("Standalone" HTML downloads).
 *
 * Those files ship the real page as JSON inside <script type="__bundler/*">
 * tags plus a loader that unpacks assets (fonts, images) into blob URLs at
 * runtime in the browser. Puppeteer can't rely on that unpack completing
 * before printing, so we unpack server-side at import time: decompress each
 * manifest asset, inline it as a data: URI, and substitute the placeholder
 * UUIDs inside the template.
 *
 * Returns null when the input is not a bundled artifact (plain HTML passes
 * through untouched at the call site).
 */

import { gunzipSync } from 'zlib';

interface ManifestEntry {
  mime: string;
  data: string;
  compressed?: boolean;
}

export interface CleanReport {
  scripts: number;
  noscript: number;
  uiButtons: number;
  inlineHandlers: number;
}

/**
 * Normalize an uploaded quote document for print: the PDF is a static
 * artifact, so active content only adds nondeterminism (and script execution
 * inside server-side Chrome). Removes:
 *  - <script> blocks (animations, loaders — never needed in print)
 *  - <noscript> fallbacks
 *  - screen-only UI buttons (e.g. the artifact "print / save PDF" bar)
 *  - inline event handlers (onclick, onload, …)
 * Layout/CSS is left untouched.
 */
export function cleanCustomQuoteHtml(html: string): { html: string; report: CleanReport } {
  const report: CleanReport = { scripts: 0, noscript: 0, uiButtons: 0, inlineHandlers: 0 };

  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => { report.scripts++; return ''; });
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, () => { report.noscript++; return ''; });
  out = out.replace(/<button\b[^>]*class="[^"]*(?:no-print|print-bar)[^"]*"[^>]*>[\s\S]*?<\/button>/gi, () => { report.uiButtons++; return ''; });
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, () => { report.inlineHandlers++; return ''; });

  return { html: out, report };
}

export function unbundleArtifactHtml(html: string): string | null {
  const manifestMatch = /<script type="__bundler\/manifest">([\s\S]*?)<\/script>/.exec(html);
  const templateMatch = /<script type="__bundler\/template">([\s\S]*?)<\/script>/.exec(html);
  if (!manifestMatch || !templateMatch) return null;

  try {
    const manifest = JSON.parse(manifestMatch[1]) as Record<string, ManifestEntry>;
    let template = JSON.parse(templateMatch[1]) as string;
    if (typeof template !== 'string' || !template.includes('<')) return null;

    for (const [uuid, entry] of Object.entries(manifest)) {
      if (!entry || typeof entry.data !== 'string') continue;
      let b64 = entry.data;
      if (entry.compressed) {
        b64 = gunzipSync(Buffer.from(entry.data, 'base64')).toString('base64');
      }
      const mime = /^[\w.+-]+\/[\w.+-]+$/.test(entry.mime || '') ? entry.mime : 'application/octet-stream';
      template = template.split(uuid).join(`data:${mime};base64,${b64}`);
    }

    // SRI/crossorigin attrs reference the original CDN bytes — strip them so
    // the inlined data: URIs load (same cleanup the artifact loader performs).
    return template
      .replace(/\s+integrity="[^"]*"/gi, '')
      .replace(/\s+crossorigin="[^"]*"/gi, '');
  } catch {
    return null;
  }
}
