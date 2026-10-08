import { useQuery } from '@tanstack/react-query';
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

export const CLIENT_UPLOADS_QUERY_KEY = 'client-uploads';

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
