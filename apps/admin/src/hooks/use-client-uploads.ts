import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import {
  fetchClientUploadUrl,
  type ClientUpload,
  type ClientUploadsScope,
} from '@/lib/client-uploads';

export const CLIENT_UPLOADS_QUERY_KEY = 'client-uploads';
const PREVIEW_URL_QUERY_KEY = 'client-upload-preview-url';
// The inline URL is signed for 1h: reuse it while flipping back and forth in
// the lightbox, but leave a wide margin so a reused URL never dies mid-video.
const PREVIEW_URL_REUSE_MS = 30 * 60_000;

function uploadsQueryKey(scope: ClientUploadsScope, includeAll: boolean) {
  return [
    CLIENT_UPLOADS_QUERY_KEY,
    scope.projectId ? 'project' : 'customer',
    scope.projectId ?? scope.customerId,
    includeAll,
  ] as const;
}

/**
 * Files the customer uploaded from the portal (/clienti/upload). Used by the
 * detail pages for the tab badge and by ClientUploadsPanel, sharing the cache.
 * A project scope wins over a customer scope.
 */
export function useClientUploads(scope: ClientUploadsScope, includeAll = false) {
  const params = new URLSearchParams();
  if (scope.projectId) params.set('project_id', scope.projectId);
  else if (scope.customerId) params.set('customer_id', scope.customerId);
  if (includeAll) params.set('include', 'all');

  return useQuery<{ files: ClientUpload[] }>({
    queryKey: uploadsQueryKey(scope, includeAll),
    queryFn: () => apiFetch(`/api/portal-admin/uploads?${params.toString()}`),
    enabled: !!(scope.projectId || scope.customerId),
    // The global 5-minute staleTime would hide a file the client just sent.
    staleTime: 30_000,
  });
}

/** Inline (preview) URL for the lightbox. Never refetched behind the user's
 *  back: a new URL would reload a playing video or a scrolled PDF. */
export function useClientUploadPreviewUrl(fileId: string | null) {
  return useQuery<string>({
    queryKey: [PREVIEW_URL_QUERY_KEY, fileId],
    queryFn: () => fetchClientUploadUrl(fileId!, 'inline'),
    enabled: !!fileId,
    staleTime: PREVIEW_URL_REUSE_MS,
    gcTime: PREVIEW_URL_REUSE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}
