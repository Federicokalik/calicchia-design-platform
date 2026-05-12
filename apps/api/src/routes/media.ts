import { Hono } from 'hono';
import { uploadFile, deleteFile, listFiles, generateFileKey, isS3Configured } from '../lib/s3';

export const media = new Hono();

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

media.get('/', async (c) => {
  // Check if S3 is configured
  if (!isS3Configured()) {
    // Return empty files array instead of error - allows page to render
    console.warn('S3 storage not configured');
    return c.json({ files: [], warning: 'Storage non configurato' });
  }

  const folder = c.req.query('folder') || '';
  const limit = parseInt(c.req.query('limit') || '100');

  try {
    const files = await listFiles(folder, limit);
    return c.json({ files });
  } catch (error) {
    console.error('Error listing S3 files:', error);
    // Return empty array on error instead of 500
    return c.json({ files: [], error: 'Errore nel caricamento file' });
  }
});

media.post('/upload', async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: 'Storage non configurato' }, 503);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const rawFolder = (formData.get('folder') as string) || 'uploads';
    const folder = rawFolder.replace(/\.{2,}/g, '').replace(/[^a-z0-9_/-]/gi, '').substring(0, 100) || 'uploads';

    if (!file) {
      return c.json({ error: 'Nessun file fornito' }, 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: 'File troppo grande. Max 50MB' }, 400);
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return c.json({ error: `Tipo file non supportato: ${file.type}` }, 400);
    }

    const key = generateFileKey(file.name, folder);
    const buffer = Buffer.from(await file.arrayBuffer());

    const result = await uploadFile(buffer, key, file.type, {
      'original-name': encodeURIComponent(file.name),
      'uploaded-at': new Date().toISOString(),
    });

    return c.json({
      url: result.url,
      key: result.key,
      size: result.size,
      filename: file.name,
      contentType: file.type,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    const message = error instanceof Error ? error.message : 'Errore upload';
    return c.json({ error: message }, 500);
  }
});

media.delete('/', async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: 'Storage non configurato' }, 503);
  }

  try {
    const { key } = await c.req.json();
    if (!key) {
      return c.json({ error: 'Key del file richiesta' }, 400);
    }

    await deleteFile(key);
    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    const message = error instanceof Error ? error.message : 'Errore cancellazione';
    return c.json({ error: message }, 500);
  }
});
