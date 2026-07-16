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
