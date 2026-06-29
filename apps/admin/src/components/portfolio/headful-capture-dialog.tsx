import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorSmartphone, Loader2, ExternalLink, Camera, X, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import type { GalleryItem, GalleryMediaType } from './gallery-editor';

type SessionStatus =
  | 'pending'
  | 'open'
  | 'snap_requested'
  | 'snap_done'
  | 'close_requested'
  | 'closed'
  | 'error';

interface CaptureSession {
  id: string;
  status: SessionStatus;
  vnc_url: string | null;
  last_capture_url: string | null;
  last_error: string | null;
  target_url: string | null;
}

interface HeadfulCaptureDialogProps {
  projectId: string;
  defaultUrl: string;
  onPushToGallery: (items: GalleryItem[]) => void;
}

// Vite build-time flag — wire it as a build-arg in the admin image build
// (see apps/admin/Dockerfile + .github/workflows/build-admin-image.yml).
const HEADFUL_ENABLED = import.meta.env.VITE_CAPTURE_HEADFUL_ENABLED === 'true';

/**
 * Fase 3 "open browser remoto" dialog — for sites behind login that the
 * headless Phase 2 capture cannot reach. The admin starts a session, opens
 * the worker's noVNC URL in a new tab (manually logs in / navigates), then
 * asks the worker to snapshot the current viewport/scroll. The webp lands in
 * the same /media/projects/<slug>/ namespace and can be pushed to the gallery.
 *
 * Gated by VITE_CAPTURE_HEADFUL_ENABLED so the button never shows unless the
 * operator wired CAPTURE_HEADFUL_ENABLED on the API + worker at build/deploy.
 */
export function HeadfulCaptureDialog({ projectId, defaultUrl, onPushToGallery }: HeadfulCaptureDialogProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(defaultUrl);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState('1920');
  const [viewportHeight, setViewportHeight] = useState('1080');
  const [scrollY, setScrollY] = useState('0');
  const [captured, setCaptured] = useState<{ url: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(
    (sid: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const data = await apiFetch(`/api/projects/${projectId}/capture/session/${sid}`);
          const s: CaptureSession = data.session;
          setSession(s);
          if (s.last_capture_url) setCaptured({ url: s.last_capture_url });
          if (s.status === 'closed') {
            stopPolling();
            return;
          }
          if (s.status === 'error') {
            stopPolling();
            return;
          }
          pollRef.current = setTimeout(tick, 2000);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Errore polling sessione');
          stopPolling();
        }
      };
      void tick();
    },
    [projectId, stopPolling],
  );

  // Cleanup on unmount / dialog close.
  useEffect(() => {
    if (!open) stopPolling();
    return stopPolling;
  }, [open, stopPolling]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setUrl(defaultUrl);
      setSessionId(null);
      setSession(null);
      setError(null);
      setCaptured(null);
      setViewportWidth('1920');
      setViewportHeight('1080');
      setScrollY('0');
    } else {
      // If a session is still open server-side, request close so the worker
      // tears down the browser + VNC and persists the profile.
      if (sessionId) {
        void apiFetch(`/api/projects/${projectId}/capture/session/${sessionId}/close`, {
          method: 'POST',
        }).catch(() => {});
      }
    }
  };

  const startSession = async () => {
    if (!url.trim()) {
      setError('URL obbligatorio');
      return;
    }
    setBusy(true);
    setError(null);
    setCaptured(null);
    try {
      const data = await apiFetch(`/api/projects/${projectId}/capture/session/start`, {
        method: 'POST',
        body: JSON.stringify({ url: url.trim() }),
      });
      const sid: string = data.session.id;
      setSessionId(sid);
      setSession(data.session as CaptureSession);
      poll(sid);
      toast.success('Sessione avviata — apri l\'URL remoto per il login');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Errore avvio sessione';
      setError(message);
      toast.error(`Avvio fallito: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const requestSnap = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/capture/session/${sessionId}/snap`, {
        method: 'POST',
        body: JSON.stringify({
          viewportWidth: Number(viewportWidth) || undefined,
          viewportHeight: Number(viewportHeight) || undefined,
          scrollY: Number(scrollY) || 0,
        }),
      });
      toast.success('Snap richiesto — in elaborazione…');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Errore snap';
      setError(message);
      toast.error(`Snap fallito: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await apiFetch(`/api/projects/${projectId}/capture/session/${sessionId}/close`, {
        method: 'POST',
      });
      toast.success('Chiusura sessione richiesta');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore chiusura');
    } finally {
      setBusy(false);
    }
  };

  const pushToGallery = () => {
    if (!captured) return;
    onPushToGallery([
      {
        src: captured.url,
        alt: `Headful capture — ${url}`,
        type: 'image' as GalleryMediaType,
        width: Number(viewportWidth) || 1920,
        height: Number(viewportHeight) || 1080,
      },
    ]);
    toast.success('Screenshot aggiunto alla galleria');
    setOpen(false);
  };

  if (!HEADFUL_ENABLED) return null;

  const isOpen = session?.status === 'open' || session?.status === 'snap_requested' || session?.status === 'snap_done';
  const isClosing = session?.status === 'close_requested';
  const isError = session?.status === 'error';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center h-8 px-3 text-xs rounded-md border border-border text-foreground hover:bg-muted/50 transition-colors"
        title="Avvia un browser remoto headful per siti dietro login (Fase 3)"
      >
        <MonitorSmartphone className="h-3.5 w-3.5 mr-1.5" />
        Apri browser remoto (login)
      </button>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorSmartphone className="h-4 w-4" />
            Browser remoto headful (Fase 3)
          </DialogTitle>
          <DialogDescription>
            Per siti dietro login: l'admin pilota un browser remoto via noVNC, fa login, poi cattura.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!sessionId ? (
            <div className="space-y-1.5">
              <Label className="text-xs">URL del sito (pagina di login)</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/login"
                className="h-9 text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Il worker apre un browser reale, naviga qui, e ti espone lo schermo via noVNC.
                Il profilo Chrome sopravvive tra sessioni: il login fatto oggi resta valido anche a catture successive.
              </p>
            </div>
          ) : (
            <>
              {/* noVNC link */}
              {session?.vnc_url ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Schermo remoto (noVNC)</Label>
                  <a
                    href={session.vnc_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Apri il browser remoto in una nuova scheda
                  </a>
                  <p className="text-[10px] text-muted-foreground">
                    Apri il link, fai login, naviga alla pagina da catturare, poi torna qui e premi «Cattura qui».
                  </p>
                </div>
              ) : null}

              {/* Snap controls */}
              {isOpen ? (
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">Viewport W</Label>
                    <Input value={viewportWidth} onChange={(e) => setViewportWidth(e.target.value)} className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">Viewport H</Label>
                    <Input value={viewportHeight} onChange={(e) => setViewportHeight(e.target.value)} className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">Scroll Y</Label>
                    <Input value={scrollY} onChange={(e) => setScrollY(e.target.value)} className="h-8 text-xs" />
                  </div>
                </div>
              ) : null}

              {/* Status line */}
              <div className="text-xs text-muted-foreground">
                Stato: <span className="font-mono">{session?.status}</span>
                {isClosing ? ' — chiusura in corso…' : null}
              </div>

              {isError ? (
                <p className="text-xs text-destructive">
                  Errore: {session?.last_error ?? 'sconosciuto'}. Chiudi e riprova.
                </p>
              ) : null}

              {/* Captured preview */}
              {captured ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold">Screenshot pronto:</p>
                  <div className="aspect-[16/10] overflow-hidden rounded border bg-muted">
                    <img src={captured.url} alt="Headful capture" className="w-full h-full object-cover" />
                  </div>
                </div>
              ) : null}
            </>
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {!sessionId ? (
            <Button type="button" size="sm" onClick={startSession} disabled={busy || !url.trim()} className="h-8">
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <MonitorSmartphone className="h-3.5 w-3.5 mr-1.5" />}
              Avvia sessione
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={closeSession} disabled={busy} className="h-8">
                <X className="h-3.5 w-3.5 mr-1.5" />
                Chiudi sessione
              </Button>
              {isOpen ? (
                <Button type="button" size="sm" onClick={requestSnap} disabled={busy} className="h-8">
                  {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Camera className="h-3.5 w-3.5 mr-1.5" />}
                  Cattura qui
                </Button>
              ) : null}
              {captured ? (
                <Button type="button" size="sm" variant="default" onClick={pushToGallery} className="h-8">
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Aggiungi alla galleria
                </Button>
              ) : null}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}