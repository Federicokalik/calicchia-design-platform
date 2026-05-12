import type { Metadata } from 'next';
import { FaqAccordion } from '@/components/about/FaqAccordion';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Button } from '@/components/ui/Button';
import { FinalCTA } from '@/components/home/FinalCTA';
import { FAQS } from '@/data/faqs';

export const metadata: Metadata = {
  title: {
    absolute:
      'FAQ Web Design Freelance · Quello che le agenzie non vogliono che tu sappia | Federico Calicchia',
  },
  description:
    'Risposte secche a 7 domande sul web design freelance: tempi, processo, manutenzione, SEO, prezzi. Niente fronzoli, niente promesse vuote.',
  alternates: { canonical: '/faq' },
  openGraph: {
    title:
      'FAQ Web Design Freelance · Quello che le agenzie non vogliono che tu sappia',
    description:
      "Risposte secche a 7 domande su tempi, processo, manutenzione, SEO.",
    url: '/faq',
  },
};

/**
 * /faq — pagina dedicata FAQ con structured data FAQPage per Google.
 * Pattern: asymmetric left-aligned (eredita SWISS-RULES). 7 FAQ sotto-fold,
 * chapter rail saltata (caso degenere: 7 entry accordion non giustificano un
 * indice laterale separato — il pattern EditorialArticleLayout è usato per i
 * pillar longform).
 */
export default function FaqPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-12 md:pb-16">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9 md:col-start-1">
            <Breadcrumbs
              items={[
                { name: 'Home', url: '/' },
                { name: 'FAQ', url: '/faq' },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              {`FAQ — ${FAQS.length} domande frequenti`}
            </Eyebrow>
            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '20ch' }}
            >
              FAQ Web Design Freelance · Quello che nessuno ti dice.
            </Heading>
            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed"
              style={{ maxWidth: '55ch', color: 'var(--color-text-secondary)' }}
            >
              Risposte dirette su tempi, processo, manutenzione, SEO. Niente fronzoli,
              niente promesse vuote. Se non trovi quello che cerchi, scrivimi: rispondo
              io, non un bot.
            </p>
          </div>
        </div>
      </header>

      <section className="px-6 md:px-10 lg:px-14 pb-24 md:pb-32">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-3">
            <FaqAccordion faqs={FAQS} />

            <div className="mt-20 flex flex-wrap items-center gap-8">
              <Button href="/contatti" variant="underline" size="md">
                La tua domanda non è qui? Scrivimi
                <span aria-hidden="true">→</span>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <FinalCTA />
    </>
  );
}
