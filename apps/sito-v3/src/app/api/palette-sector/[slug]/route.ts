import { NextResponse } from 'next/server';
import { getSectorContent } from '@/data/risorse/palette';

/**
 * Testi di un settore pronto per il tool "Palette di settore", caricati dal
 * browser quando si sceglie un settore dai chip o col testo libero. Così i
 * testi di tutti i settori non finiscono nel bundle client: arriva solo
 * quello scelto. Le foto stanno invece in `public/palette-data/{slug}.json`.
 */

interface Params {
  slug: string;
}

export async function GET(_request: Request, { params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const content = getSectorContent(slug);
  if (!content) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });
  }
  return NextResponse.json(
    {
      slug: content.slug,
      preset: content.preset,
      queriesEn: content.queriesEn,
      copy: content.copy,
    },
    {
      headers: {
        // I testi cambiano solo con un deploy.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      },
    },
  );
}
