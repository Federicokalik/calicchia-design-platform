import { useState, useRef, useCallback } from 'react';
import { Upload, X, Loader2, Image as ImageIcon } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';

interface ImageUploadProps {
  value?: string;
  onChange: (url: string) => void;
  folder?: string;
  className?: string;
  aspectRatio?: 'video' | 'square' | 'portrait';
  placeholder?: string;
  disabled?: boolean;
}

export function ImageUpload({
  value,
  onChange,
  folder = 'images',
  className,
  aspectRatio = 'video',
  placeholder = 'Carica un\'immagine',
  disabled = false,
}: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const aspectClasses = {
    video: 'aspect-video',
    square: 'aspect-square',
    portrait: 'aspect-[3/4]',
  };

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null);
      setIsUploading(true);

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', folder);

        const response = await apiFetch('/api/media/upload', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Errore durante l\'upload');
        }

        onChange(data.url);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Errore durante l\'upload');
      } finally {
        setIsUploading(false);
      }
    },
    [folder, onChange]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleUpload(file);
      }
    },
    [handleUpload]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      if (disabled || isUploading) return;

      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) {
        handleUpload(file);
      }
    },
    [disabled, isUploading, handleUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleRemove = useCallback(() => {
    onChange('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [onChange]);

  return (
    <div className={cn('relative', className)}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
        disabled={disabled || isUploading}
      />

      {value ? (
        // Preview with image
        <div
          className={cn(
            'relative rounded-lg overflow-hidden border bg-muted',
            aspectClasses[aspectRatio]
          )}
        >
          <img
            src={value}
            alt="Preview"
            className="w-full h-full object-cover"
          />
          {!disabled && (
            <div className="absolute inset-0 bg-black/50 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => inputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Cambia
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleRemove}
                disabled={isUploading}
              >
                <X className="h-4 w-4" />
                Rimuovi
              </Button>
            </div>
          )}
        </div>
      ) : (
        // Upload zone
        <div
          className={cn(
            'relative rounded-lg border-2 border-dashed transition-colors cursor-pointer',
            aspectClasses[aspectRatio],
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-muted-foreground/50',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          onClick={() => !disabled && !isUploading && inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4">
            {isUploading ? (
              <>
                <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
                <p className="text-sm text-muted-foreground">Caricamento...</p>
              </>
            ) : (
              <>
                <ImageIcon className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground text-center">
                  {placeholder}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  Trascina o clicca per caricare
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}

// Multiple images upload
interface MultiImageUploadProps {
  value: string[];
  onChange: (urls: string[]) => void;
  folder?: string;
  max?: number;
  className?: string;
}

export function MultiImageUpload({
  value = [],
  onChange,
  folder = 'gallery',
  max = 10,
  className,
}: MultiImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (files: FileList) => {
    setIsUploading(true);
    const newUrls: string[] = [];

    for (const file of Array.from(files)) {
      if (value.length + newUrls.length >= max) break;

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', folder);

        const response = await apiFetch('/api/media/upload', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();
        if (response.ok) {
          newUrls.push(data.url);
        }
      } catch {
        // Skip failed uploads
      }
    }

    if (newUrls.length > 0) {
      onChange([...value, ...newUrls]);
    }
    setIsUploading(false);
  };

  const handleRemove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className={cn('space-y-4', className)}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {value.map((url, index) => (
          <div
            key={url}
            className="relative aspect-square rounded-lg overflow-hidden border bg-muted group"
          >
            <img
              src={url}
              alt={`Image ${index + 1}`}
              className="w-full h-full object-cover"
            />
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => handleRemove(index)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}

        {value.length < max && (
          <div
            className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/25 hover:border-muted-foreground/50 flex items-center justify-center cursor-pointer transition-colors"
            onClick={() => inputRef.current?.click()}
          >
            {isUploading ? (
              <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
            ) : (
              <Upload className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => e.target.files && handleUpload(e.target.files)}
        className="hidden"
        disabled={isUploading || value.length >= max}
      />

      <p className="text-xs text-muted-foreground">
        {value.length}/{max} immagini caricate
      </p>
    </div>
  );
}
