import { useState } from 'react';
import { Camera, Loader2, Globe, Archive, Plus, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { apiFetch } from '@/lib/api';
import type { GalleryItem, GalleryMediaType } from './gallery-editor';
import type { BeforeAfterPair } from './before-after-editor';
import { HeadfulCaptureDialog } from './headful-capture-dialog';

type Viewport = 'desktop' | 'mobile' | 'fullpage';
type Source = 'live' | 'archive';

interface CaptureResult {
  kind: Viewport;
  url: string;
  key: string;
  width: number;
  height: number;
  source: Source;
  archiveTimestamp?: string;
  archiveUrl?: string;
}

interface CaptureDialogProps {
  /** Project ID (DB). Required to call /api/projects/:id/capture. */
  projectId: string;
  /** Pre-filled URL (typically the project live_url). Editable in the dialog. */
  defaultUrl: string;
  /** Whether the project has restyling enabled (controls before/after push visibility). */
  isRestyling: boolean;
  /** Called when the user picks "Aggiungi alla galleria". */
  onPushToGallery: (items: GalleryItem[]) => void;
  /**
   * Called when the user picks "Usa come Prima/Dopo". The pairs returned
   * already encode which side is filled (before vs after) via the
   * `before`/`after` field — the consumer just appends them.
   */
  onPushToBeforeAfter?: (pairs: BeforeAfterPair[]) => void;
}

/**
 * Dialog for headless screenshot capture of a project's live site or its
 * Wayback Machine archived snapshot. Shoots desktop/mobile/fullpage webp
 * shots server-side via puppeteer, then lets the user push the results
 * either to the project gallery or (when is_restyling) to a new
 * before/after pair.
 *
 * The "before (archive)" flow is the canonical use case for restyling case
 * studies: capture the archived version of the site, pair it with a live
 * capture of the redesigned site, render the pair with the drag-slider.
 */
export function CaptureDialog({
  projectId,
  defaultUrl,
  isRestyling,
  onPushToGallery,
  onPushToBeforeAfter,
}: CaptureDialogProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(defaultUrl);
  const [source, setSource] = useState<Source>('live');
  const [archiveDate, setArchiveDate] = useState('');
  const [viewports, setViewports] = useState<Record<Viewport, boolean>>({
    desktop: true,
    mobile: true,
    fullpage: false,
  });
  const [isCapturing, setIsCapturing] = useState(false);
  const [results, setResults] = useState<CaptureResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state whenever the dialog opens, so stale results from a
  // previous session don't leak into a new capture flow.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setUrl(defaultUrl);
      setSource('live');
      setArchiveDate('');
      setViewports({ desktop: true, mobile: true, fullpage: false });
      setResults(null);
      setError(null);
    }
  };

  const selectedViewports = (Object.keys(viewports) as Viewport[]).filter((v) => viewports[v]);

  const runCapture = async () => {
    if (!url.trim()) {
      setError('URL obbligatorio');
      return;
    }
    if (selectedViewports.length === 0) {
      setError('Seleziona almeno un viewport');
      return;
    }
    setIsCapturing(true);
    setError(null);
    setResults(null);
    try {
      const data = await apiFetch(`/api/projects/${projectId}/capture`, {
        method: 'POST',
        body: JSON.stringify({
          url: url.trim(),
          source,
          archiveDate: archiveDate.trim() || undefined,
          viewports: selectedViewports,
        }),
      });
      setResults(data.captures as CaptureResult[]);
      toast.success(`${(data.captures as CaptureResult[]).length} screenshot catturati`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Errore capture';
      setError(message);
      toast.error(`Capture fallito: ${message}`);
    } finally {
      setIsCapturing(false);
    }
  };

  const buildGalleryItems = (rs: CaptureResult[]): GalleryItem[] =>
    rs.map((r) => ({
      src: r.url,
      alt: source === 'archive' && r.archiveTimestamp
        ? `Snapshot Wayback ${r.archiveTimestamp.slice(0, 8)} — ${r.kind}`
        : `${r.kind} — ${url}`,
      type: 'image' as GalleryMediaType,
      width: r.width,
      height: r.height,
    }));

  const buildBeforeAfterPairs = (rs: CaptureResult[], side: 'before' | 'after'): BeforeAfterPair[] =>
    rs.map((r) => ({
      label: side === 'before' ? 'Prima (archivio)' : 'Dopo (live)',
      before: side === 'before'
        ? { src: r.url, alt: `Prima — ${r.kind}`, w: r.width, h: r.height }
        : { src: '', alt: '' },
      after: side === 'after'
        ? { src: r.url, alt: `Dopo — ${r.kind}`, w: r.width, h: r.height }
        : { src: '', alt: '' },
    }));

  const handlePushGallery = () => {
    if (!results) return;
    onPushToGallery(buildGalleryItems(results));
    toast.success(`${results.length} screenshot aggiunti alla galleria`);
    setOpen(false);
  };

  const handlePushBeforeAfter = (side: 'before' | 'after') => {
    if (!results || !onPushToBeforeAfter) return;
    onPushToBeforeAfter(buildBeforeAfterPairs(results, side));
    toast.success(`${results.length} coppia/e ${side === 'before' ? 'Prima' : 'Dopo'} create`);
    setOpen(false);
  };

  return (
    <div className="inline-flex items-center gap-2">
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-8 text-xs shrink-0">
            <Camera className="h-3.5 w-3.5 mr-1.5" />
            Cattura screenshot
          </Button>
        </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-4 w-4" />
            Cattura screenshot del sito
          </DialogTitle>
          <DialogDescription>
            Headless puppeteer. Per siti dietro login usa il worker headful (Fase 3, in roadmap).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* URL */}
          <div className="space-y-1.5">
            <Label className="text-xs">URL del sito</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="h-9 text-sm"
            />
            <p className="text-[10px] text-muted-foreground">
              Default: live_url del progetto. Modificabile per catturare una pagina specifica.
            </p>
          </div>

          {/* Source */}
          <div className="space-y-1.5">
            <Label className="text-xs">Sorgente</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSource('live')}
                className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                  source === 'live'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <Globe className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold">Sito live</p>
                  <p className="text-[10px] text-muted-foreground">Cattura lo stato attuale.</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSource('archive')}
                className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                  source === 'archive'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <Archive className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold">web.archive.org</p>
                  <p className="text-[10px] text-muted-foreground">
                    Snapshot Wayback più vicino alla data.
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* Archive date (only for archive source) */}
          {source === 'archive' ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Data snapshot (opzionale)</Label>
              <Input
                value={archiveDate}
                onChange={(e) => setArchiveDate(e.target.value)}
                placeholder="YYYYMMDD — es. 20230115"
                className="h-9 text-sm font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                Vuoto = snapshot più vicino disponibile. La Wayback picks the closest available
                snapshot to this date.
              </p>
            </div>
          ) : null}

          {/* Viewports */}
          <div className="space-y-1.5">
            <Label className="text-xs">Viewport</Label>
            <div className="flex flex-wrap gap-4">
              {(Object.keys(viewports) as Viewport[]).map((vp) => (
                <label
                  key={vp}
                  className="flex items-center gap-2 text-xs cursor-pointer"
                >
                  <Checkbox
                    checked={viewports[vp]}
                    onCheckedChange={(v) =>
                      setViewports((prev) => ({ ...prev, [vp]: v === true }))
                    }
                  />
                  <span className="capitalize">
                    {vp === 'fullpage' ? 'Full page' : vp}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      ({vp === 'desktop' ? '1920×1080' : vp === 'mobile' ? '390×844' : '1440×auto'})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Error */}
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}

          {/* Results */}
          {results && results.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold">
                {results.length} screenshot catturati — scegli dove inserirli:
              </p>
              <div className="grid grid-cols-3 gap-2">
                {results.map((r) => (
                  <div key={r.kind} className="space-y-1">
                    <div className="aspect-[16/10] overflow-hidden rounded border bg-muted">
                      <img
                        src={r.url}
                        alt={r.kind}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground capitalize">
                      {r.kind}
                      {r.archiveTimestamp ? ` · ${r.archiveTimestamp.slice(0, 8)}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {results && results.length > 0 ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={handlePushGallery}
                className="h-8"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Aggiungi alla galleria
              </Button>
              {isRestyling && onPushToBeforeAfter ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handlePushBeforeAfter('before')}
                    className="h-8"
                    title="Crea nuove coppie Prima/Dopo con questi screenshot nel lato Prima"
                  >
                    <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
                    Usa come «Prima»
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handlePushBeforeAfter('after')}
                    className="h-8"
                    title="Crea nuove coppie Prima/Dopo con questi screenshot nel lato Dopo"
                  >
                    <ArrowRight className="h-3.5 w-3.5 mr-1.5 rotate-180" />
                    Usa come «Dopo»
                  </Button>
                </>
              ) : null}
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={runCapture}
              disabled={isCapturing || !url.trim() || selectedViewports.length === 0}
              className="h-8"
            >
              {isCapturing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5 mr-1.5" />
              )}
              {isCapturing ? 'Cattura in corso…' : 'Cattura'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Fase 3: headful remote-browser capture for sites behind login.
        Renders nothing unless VITE_CAPTURE_HEADFUL_ENABLED===true at
        build time, so this stays invisible in the default build. */}
    <HeadfulCaptureDialog
      projectId={projectId}
      defaultUrl={defaultUrl}
      onPushToGallery={onPushToGallery}
    />
    </div>
  );
}
