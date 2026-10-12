import { ExternalLink } from 'lucide-react';
import { brandPaletteSchema, encodeSharedPalette, PRESETS } from '@calicchia/shared/palette';
import { SITE_URL } from '@/lib/public-urls';

/**
 * Palette che il lead ha portato dal tool "Palette di settore" (colonna
 * brand_palette). Restituisce null se assente o non valida, così si può
 * renderizzare sempre, come GeoAuditPanel.
 */
export function PalettePanel({ value }: { value: unknown }) {
  const parsed = brandPaletteSchema.safeParse(value);
  if (!parsed.success) return null;
  const palette = parsed.data;

  const shareQuery = encodeSharedPalette({
    v: palette.v,
    sector: palette.sector,
    preset: palette.preset,
    colors: palette.colors,
    primary: palette.primary,
  });
  const toolUrl = `${SITE_URL}/risorse/palette-di-settore/condividi?${shareQuery}`;

  return (
    <div className="space-y-3 pt-2 border-t">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Palette di settore</span>
        <span className="text-xs text-muted-foreground">
          {PRESETS[palette.preset].name.it}
          {palette.sector ? ` · ${palette.sector.replace(/-/g, ' ')}` : ''}
          {` · ${palette.locale.toUpperCase()}`}
        </span>
      </div>

      <div className="flex h-12 overflow-hidden rounded border" role="img" aria-label={`Palette: ${palette.colors.join(', ')}`}>
        {palette.colors.map((hex, i) => (
          <div
            key={`${hex}-${i}`}
            className="flex-1"
            style={{ background: hex }}
            title={i === palette.primary ? `${hex} (primario)` : hex}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        {palette.colors.map((hex, i) => (
          <span key={`${hex}-label-${i}`} className={i === palette.primary ? 'font-semibold text-foreground' : undefined}>
            {hex}
          </span>
        ))}
      </div>

      <a
        href={toolUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
      >
        Apri nel tool
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
