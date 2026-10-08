import { apiFetch, apiFetchRaw } from '@/lib/api';

export type ClientUploadStatus = 'uploading' | 'completed' | 'failed' | 'rejected';

export interface ClientUpload {
  id: string;
  customer_id: string;
  project_id: string | null;
  project_name: string | null;
  original_name: string;
  content_type: string;
  size: number | string;
  status: ClientUploadStatus;
  uploaded_at: string;
}

export interface ClientUploadsScope {
  customerId?: string;
  projectId?: string;
}

export type ClientUploadPreviewKind = 'image' | 'pdf' | 'video' | 'docx' | 'xlsx';

/** Kinds parsed client-side from bytes proxied by the API (no presigned URL). */
export const BYTES_PREVIEW_KINDS: ReadonlySet<ClientUploadPreviewKind> = new Set(['docx', 'xlsx']);

// Must mirror INLINE_UPLOAD_TYPES / ILLUSTRATOR_TYPE / PROXY_PREVIEW_TYPES in
// apps/api/src/routes/portal-admin.ts. Everything else the portal accepts
// (archives, PPTX, PSD, EPS, TIFF) has no viewer here → download only.
const PREVIEW_KIND_BY_TYPE: Record<string, ClientUploadPreviewKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
  // Served as PDF when PDF-compatible (Illustrator default); the API answers
  // 422 for legacy PostScript .ai and the lightbox falls back to download.
  'application/illustrator': 'pdf',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

export function getPreviewKind(file: Pick<ClientUpload, 'content_type' | 'status'>): ClientUploadPreviewKind | null {
  if (file.status !== 'completed') return null;
  return PREVIEW_KIND_BY_TYPE[file.content_type] ?? null;
}

export function formatBytes(value: number | string): string {
  const bytes = Number(value) || 0;
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

export function formatUploadDate(iso: string): string {
  return new Date(iso).toLocaleString('it-IT', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Short-lived presigned S4 URL (inline: 1h, attachment: 5 min — see API). */
export async function fetchClientUploadUrl(id: string, disposition: 'inline' | 'attachment'): Promise<string> {
  const res: { url: string } = await apiFetch(
    `/api/portal-admin/uploads/${id}/url?disposition=${disposition}`,
  );
  return res.url;
}

/** File bytes proxied by the API, for previewers that parse them client-side (DOCX/XLSX). */
export async function fetchClientUploadBytes(id: string): Promise<ArrayBuffer> {
  const res = await apiFetchRaw(`/api/portal-admin/uploads/${id}/content`);
  return res.arrayBuffer();
}

export async function downloadClientUpload(id: string): Promise<void> {
  const url = await fetchClientUploadUrl(id, 'attachment');
  // Content-Disposition: attachment → the browser downloads, no navigation.
  window.location.assign(url);
}
