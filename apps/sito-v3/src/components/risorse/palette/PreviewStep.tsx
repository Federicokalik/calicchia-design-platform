'use client';

import type { CSSProperties } from 'react';
import type { PresetKey } from '@calicchia/shared/palette';
import { MonoLabel } from '@/components/ui/MonoLabel';
import type { SectorCopy } from '@/data/risorse/palette/types';
import { PreviewFrame, SamplePreview } from './SamplePreview';
import type { ToolPhoto } from './state';
import type { ToolStrings, VisionMode } from './strings';
import { Chip, Step } from './ui';

const VISION_MODES: VisionMode[] = ['none', 'deut', 'prot', 'trit', 'gray'];

interface PreviewStepProps {
  t: ToolStrings;
  copy: SectorCopy;
  preset: PresetKey;
  presetName: string;
  vars: CSSProperties;
  vision: VisionMode;
  hero: ToolPhoto | null;
  logoUrl: string | null;
  onVision: (v: VisionMode) => void;
}

export function PreviewStep({ t, copy, preset, presetName, vars, vision, hero, logoUrl, onVision }: PreviewStepProps) {
  return (
    <Step n="05" id="pds-anteprima" title={t.previewTitle} help={t.previewHelp}>
      <div className="grid gap-2.5">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <MonoLabel as="span" id="pds-vision-label" style={{ lineHeight: 1.4 }}>
            {t.visionLabel}
          </MonoLabel>
          <MonoLabel as="span" style={{ lineHeight: 1.4 }}>
            {t.visionNote}
          </MonoLabel>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="pds-vision-label">
          {VISION_MODES.map((v) => (
            <Chip key={v} pressed={vision === v} onClick={() => onVision(v)}>
              {t.vision[v]}
            </Chip>
          ))}
        </div>
      </div>

      <PreviewFrame t={t} presetName={presetName}>
        <SamplePreview t={t} copy={copy} preset={preset} vars={vars} vision={vision} hero={hero} logoUrl={logoUrl} />
      </PreviewFrame>
    </Step>
  );
}
