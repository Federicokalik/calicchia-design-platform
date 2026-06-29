import { useRef, useState } from 'react';
import { Upload, X, Loader2, ChevronUp, ChevronDown, SquareArrowOutUpRight, Link as LinkIcon, Trash2, Film } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowContextMenu, type RowAction } from '@/components/ui/row-context-menu';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Gallery item shape persisted in projects.gallery (JSONB).
 *
 * `src` is the only required field. `alt` is optional but encouraged for
 * accessibility and image SEO. `type` discriminates image vs video; when
 * absent it is inferred from the `src` extension so legacy data keeps
 * working without a migration. Video items may carry `poster` (still frame
 * shown before play), `width`, `height` for aspect-ratio hints.
 * Reads from the DB tolerate the legacy `string[]` shape — the editor
 * normalizes on load (see {@link normalizeGalleryIncoming}).
 */
export type GalleryMediaType = 'image' | 'video';

export interface GalleryItem {
  src: string;
  alt?: string;
  type?: GalleryMediaType;
  poster?: string;
  width?: number;
  height?: number;
}

const VIDEO_EXTS = /\.(mp4|webm|mov|m4v|ogg)$/i;

/**
 * Infer media type from a URL/extension. Used for backward compatibility with
 * gallery rows persisted before the `type` field existed.
 */
export function inferMediaType(src: string | undefined | null): GalleryMediaType {
  if (!src) return 'image';
  return VIDEO_EXTS.test(src) ? 'video' : 'image';
}

interface GalleryEditorProps {
  value: GalleryItem[];
  onChange: (next: GalleryItem[]) => void;
  /** Storage folder under UPLOAD_DIR. Default 'projects' to match cover convention. */
  folder?: string;
  max?: number;
  className?: string;
}

/**
 * Normalize incoming values: accept both the legacy `string[]` shape and the
 * current `{src, alt, type, ...}[]` so existing data keeps working without a
 * migration. Type is inferred from the extension when missing.
 */
export function normalizeGalleryIncoming(raw: unknown): GalleryItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): GalleryItem | null => {
      if (typeof item === 'string') {
        return { src: item, type: inferMediaType(item) };
      }
      if (item && typeof item === 'object' && 'src' in item && typeof (item as { src: unknown }).src === 'string') {
        const obj = item as { src: string; alt?: unknown; type?: unknown; poster?: unknown; width?: unknown; height?: unknown };
        const src = obj.src;
        const type: GalleryMediaType =
          obj.type === 'video' || obj.type === 'image' ? obj.type : inferMediaType(src);
        return {
          src,
          alt: typeof obj.alt === 'string' ? obj.alt : undefined,
          type,
          poster: typeof obj.poster === 'string' ? obj.poster : undefined,
          width: typeof obj.width === 'number' ? obj.width : undefined,
          height: typeof obj.height === 'number' ? obj.height : undefined,
        };
      }
      return null;
    })
    .filter((x): x is GalleryItem => x !== null);
}

export function GalleryEditor({
  value,
  onChange,
  folder = 'projects',
  max = 20,
  className,
}: GalleryEditorProps) {
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 50MB hard cap server-side (apps/api/src/routes/media.ts MAX_FILE_SIZE).
  // We warn the user before kicking off an upload that will be rejected.
  const MAX_FILE_SIZE = 50 * 1024 * 1024;

  const handleUpload = async (files: FileList) => {
    setIsUploading(true);
    const added: GalleryItem[] = [];

    for (const file of Array.from(files)) {
      if (value.length + added.length >= max) break;
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`${file.name} supera 50MB (massimo server)`);
        continue;
      }
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', folder);
        const data = await apiFetch('/api/media/upload', {
          method: 'POST',
          body: formData,
        });
        if (data?.url) {
          const type: GalleryMediaType = file.type.startsWith('video/') ? 'video' : 'image';
          added.push({ src: data.url, alt: '', type });
        }
      } catch {
        // Skip failed uploads silently — toast handled upstream if needed.
      }
    }

    if (added.length > 0) onChange([...value, ...added]);
    setIsUploading(false);
    // Reset the file input so re-uploading the same filename works.
    if (inputRef.current) inputRef.current.value = '';
  };

  const updateAlt = (index: number, alt: string) => {
    const next = value.slice();
    next[index] = { ...next[index], alt };
    onChange(next);
  };

  const removeAt = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = value.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className={cn('space-y-3', className)}>
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          Nessun media. Usa il pulsante in basso per caricare immagini o video.
        </p>
      ) : (
        <ul className="space-y-3">
          {value.map((item, i) => {
            const actions: RowAction[] = [
              {
                label: 'Apri in nuova scheda',
                icon: SquareArrowOutUpRight,
                onClick: () => window.open(item.src, '_blank', 'noopener,noreferrer'),
                disabled: !item.src,
              },
              {
                label: 'Copia URL',
                icon: LinkIcon,
                onClick: () => {
                  navigator.clipboard?.writeText(item.src).then(
                    () => toast.success('URL copiato'),
                    () => toast.error('Copia fallita'),
                  );
                },
                disabled: !item.src,
              },
              { divider: true },
              {
                label: 'Sposta su',
                icon: ChevronUp,
                onClick: () => move(i, -1),
                disabled: i === 0,
              },
              {
                label: 'Sposta giù',
                icon: ChevronDown,
                onClick: () => move(i, 1),
                disabled: i === value.length - 1,
              },
              { divider: true },
              {
                label: 'Rimuovi',
                icon: Trash2,
                destructive: true,
                onClick: () => removeAt(i),
              },
            ];
            return (
            <RowContextMenu key={`${item.src}-${i}`} actions={actions}>
            <li
              className="flex gap-3 items-start rounded-lg border bg-muted/20 p-3"
            >
              {/* Reorder arrows column */}
              <div className="flex flex-col gap-1 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  title="Sposta su"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={i === value.length - 1}
                  onClick={() => move(i, 1)}
                  title="Sposta giù"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Thumb */}
              {item.src ? (
                <div className="relative h-20 w-20 shrink-0">
                  {item.type === 'video' ? (
                    <>
                      <video
                        src={item.src}
                        poster={item.poster}
                        muted
                        className="h-20 w-20 rounded border bg-muted object-cover"
                        onError={(e) => {
                          (e.currentTarget as HTMLVideoElement).style.visibility = 'hidden';
                        }}
                      />
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-white flex items-center gap-0.5">
                        <Film className="h-2 w-2" />
                        Video
                      </span>
                    </>
                  ) : (
                    <img
                      src={item.src}
                      alt={item.alt || ''}
                      className="h-20 w-20 rounded border object-cover bg-muted"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="h-20 w-20 rounded border bg-muted shrink-0" />
              )}

              {/* Alt + URL */}
              <div className="flex-1 min-w-0 space-y-1.5">
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Alt text
                  </Label>
                  <Input
                    value={item.alt ?? ''}
                    onChange={(e) => updateAlt(i, e.target.value)}
                    placeholder="Cosa mostra l'immagine — per screen reader e SEO."
                    className="h-8 text-xs mt-0.5"
                    maxLength={250}
                  />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground truncate" title={item.src}>
                  {item.src}
                </p>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => removeAt(i)}
                title="Rimuovi"
              >
                <X className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </li>
            </RowContextMenu>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          {value.length}/{max} media
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={isUploading || value.length >= max}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5 mr-1.5" />
          )}
          {isUploading ? 'Caricamento…' : 'Carica immagini o video'}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/mp4,video/webm,video/quicktime,video/ogg"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && e.target.files.length > 0 && handleUpload(e.target.files)}
        disabled={isUploading || value.length >= max}
      />
    </div>
  );
}
