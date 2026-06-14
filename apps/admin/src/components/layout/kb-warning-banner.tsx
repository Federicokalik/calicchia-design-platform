import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { apiFetch } from '@/lib/api';

interface KbHealth {
  status: 'healthy' | 'degraded';
  source: 's4' | 'local';
  file_count: number;
  stale?: boolean;
  snoozed_until?: string | null;
}

/**
 * Top-of-page banner shown when the AI knowledge base is missing or stale.
 * Hidden on the impostazioni page itself (no point nagging there) and on
 * canvas pages where chrome is intentionally minimal.
 *
 * Polls /api/health/kb (unauthenticated, light) every 60s — the user is
 * already inside an authenticated layout when this mounts, but the public
 * endpoint avoids one more authed roundtrip and survives token expiry edge
 * cases without flashing a 401 banner.
 */
export function KbWarningBanner() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const onSettings = location.pathname.startsWith('/impostazioni') || location.pathname.startsWith('/settings');
  const onCanvas = /^\/boards\/(sketch|mindmap)\//.test(location.pathname);

  const { data } = useQuery<KbHealth>({
    queryKey: ['kb-health'],
    queryFn: () => apiFetch('/api/health/kb'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const snooze = useMutation({
    mutationFn: () =>
      apiFetch('/api/admin/kb/snooze', { method: 'POST', body: JSON.stringify({ days: 7 }) }),
    onSuccess: () => {
      toast.success('Avviso KB silenziato per 7 giorni');
      queryClient.invalidateQueries({ queryKey: ['kb-health'] });
      queryClient.invalidateQueries({ queryKey: ['admin-kb-status'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Impossibile silenziare l\'avviso'),
  });

  if (onSettings || onCanvas) return null;
  if (!data) return null;
  if (data.status === 'healthy' && data.file_count > 0) return null;

  const empty = data.file_count === 0;
  // An empty KB is a hard problem (quote generator down) and is never silenced;
  // the "stale" warning, on the other hand, can be snoozed by the user.
  if (!empty && data.snoozed_until) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <div className="flex items-center gap-2 flex-wrap">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {empty
            ? 'Knowledge base AI vuota: il generatore preventivi non è disponibile finché non carichi i file.'
            : `Knowledge base AI obsoleta (${data.file_count} file, source: ${data.source}).`}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Link
            to="/impostazioni"
            state={{ activeTab: 'knowledge-base' }}
            className="inline-flex items-center gap-1 min-h-11 lg:min-h-0 font-medium underline-offset-2 hover:underline"
          >
            Vai a Knowledge Base
            <ArrowRight className="h-3 w-3" />
          </Link>
          {!empty && (
            <button
              type="button"
              onClick={() => snooze.mutate()}
              disabled={snooze.isPending}
              title="Nascondi per 7 giorni"
              className="inline-flex items-center justify-center min-h-11 lg:min-h-0 rounded p-1 hover:bg-amber-100 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
