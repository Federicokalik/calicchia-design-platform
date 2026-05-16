import { useRef, useState } from 'react';
import { Upload, X, Loader2, ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Gallery item shape persisted in projects.gallery (JSONB).
 *
 * `src` is the only required field. `alt` is optional but encouraged for
 * accessibility and image SEO. Reads from the DB tolerate the legacy
 * `string[]` shape — the editor normalizes on load (see {@link normalizeIncoming}).
 */
export interface GalleryItem {
  src: string;
  alt?: string;
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
 * current `{src, alt}[]` so existing data keeps working without a migration.
 */
export function normalizeGalleryIncoming(raw: unknown): GalleryItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): GalleryItem | null => {
      if (typeof item === 'string') return { src: item };
      if (item && typeof item === 'object' && 'src' in item && typeof (item as { src: unknown }).src === 'string') {
        const obj = item as { src: string; alt?: unknown };
        return { src: obj.src, alt: typeof obj.alt === 'string' ? obj.alt : undefined };
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

  const handleUpload = async (files: FileList) => {
    setIsUploading(true);
    const added: GalleryItem[] = [];

    for (const file of Array.from(files)) {
      if (value.length + added.length >= max) break;
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', folder);
        const data = await apiFetch('/api/media/upload', {
          method: 'POST',
          body: formData,
        });
        if (data?.url) added.push({ src: data.url, alt: '' });
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
          Nessuna immagine. Usa il pulsante in basso per caricare.
        </p>
      ) : (
        <ul className="space-y-3">
          {value.map((item, i) => (
            <li
              key={`${item.src}-${i}`}
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
                <img
                  src={item.src}
                  alt={item.alt || ''}
                  className="h-20 w-20 rounded border object-cover bg-muted shrink-0"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
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
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          {value.length}/{max} immagini
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
          {isUploading ? 'Caricamento…' : 'Carica immagini'}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && e.target.files.length > 0 && handleUpload(e.target.files)}
        disabled={isUploading || value.length >= max}
      />
    </div>
  );
}
