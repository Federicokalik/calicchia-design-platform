'use client';

import { useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { LogoErrorCode, LogoResult } from '@/lib/palette/logo';
import type { ToolPhoto } from './state';
import type { ToolStrings } from './strings';
import { Bands, LinkButton, Notice, Step, UnsplashImg } from './ui';
import styles from './PaletteTool.module.css';

interface PhotosStepProps {
  t: ToolStrings;
  label: string;
  photos: readonly ToolPhoto[];
  loading: boolean;
  logo: LogoResult | null;
  logoError: LogoErrorCode | null;
  onLogo: (file: File) => void;
  onRemoveLogo: () => void;
  onAddPhotos: (files: FileList | File[]) => void;
  onRemovePhoto: (id: string) => void;
}

const IMG_CLASS = 'block aspect-[4/3] h-auto w-full max-w-full object-cover';

export function PhotosStep({
  t,
  label,
  photos,
  loading,
  logo,
  logoError,
  onLogo,
  onRemoveLogo,
  onAddPhotos,
  onRemovePhoto,
}: PhotosStepProps) {
  const logoInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const logoErrorText =
    logoError === 'empty' ? t.logoErrEmpty : logoError === 'invalid' ? t.logoErrInvalid : logoError ? t.logoErrUnreadable : null;

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer?.files?.length) onAddPhotos(e.dataTransfer.files);
  }

  return (
    <Step n="02" id="pds-foto" title={t.photosTitle} help={t.photosHelp}>
      {/* Logo */}
      <div className="grid grid-cols-1 gap-4 border-t pt-4" style={{ borderColor: 'var(--color-ink)' }}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="grid min-w-0 max-w-[56ch] gap-1">
            <p className="font-semibold">{t.logoTitle}</p>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {t.logoSub}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => logoInput.current?.click()}>
            {t.logoUpload}
          </Button>
          <input
            ref={logoInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept="image/png,image/svg+xml,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLogo(f);
              e.target.value = '';
            }}
          />
        </div>

        {logo ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
            <div className={styles.logoThumb}>
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL generato nel browser */}
              <img src={logo.url} alt={t.logoAlt} />
            </div>
            <div className="grid min-w-0 gap-2">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {logo.colors.map((c) => (
                  <span key={c.hex} className="inline-flex items-center gap-2 font-mono text-[length:var(--text-mono-xs)]">
                    <i
                      aria-hidden="true"
                      className="inline-block h-5 w-5 border"
                      style={{ background: c.hex, borderColor: 'var(--color-line)' }}
                    />
                    {c.hex}
                  </span>
                ))}
              </div>
              <MonoLabel as="p" style={{ lineHeight: 1.4 }}>
                {`${logo.bgRemoved ? t.logoBgRemoved : t.logoBgTransparent} · ${t.logoFixed(logo.colors.length)}`}
              </MonoLabel>
              <LinkButton className="justify-self-start" onClick={onRemoveLogo}>
                {t.logoRemove}
              </LinkButton>
            </div>
          </div>
        ) : null}

        <div aria-live="polite">{logoErrorText ? <Notice>{logoErrorText}</Notice> : null}</div>
      </div>

      {/* Foto */}
      <div
        className={`${styles.photoZone} grid grid-cols-1 gap-4`}
        data-drag={drag}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
        }}
        onDrop={onDrop}
      >
        {loading && !photos.length ? (
          <MonoLabel as="p" role="status">
            {t.loadingPhotos}
          </MonoLabel>
        ) : null}
        <div className="grid grid-cols-2 gap-[clamp(0.5rem,1.5vw,1rem)] sm:grid-cols-3" aria-busy={loading}>
          {photos.map((p) => (
            <PhotoFigure key={p.id} photo={p} t={t} label={label} onRemove={onRemovePhoto} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => photoInput.current?.click()}>
            {t.photoUpload}
          </Button>
          <input
            ref={photoInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept="image/*"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) onAddPhotos(e.target.files);
              e.target.value = '';
            }}
          />
          <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
            {t.photoHint}
          </MonoLabel>
        </div>
      </div>

      <MonoLabel as="p" className="border-t pt-3.5" style={{ lineHeight: 1.4, borderColor: 'var(--color-line)' }}>
        {t.method}
      </MonoLabel>
    </Step>
  );
}

function PhotoFigure({
  photo,
  t,
  label,
  onRemove,
}: {
  photo: ToolPhoto;
  t: ToolStrings;
  label: string;
  onRemove: (id: string) => void;
}) {
  const barLabel = `${t.dominantColors}: ${photo.clusters.map((c) => `${c.hex} ${Math.round(c.w * 100)}%`).join(', ')}`;
  return (
    <figure className="m-0 grid min-w-0 gap-1.5">
      {photo.kind === 'unsplash' ? (
        <UnsplashImg
          photo={photo.photo}
          clusters={photo.clusters}
          size="small"
          alt={photo.photo.alt || t.photoDefaultAlt}
          className={IMG_CLASS}
          brokenLabel={t.photoBroken}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- data URL generato nel browser
        <img
          src={photo.dataUrl}
          alt={photo.kind === 'sim' ? t.photoSimulatedAlt(photo.n, label) : t.photoUserAlt}
          className={IMG_CLASS}
          width={480}
          height={360}
        />
      )}
      <Bands clusters={photo.clusters} className="h-2" label={barLabel} />
      <figcaption className="flex min-w-0 items-baseline justify-between gap-2">
        {photo.kind === 'unsplash' ? (
          <MonoLabel as="span" className="min-w-0 [overflow-wrap:anywhere]" style={{ lineHeight: 1.4 }}>
            {t.photoCredit}{' '}
            <a href={photo.photo.authorUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {photo.photo.author}
            </a>{' '}
            {t.photoCreditOn}{' '}
            <a href={photo.photo.photoUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Unsplash
            </a>
          </MonoLabel>
        ) : photo.kind === 'sim' ? (
          <MonoLabel as="span">{t.photoSimulated(photo.n)}</MonoLabel>
        ) : (
          <>
            <MonoLabel as="span">{t.photoUser}</MonoLabel>
            <LinkButton onClick={() => onRemove(photo.id)}>{t.photoRemove}</LinkButton>
          </>
        )}
      </figcaption>
    </figure>
  );
}
