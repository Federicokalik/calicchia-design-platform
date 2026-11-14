'use client';

import type { CSSProperties } from 'react';
import type { PresetKey } from '@calicchia/shared/palette';
import type { SectorCopy } from '@/data/risorse/palette/types';
import type { ToolPhoto } from './state';
import type { ToolStrings, VisionMode } from './strings';
import { Brand, HeroImage, VISION_FILTER } from './SamplePreview';
import { Step } from './ui';
import styles from './PaletteTool.module.css';

interface MockupsStepProps {
  t: ToolStrings;
  copy: SectorCopy;
  preset: PresetKey;
  vars: CSSProperties;
  vision: VisionMode;
  hero: ToolPhoto | null;
  logoUrl: string | null;
}

export function MockupsStep({ t, copy, preset, vars, vision, hero, logoUrl }: MockupsStepProps) {
  return (
    <Step n="06" id="pds-supporti" title={t.mockTitle} help={t.mockHelp}>
      <div className={styles.mk} data-preset={preset} style={{ ...vars, filter: VISION_FILTER[vision] }}>
        <figure>
          <div className={styles.mkPost}>
            <HeroImage photo={hero} alt="" className={styles.mkPostImg} t={t} />
            <div className={styles.mkPostBody}>
              <span className={styles.mkEyebrow}>{copy.eyebrow}</span>
              <span className={styles.mkPostH}>{copy.h1}</span>
              <span className={styles.mkPostFoot}>
                <span className={styles.mkBrand}>
                  <Brand name={copy.name} logoUrl={logoUrl} plate />
                </span>
                <span className={styles.mkChip}>{copy.nav}</span>
              </span>
            </div>
          </div>
          <figcaption>{t.mockPost}</figcaption>
        </figure>

        <div className={styles.mkCards}>
          <figure>
            <div className={`${styles.mkCard} ${styles.mkCardFront}`}>
              <span className={styles.mkBrand}>
                <Brand name={copy.name} logoUrl={logoUrl} />
              </span>
              <span className={styles.mkCardRole}>{copy.eyebrow}</span>
              <span className={styles.mkCardContacts}>
                {t.mockAddress[0]}
                <br />
                {t.mockAddress[1]}
              </span>
            </div>
            <figcaption>{t.mockCardFront}</figcaption>
          </figure>
          <figure>
            <div className={`${styles.mkCard} ${styles.mkCardBack}`}>
              <span className={styles.mkBrand}>{copy.name}</span>
            </div>
            <figcaption>{t.mockCardBack}</figcaption>
          </figure>
        </div>

        <figure className={styles.mkSignFig}>
          <div className={styles.mkSignboard} data-logo={logoUrl ? 'true' : 'false'}>
            <span className={styles.mkBrand}>
              <Brand name={copy.name} logoUrl={logoUrl} />
            </span>
            <span className={styles.mkSignSub}>{copy.eyebrow}</span>
          </div>
          <figcaption>{t.mockSign}</figcaption>
        </figure>
      </div>
    </Step>
  );
}
