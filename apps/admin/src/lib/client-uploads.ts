import { apiFetch } from '@/lib/api';

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

export type ClientUploadPreviewKind = 'image' | 'pdf' | 'video';

// Must mirror INLINE_UPLOAD_TYPES in apps/api/src/routes/portal-admin.ts.
// Everything else the portal accepts (archives, Office, PSD/AI, TIFF) has no
// in-browser viewer here → download only.
const PREVIEW_KIND_BY_TYPE: Record<string, ClientUploadPreviewKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
  'video/mp4': 'video',
  'video/quicktime': 'video',
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

export async function downloadClientUpload(id: string): Promise<void> {
  const url = await fetchClientUploadUrl(id, 'attachment');
  // Content-Disposition: attachment → the browser downloads, no navigation.
  window.location.assign(url);
}
