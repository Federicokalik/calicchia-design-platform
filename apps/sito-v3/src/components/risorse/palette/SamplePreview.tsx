/**
 * Anteprima della palette (home di esempio, cornice, filtri daltonismo).
 *
 * Niente 'use client' e niente hook: la rende il tool nel browser e la pagina
 * `condividi` sul server. L'unico pezzo client è UnsplashImg (fallback se la
 * foto non carica), che riceve solo props serializzabili.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { PresetKey } from '@calicchia/shared/palette';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { SectorCopy } from '@/data/risorse/palette/types';
import type { ToolPhoto } from './state';
import type { ToolStrings, VisionMode } from './strings';
import { UnsplashImg } from './ui';
import styles from './PaletteTool.module.css';

/** Filtri di simulazione del daltonismo: matrici di Machado et al. (2009), severità 1. */
export function CvdFilters() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute h-0 w-0 overflow-hidden">
      <filter id="pds-cvd-prot" colorInterpolationFilters="linearRGB">
        <feColorMatrix
          type="matrix"
          values="0.152286 1.052583 -0.204868 0 0  0.114503 0.786281 0.099216 0 0  -0.003882 -0.048116 1.051998 0 0  0 0 0 1 0"
        />
      </filter>
      <filter id="pds-cvd-deut" colorInterpolationFilters="linearRGB">
        <feColorMatrix
          type="matrix"
          values="0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0"
        />
      </filter>
      <filter id="pds-cvd-trit" colorInterpolationFilters="linearRGB">
        <feColorMatrix
          type="matrix"
          values="1.255528 -0.076749 -0.178779 0 0  -0.078411 0.930809 0.147602 0 0  0.004733 0.691367 0.303900 0 0  0 0 0 1 0"
        />
      </filter>
    </svg>
  );
}

export const VISION_FILTER: Record<VisionMode, string> = {
  none: 'none',
  deut: 'url(#pds-cvd-deut)',
  prot: 'url(#pds-cvd-prot)',
  trit: 'url(#pds-cvd-trit)',
  gray: 'grayscale(1)',
};

/** Foto principale dell'anteprima: Unsplash in hotlink o data URL locale. */
export function HeroImage({ photo, alt, className, t }: { photo: ToolPhoto | null; alt: string; className?: string; t: ToolStrings }) {
  if (!photo) return null;
  if (photo.kind === 'unsplash') {
    return (
      <UnsplashImg
        photo={photo.photo}
        clusters={photo.clusters}
        size="regular"
        alt={alt}
        className={className}
        bandsClassName={`${className ?? ''} ${styles.bands}`}
        brokenLabel={t.photoBroken}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- data URL generato nel browser
  return <img src={photo.dataUrl} alt={alt} className={className} width={480} height={360} />;
}

/** Nome dell'attività o logo dell'utente. */
export function Brand({ name, logoUrl, plate = false }: { name: string; logoUrl: string | null; plate?: boolean }) {
  if (!logoUrl) return <>{name}</>;
  // eslint-disable-next-line @next/next/no-img-element -- data URL generato nel browser
  const img = <img src={logoUrl} alt={name} />;
  return plate ? <span className={styles.mkPlate}>{img}</span> : img;
}

/** Home di esempio con palette e stile applicati (tool e pagina `condividi`). */
export function SamplePreview({
  t,
  copy,
  preset,
  vars,
  vision = 'none',
  hero,
  logoUrl,
  fallbackColors,
}: {
  t: ToolStrings;
  copy: SectorCopy;
  preset: PresetKey;
  vars: CSSProperties;
  vision?: VisionMode;
  hero: ToolPhoto | null;
  logoUrl: string | null;
  /** Fasce colore al posto della foto, quando non ce n'è una. */
  fallbackColors?: readonly string[];
}) {
  return (
    <div className={styles.pv} data-preset={preset} style={{ ...vars, filter: VISION_FILTER[vision] }}>
      <div className={styles.pvNav}>
        <span className={styles.pvLogo}>
          <Brand name={copy.name} logoUrl={logoUrl} />
        </span>
        <span className={styles.pvLinks}>
          {t.previewLinks.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
        <span className={`${styles.pvBtn} ${styles.pvBtnSm}`}>{copy.nav}</span>
      </div>
      <div className={styles.pvHero}>
        <div>
          <p className={styles.pvEyebrow}>{copy.eyebrow}</p>
          <p className={styles.pvH1}>{copy.h1}</p>
          <p className={styles.pvLead}>{copy.lead}</p>
          <div className={styles.pvCtas}>
            <span className={styles.pvBtn}>{copy.btn1}</span>
            <span className={`${styles.pvBtn} ${styles.pvBtn2}`}>{copy.btn2}</span>
          </div>
        </div>
        <div className={styles.pvMedia}>
          {hero ? (
            <HeroImage photo={hero} alt={t.previewImgAlt} t={t} />
          ) : fallbackColors?.length ? (
            <div className={styles.bands} aria-hidden="true">
              {fallbackColors.map((hex) => (
                <span key={hex} style={{ background: hex, width: `${100 / fallbackColors.length}%` }} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.pvCards}>
        {copy.cards.map((c) => (
          <div key={c.title} className={styles.pvCard}>
            <span className={styles.pvCardT}>{c.title}</span>
            <p>{c.description}</p>
            <span className={styles.pvMeta}>{c.meta}</span>
          </div>
        ))}
      </div>
      <div className={styles.pvBanner}>{copy.banner}</div>
    </div>
  );
}

/** Cornice "browser" dell'anteprima con la barra in alto. */
export function PreviewFrame({ t, presetName, children }: { t: ToolStrings; presetName: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border" style={{ borderColor: 'var(--color-line-strong)' }}>
      <div
        className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b px-3.5 py-2.5"
        style={{ borderColor: 'var(--color-line-strong)', background: 'var(--color-bg-elev)' }}
      >
        <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
          {t.previewBar}
        </MonoLabel>
        <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
          {t.previewStyle(presetName)}
        </MonoLabel>
      </div>
      {children}
    </div>
  );
}
