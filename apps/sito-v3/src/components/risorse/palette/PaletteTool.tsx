'use client';

/**
 * Tool "Palette di settore" (/risorse/palette-di-settore).
 *
 * Porting del prototipo HTML: settore → foto → palette (k-means in OKLab,
 * motore in `@calicchia/shared/palette`) → stile → anteprima, supporti,
 * contrasti WCAG ed esportazione. Le foto Unsplash arrivano con i colori già
 * estratti (dati pre-calcolati o API): il browser non ne legge mai i pixel.
 * Logo e foto dell'utente restano nel browser.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  PRESETS,
  type FontKey,
  type PresetKey,
  type SharedPalette,
  deriveRoles,
  encodeSharedPalette,
  exportPalette,
  selectPalette,
  suggestPreset,
} from '@calicchia/shared/palette';
import type { SectorIndexEntry } from '@/data/risorse/palette/types';
import { trackEvent } from '@/lib/analytics/track-event';
import { localizedPath, type Locale } from '@/lib/i18n';
import { LogoError, type LogoErrorCode, processLogo } from '@/lib/palette/logo';
import { sanitizePhotos } from '@/lib/palette/photos';
import { readUserPhoto, simulatePhotos } from '@/lib/palette/simulate';
import { ContrastStep } from './ContrastStep';
import { ExportStep } from './ExportStep';
import { FinalCta } from './FinalCta';
import { MockupsStep } from './MockupsStep';
import { PaletteStep } from './PaletteStep';
import { PhotosStep } from './PhotosStep';
import { PreviewStep } from './PreviewStep';
import { CvdFilters } from './SamplePreview';
import { contactQuery } from './ContactButton';
import { fontStackVar, previewVars } from './preview-vars';
import { SectorStep } from './SectorStep';
import { StyleStep } from './StyleStep';
import {
  MAX_USER_PHOTOS,
  type SectorCopyResponse,
  type ToolSectorInit,
  capitalize,
  curatedSector,
  initState,
  matchSector,
  searchedSector,
  sectorPhotosOf,
  simulatedSector,
  toolReducer,
} from './state';
import { T, fmt2, genericCopy } from './strings';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SHARE_PATH = '/risorse/palette-di-settore/condividi';
const SEARCH_TIMEOUT_MS = 12000;

export interface PaletteToolProps {
  locale: Locale;
  /** Settori pronti (indice leggero): matching del testo libero. */
  sectorIndex: SectorIndexEntry[];
  /** Settori mostrati come chip. */
  chipSlugs: string[];
  /** Settore aperto al caricamento (pagina settore o primo settore pronto). */
  initialSector: ToolSectorInit | null;
  /** Testo iniziale quando non c'è un settore pronto: foto simulate. */
  defaultLabel: string;
  /** Font self-hosted dei quattro stili (vedi palette-di-settore/fonts.ts). */
  fonts: { className: string; vars: Record<FontKey, string> };
  /** Contenuti della pagina tra l'esportazione e la CTA finale (metodo, FAQ, indice). */
  children?: ReactNode;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Le linee guida di Unsplash chiedono di segnalare l'uso delle foto. Fire and
 * forget: nessun errore arriva alla pagina.
 */
function reportDownloads(ids: string[]): void {
  if (!ids.length) return;
  try {
    fetch(`${API_URL}/api/palette/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignorato */
  }
}

export function PaletteTool({ locale, sectorIndex, chipSlugs, initialSector, defaultLabel, fonts, children }: PaletteToolProps) {
  const t = T[locale];
  const [state, dispatch] = useReducer(toolReducer, null, () =>
    initState(
      initialSector
        ? curatedSector(initialSector)
        : simulatedSector(defaultLabel, genericCopy(capitalize(defaultLabel), locale), null),
    ),
  );
  const [logoError, setLogoError] = useState<LogoErrorCode | null>(null);
  const requestRef = useRef(0);

  const indexBySlug = useMemo(() => new Map(sectorIndex.map((s) => [s.slug, s])), [sectorIndex]);
  const chips = useMemo(
    () => chipSlugs.map((slug) => indexBySlug.get(slug)).filter((s): s is SectorIndexEntry => !!s),
    [chipSlugs, indexBySlug],
  );

  // Foto simulate: servono il canvas, quindi solo nel browser.
  const { sector, seed, simPhotos } = state;
  useEffect(() => {
    if (sector.source !== 'simulated' || simPhotos || !sector.mood) return;
    dispatch({ type: 'setSimPhotos', key: sector.key, seed, photos: simulatePhotos(sector.mood, seed) });
  }, [sector, seed, simPhotos]);

  // ---------- Settore ----------

  const loadSector = useCallback(
    async (slug: string) => {
      const entry = indexBySlug.get(slug);
      if (!entry) return;
      const rid = ++requestRef.current;
      dispatch({ type: 'loading', value: true });
      const [copyRes, photoRes] = await Promise.all([
        fetchJson<SectorCopyResponse>(`/api/palette-sector/${encodeURIComponent(slug)}`),
        fetchJson<{ photos?: unknown; queries?: unknown }>(`/palette-data/${encodeURIComponent(slug)}.json`),
      ]);
      if (rid !== requestRef.current) return;
      const label = entry.label[locale];
      const queries = Array.isArray(photoRes?.queries) ? photoRes.queries.filter((q): q is string => typeof q === 'string') : [];
      dispatch({
        type: 'setSector',
        sector: curatedSector({
          slug,
          label,
          preset: copyRes?.preset ?? null,
          queriesEn: copyRes?.queriesEn ?? queries,
          copy: copyRes?.copy?.[locale] ?? genericCopy(label, locale),
          photos: sanitizePhotos(photoRes?.photos),
        }),
      });
    },
    [indexBySlug, locale],
  );

  const pickSector = useCallback(
    (slug: string) => {
      trackEvent('palette_sector', { sector: slug, via: 'chip' });
      void loadSector(slug);
    },
    [loadSector],
  );

  const search = useCallback(
    async (text: string) => {
      const clean = text.trim().slice(0, 40);
      const slug = matchSector(clean, sectorIndex, locale);
      if (slug) {
        trackEvent('palette_search', { outcome: 'sector', sector: slug });
        trackEvent('palette_sector', { sector: slug, via: 'search' });
        await loadSector(slug);
        return;
      }
      const rid = ++requestRef.current;
      dispatch({ type: 'loading', value: true });
      const label = capitalize(clean);
      const data = await fetchJson<{ queryEn?: unknown; photos?: unknown }>(
        `${API_URL}/api/palette/search?q=${encodeURIComponent(clean)}&locale=${locale}`,
        { signal: timeoutSignal(SEARCH_TIMEOUT_MS), credentials: 'omit' },
      );
      if (rid !== requestRef.current) return;
      const photos = sanitizePhotos(data?.photos);
      if (photos.length) {
        const queryEn = typeof data?.queryEn === 'string' ? data.queryEn : null;
        dispatch({ type: 'setSector', sector: searchedSector(clean, genericCopy(label, locale), photos, queryEn) });
        trackEvent('palette_search', { outcome: 'photos' });
      } else {
        // API assente, in errore o senza risultati: foto simulate con colori generici.
        dispatch({
          type: 'setSector',
          sector: simulatedSector(clean, genericCopy(label, locale), { kind: 'simulated', text: clean }),
        });
        trackEvent('palette_search', { outcome: 'fallback' });
      }
    },
    [loadSector, locale, sectorIndex],
  );

  // ---------- Foto e logo ----------

  const addPhotos = useCallback((files: FileList | File[]) => {
    const list = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .slice(0, MAX_USER_PHOTOS);
    for (const file of list) {
      readUserPhoto(file)
        .then((p) => dispatch({ type: 'addUserPhoto', dataUrl: p.dataUrl, clusters: p.clusters }))
        .catch(() => {
          /* file illeggibile: ignorato, come nel prototipo */
        });
    }
  }, []);

  const onLogo = useCallback(async (file: File) => {
    setLogoError(null);
    try {
      const logo = await processLogo(file);
      dispatch({ type: 'setLogo', logo });
      trackEvent('palette_logo', { colors: logo.colors.length, bg_removed: logo.bgRemoved });
    } catch (err) {
      setLogoError(err instanceof LogoError ? err.code : 'unreadable');
    }
  }, []);

  // ---------- Palette, ruoli, stile ----------

  const sectorPhotos = useMemo(() => sectorPhotosOf(sector, seed, simPhotos), [sector, seed, simPhotos]);
  const allPhotos = useMemo(() => [...sectorPhotos, ...state.userPhotos], [sectorPhotos, state.userPhotos]);

  const palette = useMemo(() => {
    if (!allPhotos.length && !state.logo) return [];
    return selectPalette({
      photos: allPhotos.map((p) => ({ id: p.id, weight: p.kind === 'user' ? 2 : 1, clusters: p.clusters })),
      logoColors: state.logo?.colors,
      locked: state.locked,
    });
  }, [allPhotos, state.logo, state.locked]);

  const primaryHex = state.primaryHex && palette.some((p) => p.hex === state.primaryHex) ? state.primaryHex : null;
  const roles = useMemo(
    () => (palette.length ? deriveRoles(palette, { autofix: state.autofix, primaryHex }) : null),
    [palette, state.autofix, primaryHex],
  );
  const suggestion = useMemo(() => (palette.length ? suggestPreset(palette, sector.preset) : null), [palette, sector.preset]);
  const preset: PresetKey = state.presetChoice ?? suggestion?.key ?? sector.preset ?? 'netto';
  const presetDef = PRESETS[preset];

  const reason = suggestion
    ? t.reason({
        mapped: !!sector.slug,
        label: sector.label,
        temp: t.temperature[suggestion.temperature],
        sat: t.saturation[suggestion.saturation],
        chroma: fmt2(suggestion.avgChroma, locale),
        why: PRESETS[suggestion.key].why[locale],
      }) + (state.presetChoice && state.presetChoice !== suggestion.key ? t.picked(presetDef.name[locale]) : '')
    : '';

  const stackOf = useCallback((key: FontKey) => fontStackVar(fonts.vars, key), [fonts.vars]);
  const vars = useMemo<CSSProperties>(() => (roles ? previewVars(roles, preset, fonts.vars) : {}), [roles, preset, fonts.vars]);

  const hero = state.userPhotos[0] ?? sectorPhotos[0] ?? null;
  const lockedHexes = useMemo(() => new Set(state.locked.map((l) => l.hex)), [state.locked]);
  const fixedCount = palette.filter((p) => p.locked).length;

  // ---------- Esportazione, condivisione, contatto ----------

  const code = roles ? exportPalette(state.tab, { label: sector.label, palette, roles, preset, locale }) : '';

  const shared = useMemo<SharedPalette | null>(() => {
    if (!roles || palette.length < 2) return null;
    return {
      v: 1,
      // Solo settori pronti: il testo libero non entra mai nel link.
      ...(sector.slug ? { sector: sector.slug } : {}),
      preset,
      colors: palette.map((p) => p.hex),
      primary: Math.max(0, palette.findIndex((p) => p.hex === roles.primary)),
    };
  }, [roles, palette, sector.slug, preset]);
  const shareQuery = shared ? encodeSharedPalette(shared) : null;

  const contact = contactQuery(sector.slug, shareQuery);

  const unsplashIds = useMemo(
    () => sectorPhotos.filter((p) => p.kind === 'unsplash').map((p) => p.id),
    [sectorPhotos],
  );

  const status = t.status(sector.label, state.variant, state.locked.length);

  return (
    <div className={fonts.className}>
      <CvdFilters />
      <SectorStep
        t={t}
        locale={locale}
        sector={sector}
        chips={chips}
        loading={state.loading}
        onPick={pickSector}
        onSearch={search}
      />
      <PhotosStep
        t={t}
        label={sector.label}
        photos={allPhotos}
        loading={state.loading}
        logo={state.logo}
        logoError={logoError}
        onLogo={onLogo}
        onRemoveLogo={() => {
          setLogoError(null);
          dispatch({ type: 'setLogo', logo: null });
        }}
        onAddPhotos={addPhotos}
        onRemovePhoto={(id) => dispatch({ type: 'removeUserPhoto', id })}
      />

      {roles && suggestion ? (
        <>
          <PaletteStep
            t={t}
            locale={locale}
            palette={palette}
            roles={roles}
            lockedHexes={lockedHexes}
            status={status}
            regenDisabled={fixedCount >= palette.length || state.loading}
            onToggleLock={(hex, lab) => dispatch({ type: 'toggleLock', hex, lab })}
            onPrimary={(hex) => dispatch({ type: 'setPrimary', hex })}
            onRegenerate={() => dispatch({ type: 'regenerate' })}
          />
          <StyleStep
            t={t}
            locale={locale}
            preset={preset}
            suggested={suggestion.key}
            reason={reason}
            stackOf={stackOf}
            onPreset={(key) => dispatch({ type: 'setPreset', preset: key })}
          />
          <PreviewStep
            t={t}
            copy={sector.copy}
            preset={preset}
            presetName={presetDef.name[locale]}
            vars={vars}
            vision={state.vision}
            hero={hero}
            logoUrl={state.logo?.url ?? null}
            onVision={(vision) => dispatch({ type: 'setVision', vision })}
          />
          <MockupsStep
            t={t}
            copy={sector.copy}
            preset={preset}
            vars={vars}
            vision={state.vision}
            hero={hero}
            logoUrl={state.logo?.url ?? null}
          />
          <ContrastStep
            t={t}
            locale={locale}
            roles={roles}
            autofix={state.autofix}
            onAutofix={(value) => dispatch({ type: 'setAutofix', value })}
          />
          <ExportStep
            t={t}
            tab={state.tab}
            code={code}
            shareQuery={shareQuery}
            sharePath={localizedPath(SHARE_PATH, locale)}
            onTab={(tab) => dispatch({ type: 'setTab', tab })}
            onCopied={() => {
              trackEvent('palette_export', { format: state.tab });
              reportDownloads(unsplashIds);
            }}
            onShared={() => {
              trackEvent('palette_share', { sector: sector.slug ?? 'custom' });
              reportDownloads(unsplashIds);
            }}
          />
        </>
      ) : (
        <div className="min-h-[60vh] border-t" style={{ borderColor: 'var(--color-line)' }} aria-hidden="true" />
      )}

      {children}

      <FinalCta
        t={t}
        query={contact}
        onClick={() => trackEvent('palette_contact', { sector: sector.slug ?? 'custom' })}
      />
    </div>
  );
}
