import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorSmartphone, Loader2, ExternalLink, Camera, Maximize2, X, Plus } from 'lucide-react';
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

type SnapMode = 'viewport' | 'fullpage';

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
 * Fase 3 "browser remoto" dialog — for sites behind login that the headless
 * Phase 2 capture cannot reach. The worker launches a real Chromium and streams
 * it back over noVNC, embedded inline in an <iframe> here: the admin logs in /
 * navigates directly inside the dialog, then captures.
 *
 * Two capture modes:
 *  - "Cattura questa vista" (WYSIWYG): the worker screenshots the current
 *    viewport at the current scroll — exactly what's on screen in the iframe.
 *  - "Pagina intera": the full scrollable page.
 * The framing decision lives server-side (snap_mode) because the admin sees
 * only noVNC pixels, not the remote DOM — it can't read the remote scroll.
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
          if (s.status === 'closed' || s.status === 'error') {
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
    } else if (sessionId) {
      // If a session is still open server-side, request close so the worker
      // tears down Chromium + VNC and persists the profile.
      void apiFetch(`/api/projects/${projectId}/capture/session/${sessionId}/close`, {
        method: 'POST',
      }).catch(() => {});
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
      toast.success('Sessione avviata — fai login nel browser remoto qui sotto');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Errore avvio sessione';
      setError(message);
      toast.error(`Avvio fallito: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const snap = async (mode: SnapMode) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/capture/session/${sessionId}/snap`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      toast.success(mode === 'fullpage' ? 'Cattura pagina intera richiesta…' : 'Cattura della vista richiesta…');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Errore cattura';
      setError(message);
      toast.error(`Cattura fallita: ${message}`);
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
      },
    ]);
    toast.success('Screenshot aggiunto alla galleria');
    setOpen(false);
  };

  if (!HEADFUL_ENABLED) return null;

  const isOpen = session?.status === 'open' || session?.status === 'snap_requested' || session?.status === 'snap_done';
  const isSnapping = session?.status === 'snap_requested';
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
      <DialogContent className={sessionId ? 'sm:max-w-5xl' : 'sm:max-w-2xl'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorSmartphone className="h-4 w-4" />
            Browser remoto headful (Fase 3)
          </DialogTitle>
          <DialogDescription>
            Per siti dietro login: piloti tu il browser remoto qui sotto (login, navigazione), poi catturi ciò che vedi.
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
                Il worker apre un browser reale, naviga qui, e te lo mostra qui sotto via noVNC. Il profilo Chrome
                sopravvive tra sessioni: il login fatto oggi resta valido anche a catture successive.
              </p>
            </div>
          ) : (
            <>
              {/* Live noVNC screen, embedded — you see & drive the remote browser right here. */}
              {session?.vnc_url ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Schermo remoto — clicca dentro per pilotare</Label>
                    <a
                      href={session.vnc_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Apri a schermo intero
                    </a>
                  </div>
                  <iframe
                    src={session.vnc_url}
                    title="Browser remoto (noVNC)"
                    className="w-full h-[55vh] min-h-[360px] rounded border bg-black"
                    allow="clipboard-read; clipboard-write"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Fai login e naviga fin dove vuoi, poi premi «Cattura questa vista» (esattamente ciò che vedi)
                    oppure «Pagina intera».
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Avvio del browser remoto in corso…
                </div>
              )}

              {/* Status line */}
              <div className="text-xs text-muted-foreground">
                Stato: <span className="font-mono">{session?.status}</span>
                {isSnapping ? ' — cattura in corso…' : null}
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
                  <div className="max-h-64 overflow-auto rounded border bg-muted">
                    <img src={captured.url} alt="Headful capture" className="w-full" />
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
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => snap('viewport')}
                    disabled={busy || isSnapping}
                    className="h-8"
                  >
                    {busy || isSnapping ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Camera className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Cattura questa vista
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => snap('fullpage')}
                    disabled={busy || isSnapping}
                    className="h-8"
                  >
                    <Maximize2 className="h-3.5 w-3.5 mr-1.5" />
                    Pagina intera
                  </Button>
                </>
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
