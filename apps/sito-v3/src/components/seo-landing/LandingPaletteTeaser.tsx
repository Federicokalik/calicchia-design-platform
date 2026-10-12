import { getLocale } from 'next-intl/server';
import { hasPaletteSector } from '@/data/risorse/palette/sectors/slugs';
import type { Locale } from '@/lib/i18n';
import { Body } from '@/components/ui/Body';
import { Button } from '@/components/ui/Button';
import { Heading } from '@/components/ui/Heading';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Section } from '@/components/ui/Section';

interface LandingPaletteTeaserProps {
  /** Slug IT della professione: è anche lo slug del settore nel tool. */
  professionSlug: string;
  /** Etichetta della professione nella lingua della pagina, minuscola. */
  professionLabel: string;
}

const COPY: Record<Locale, { eyebrow: string; title: string; body: string; button: (label: string) => string }> = {
  it: {
    eyebrow: 'Strumento gratuito',
    title: 'La palette del tuo settore.',
    body: "Colori presi da foto reali del settore, un'anteprima del sito e il controllo del contrasto. Poi li esporti per Canva o per il codice.",
    button: (label) => `Vedi la palette per ${label}`,
  },
  en: {
    eyebrow: 'Free tool',
    title: "Your industry's colour palette.",
    body: 'Colours taken from real photos of the trade, a preview of your site and a contrast check. Then export them for Canva or for code.',
    button: (label) => `See the palette for ${label}`,
  },
};

/**
 * Box promozionale del tool "Palette di settore" nelle landing della matrice.
 * Compare solo se esiste il settore curato con lo slug della professione:
 * legge l'elenco leggero degli slug, mai i testi dei settori.
 * Il link usa lo slug IT anche in EN (le pagine settore hanno lo stesso slug);
 * il Link di next-intl aggiunge il prefisso /en.
 */
export async function LandingPaletteTeaser({ professionSlug, professionLabel }: LandingPaletteTeaserProps) {
  if (!hasPaletteSector(professionSlug)) return null;
  const locale = (await getLocale()) as Locale;
  const t = COPY[locale] ?? COPY.it;

  return (
    <Section spacing="compact" bordered="top">
      <div className="grid grid-cols-1 gap-10 md:grid-cols-12 md:gap-6">
        <div className="md:col-span-7">
          <MonoLabel as="p" className="mb-6 uppercase">
            {t.eyebrow}
          </MonoLabel>
          <Heading as="h2" size="display-sm" className="max-w-[20ch]">
            {t.title}
          </Heading>
          <Body size="lg" tone="secondary" className="mt-6 max-w-[55ch]">
            {t.body}
          </Body>
        </div>

        <div className="md:col-span-5 md:self-end">
          <Button
            href={`/risorse/palette-di-settore/${professionSlug}`}
            variant="ghost"
            size="lg"
            className="swiss-hover-card hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            {t.button(professionLabel)}
            <span aria-hidden>→</span>
          </Button>
        </div>
      </div>
    </Section>
  );
}
