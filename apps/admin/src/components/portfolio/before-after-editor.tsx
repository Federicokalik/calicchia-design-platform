import { useRef, useState } from 'react';
import { Upload, X, Loader2, ChevronUp, ChevronDown, Plus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Migration 095 — Before/After pair shape persisted in projects.before_after.
 *
 * One pair = one screen of the redesigned website to compare side-by-side.
 * Alt is REQUIRED on both images (a11y + image SEO). The editor blocks
 * empty alt via a visible required indicator; the wider form validation
 * happens upstream when the user hits "Salva".
 */
export interface BeforeAfterImage {
  src: string;
  alt: string;
  w?: number;
  h?: number;
}
export interface BeforeAfterPair {
  label?: string;
  label_en?: string;
  before: BeforeAfterImage;
  after: BeforeAfterImage;
  note?: string;
}

interface BeforeAfterEditorProps {
  value: BeforeAfterPair[];
  onChange: (next: BeforeAfterPair[]) => void;
  folder?: string;
  max?: number;
}

const EMPTY_IMG: BeforeAfterImage = { src: '', alt: '' };
const EMPTY_PAIR: BeforeAfterPair = { before: { ...EMPTY_IMG }, after: { ...EMPTY_IMG } };

/**
 * Normalize incoming JSONB. Accepts both the wrapped `{pairs:[...]}` shape
 * and a bare array (defensive — older drafts might have been saved either way).
 */
export function normalizeBeforeAfter(raw: unknown): BeforeAfterPair[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { pairs?: unknown }).pairs)
      ? (raw as { pairs: unknown[] }).pairs
      : [];

  return list
    .map((item): BeforeAfterPair | null => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const before = obj.before as Record<string, unknown> | undefined;
      const after = obj.after as Record<string, unknown> | undefined;
      const beforeSrc = typeof before?.src === 'string' ? before.src : '';
      const afterSrc = typeof after?.src === 'string' ? after.src : '';

      return {
        label: typeof obj.label === 'string' ? obj.label : undefined,
        label_en: typeof obj.label_en === 'string' ? obj.label_en : undefined,
        note: typeof obj.note === 'string' ? obj.note : undefined,
        before: {
          src: beforeSrc,
          alt: typeof before?.alt === 'string' ? before.alt : '',
          w: typeof before?.w === 'number' ? before.w : undefined,
          h: typeof before?.h === 'number' ? before.h : undefined,
        },
        after: {
          src: afterSrc,
          alt: typeof after?.alt === 'string' ? after.alt : '',
          w: typeof after?.w === 'number' ? after.w : undefined,
          h: typeof after?.h === 'number' ? after.h : undefined,
        },
      };
    })
    .filter((p): p is BeforeAfterPair => p !== null);
}

/**
 * Serialize editor state back to the JSONB wrapper expected by the API.
 * Returns null when there are no usable pairs so the column can be cleared.
 */
export function serializeBeforeAfter(
  pairs: BeforeAfterPair[],
): { pairs: BeforeAfterPair[] } | null {
  const cleaned = pairs.filter((p) => p.before.src && p.after.src);
  if (cleaned.length === 0) return null;
  return { pairs: cleaned };
}

export function BeforeAfterEditor({
  value,
  onChange,
  folder = 'projects/restyle',
  max = 8,
}: BeforeAfterEditorProps) {
  // Uploading state is keyed by `${pairIndex}-${side}` so two parallel
  // uploads on different slots don't stomp on each other's spinner.
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const setSlot = (key: string, busy: boolean) =>
    setUploading((prev) => ({ ...prev, [key]: busy }));

  const handleUpload = async (
    pairIndex: number,
    side: 'before' | 'after',
    file: File,
  ) => {
    const key = `${pairIndex}-${side}`;
    setSlot(key, true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', folder);
      const data = await apiFetch('/api/media/upload', {
        method: 'POST',
        body: formData,
      });
      if (data?.url) {
        const next = value.slice();
        next[pairIndex] = {
          ...next[pairIndex],
          [side]: {
            ...next[pairIndex][side],
            src: data.url,
          },
        };
        onChange(next);
      }
    } catch {
      // Silent fail — toast is handled at form level if needed.
    } finally {
      setSlot(key, false);
      const inputEl = inputRefs.current[key];
      if (inputEl) inputEl.value = '';
    }
  };

  const updateField = <K extends keyof BeforeAfterPair>(
    pairIndex: number,
    field: K,
    val: BeforeAfterPair[K],
  ) => {
    const next = value.slice();
    next[pairIndex] = { ...next[pairIndex], [field]: val };
    onChange(next);
  };

  const updateAlt = (pairIndex: number, side: 'before' | 'after', alt: string) => {
    const next = value.slice();
    next[pairIndex] = {
      ...next[pairIndex],
      [side]: { ...next[pairIndex][side], alt },
    };
    onChange(next);
  };

  const removeImage = (pairIndex: number, side: 'before' | 'after') => {
    const next = value.slice();
    next[pairIndex] = {
      ...next[pairIndex],
      [side]: { ...EMPTY_IMG },
    };
    onChange(next);
  };

  const addPair = () => {
    if (value.length >= max) return;
    onChange([...value, { ...EMPTY_PAIR, before: { ...EMPTY_IMG }, after: { ...EMPTY_IMG } }]);
  };

  const removePair = (pairIndex: number) => {
    onChange(value.filter((_, i) => i !== pairIndex));
  };

  const movePair = (pairIndex: number, direction: -1 | 1) => {
    const target = pairIndex + direction;
    if (target < 0 || target >= value.length) return;
    const next = value.slice();
    [next[pairIndex], next[target]] = [next[target], next[pairIndex]];
    onChange(next);
  };

  return (
    <div className="space-y-4">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          Nessuna coppia. Aggiungi una schermata prima/dopo per ogni sezione del sito ridisegnata.
        </p>
      ) : (
        <ul className="space-y-4">
          {value.map((pair, i) => (
            <li
              key={i}
              className="rounded-lg border bg-muted/20 p-4 space-y-3"
            >
              {/* Header: reorder + label + remove */}
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={i === 0}
                    onClick={() => movePair(i, -1)}
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
                    onClick={() => movePair(i, 1)}
                    title="Sposta giù"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <Input
                    value={pair.label ?? ''}
                    onChange={(e) => updateField(i, 'label', e.target.value)}
                    placeholder="Label IT — es. Homepage"
                    className="h-8 text-xs"
                    maxLength={80}
                  />
                  <Input
                    value={pair.label_en ?? ''}
                    onChange={(e) => updateField(i, 'label_en', e.target.value)}
                    placeholder="Label EN (opz.)"
                    className="h-8 text-xs"
                    maxLength={80}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => removePair(i)}
                  title="Rimuovi coppia"
                >
                  <X className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>

              {/* Before/After slots */}
              <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
                <ImageSlot
                  side="before"
                  pairIndex={i}
                  image={pair.before}
                  isUploading={!!uploading[`${i}-before`]}
                  onUpload={(file) => handleUpload(i, 'before', file)}
                  onAltChange={(alt) => updateAlt(i, 'before', alt)}
                  onRemove={() => removeImage(i, 'before')}
                  inputRef={(el) => {
                    inputRefs.current[`${i}-before`] = el;
                  }}
                />
                <div className="flex flex-col items-center pt-12 text-muted-foreground">
                  <ArrowRight className="h-4 w-4" />
                </div>
                <ImageSlot
                  side="after"
                  pairIndex={i}
                  image={pair.after}
                  isUploading={!!uploading[`${i}-after`]}
                  onUpload={(file) => handleUpload(i, 'after', file)}
                  onAltChange={(alt) => updateAlt(i, 'after', alt)}
                  onRemove={() => removeImage(i, 'after')}
                  inputRef={(el) => {
                    inputRefs.current[`${i}-after`] = el;
                  }}
                />
              </div>

              {/* Note */}
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Nota (opz., 1 riga)
                </Label>
                <Input
                  value={pair.note ?? ''}
                  onChange={(e) => updateField(i, 'note', e.target.value)}
                  placeholder="Contesto della coppia — es. layout passato da 4 colonne a 1."
                  className="h-8 text-xs"
                  maxLength={140}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          {value.length}/{max} coppie
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={value.length >= max}
          onClick={addPair}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Aggiungi coppia
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Single side slot — extracted to keep the main editor readable.
// ───────────────────────────────────────────────────────────────────

interface ImageSlotProps {
  side: 'before' | 'after';
  pairIndex: number;
  image: BeforeAfterImage;
  isUploading: boolean;
  onUpload: (file: File) => void;
  onAltChange: (alt: string) => void;
  onRemove: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
}

function ImageSlot({
  side,
  pairIndex,
  image,
  isUploading,
  onUpload,
  onAltChange,
  onRemove,
  inputRef,
}: ImageSlotProps) {
  const inputId = `before-after-${side}-${pairIndex}`;
  const altMissing = !!image.src && !image.alt;

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {side === 'before' ? 'Prima' : 'Dopo'}
        </span>
        {image.src ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onRemove}
            title={`Rimuovi ${side}`}
          >
            <X className="h-3.5 w-3.5 text-destructive" />
          </Button>
        ) : null}
      </div>

      {image.src ? (
        <img
          src={image.src}
          alt={image.alt}
          className="aspect-[16/10] w-full rounded border object-cover bg-muted"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
          }}
        />
      ) : (
        <label
          htmlFor={inputId}
          className={cn(
            'flex aspect-[16/10] w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded border border-dashed text-muted-foreground hover:bg-muted/50',
            isUploading && 'pointer-events-none opacity-60',
          )}
        >
          {isUploading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <>
              <Upload className="h-4 w-4" />
              <span className="text-xs">Carica</span>
            </>
          )}
        </label>
      )}

      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
        }}
        disabled={isUploading}
      />

      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Alt text {altMissing ? <span className="text-destructive">*</span> : null}
        </Label>
        <Input
          value={image.alt}
          onChange={(e) => onAltChange(e.target.value)}
          placeholder="Cosa mostra la schermata."
          className={cn('h-8 text-xs', altMissing && 'border-destructive')}
          maxLength={250}
        />
      </div>
      {image.src ? (
        <p
          className="truncate text-[10px] font-mono text-muted-foreground"
          title={image.src}
        >
          {image.src}
        </p>
      ) : null}
    </div>
  );
}
