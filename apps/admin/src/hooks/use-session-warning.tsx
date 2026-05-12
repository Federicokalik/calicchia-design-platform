import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { apiFetch, sessionState } from '@/lib/api';

// Server idles out at 30 min (apps/api/src/middleware/auth.ts).
// Warn 5 min before, check every minute.
const WARN_AT_MS = 25 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const TOAST_ID = 'session-warning';

export function useSessionWarning() {
  const warningShown = useRef(false);

  useEffect(() => {
    const tick = () => {
      const idle = Date.now() - sessionState.lastActivity;

      if (idle >= WARN_AT_MS && !warningShown.current) {
        warningShown.current = true;
        toast.warning('La sessione sta per scadere', {
          id: TOAST_ID,
          description: 'Verrà chiusa tra circa 5 minuti per inattività.',
          duration: Infinity,
          action: {
            label: 'Mantieni attiva',
            onClick: async () => {
              try {
                await apiFetch('/api/auth/keep-alive', { method: 'POST' });
                warningShown.current = false;
                toast.dismiss(TOAST_ID);
                toast.success('Sessione rinnovata');
              } catch {
                // apiFetch already redirects to /login on 401
              }
            },
          },
        });
      } else if (idle < WARN_AT_MS && warningShown.current) {
        warningShown.current = false;
        toast.dismiss(TOAST_ID);
      }
    };

    const interval = setInterval(tick, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
}
