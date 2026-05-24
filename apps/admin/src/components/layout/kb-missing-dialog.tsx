import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const REQUIRED_FILES = ['pricing_knowledge_base.md', 'profile_knowledge_base.md'];
const DISMISS_KEY = 'kb-missing-dismissed';

interface KbStatusFile {
  name: string;
}

interface KbStatusResponse {
  files: KbStatusFile[];
}

/**
 * One-shot popup that nags the admin if either of the two critical knowledge
 * base files (`pricing_knowledge_base.md`, `profile_knowledge_base.md`) is
 * missing — without them the AI quote generator is offline.
 *
 * Soft constraints:
 *  - Already on /impostazioni? Skip — the file uploader is right there.
 *  - User dismissed it this session? Skip — `KbWarningBanner` keeps nagging in
 *    the top-of-page strip, so dismissing the popup just clears the modal.
 */
export function KbMissingDialog() {
  const location = useLocation();
  const navigate = useNavigate();
  const onSettings =
    location.pathname.startsWith('/impostazioni') ||
    location.pathname.startsWith('/settings');

  const { data } = useQuery<KbStatusResponse>({
    queryKey: ['kb-status'],
    queryFn: () => apiFetch('/api/admin/kb/status'),
    enabled: !onSettings,
    staleTime: 60_000,
  });

  const missing = data
    ? REQUIRED_FILES.filter(
        (required) => !data.files.some((f) => f.name === required),
      )
    : [];

  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (onSettings) return;
    if (missing.length === 0) return;
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
    setOpen(true);
  }, [missing.length, onSettings]);

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setOpen(false);
  };

  const goToSettings = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setOpen(false);
    navigate('/impostazioni', { state: { activeTab: 'knowledge-base' } });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : handleDismiss())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            Knowledge base AI incompleta
          </DialogTitle>
          <DialogDescription>
            Mancano i file critici per il generatore preventivi. Caricali da{' '}
            <strong>Impostazioni → Knowledge Base</strong> per attivare l&apos;AI.
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-2 space-y-1 text-sm font-mono text-muted-foreground">
          {missing.map((name) => (
            <li key={name} className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              {name}
            </li>
          ))}
        </ul>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleDismiss}>
            Più tardi
          </Button>
          <Button onClick={goToSettings}>Vai alla Knowledge Base</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
