/**
 * Private file delivery (SEC-10). Serves quote PDFs, receipts and WhatsApp
 * media that must not sit on the public /media/* path. Access is gated by the
 * signed URL produced by lib/private-files.ts — the signature is the
 * capability, so emailed links work without a session. Failures return a
 * generic 404 to avoid confirming whether a file exists.
 */
import { Hono } from 'hono';
import { verifyFileSig, privateFileExists, readPrivateFile } from '../lib/private-files';

export const files = new Hono();

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

files.get('/:category/:name', async (c) => {
  const category = c.req.param('category');
  const name = c.req.param('name');

  if (!verifyFileSig(category, name, c.req.query('exp'), c.req.query('sig'))) {
    return c.json({ error: 'Not found' }, 404);
  }
  if (!privateFileExists(category, name)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const buffer = await readPrivateFile(category, name);
  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': mimeFor(name),
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});
