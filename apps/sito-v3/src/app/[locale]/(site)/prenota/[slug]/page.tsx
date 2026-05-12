import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { BookingWidget } from '@/components/booking/BookingWidget';
import { fetchEventType, fetchEventTypes } from '@/lib/booking-api';

interface Params {
  slug: string;
}

const STEPS = [
  {
    n: '01',
    t: 'Scegli orario',
    b: 'Solo slot disponibili. Conferma istantanea via email.',
  },
  {
    n: '02',
    t: 'Ti chiamo io',
    b: "All'orario concordato, sul link che ti invio. Niente download, niente registrazioni.",
  },
  {
    n: '03',
    t: 'Decidi tu',
    b: 'Se ti convinco, andiamo avanti. Se no, no — senza imbarazzo.',
  },
];

export async function generateStaticParams(): Promise<Params[]> {
  const list = await fetchEventTypes();
  return list.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const eventType = await fetchEventType(slug);
  if (!eventType) {
    return {
      title: 'Prenota una chiamata',
      description: 'Prenota una call diretta con me, senza intermediari.',
    };
  }
  return {
    title: `${eventType.title} — Prenota`,
    description:
      eventType.description ??
      'Prenota una call diretta con me, senza intermediari.',
    alternates: { canonical: `/prenota/${eventType.slug}` },
  };
}

export default async function PrenotaSlugPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const eventType = await fetchEventType(slug);
  if (!eventType) notFound();

  const locationLabel =
    eventType.location_type === 'google_meet'
      ? 'Google Meet'
      : eventType.location_type === 'phone'
      ? 'Telefono'
      : eventType.location_type === 'in_person'
      ? 'In presenza'
      : 'Link personalizzato';

  return (
    <article>
      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-10 md:pb-14">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            <Breadcrumbs
              items={[
                { name: 'Home', url: '/' },
                { name: 'Contatti', url: '/contatti' },
                { name: eventType.title, url: `/prenota/${eventType.slug}` },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              {`Prenota · ${eventType.duration_minutes} minuti`}
            </Eyebrow>
            <Heading
              as="h1"
              size="display-xl"
              className="mb-6"
              style={{ maxWidth: '20ch' }}
            >
              {eventType.title}
            </Heading>
            {eventType.description ? (
              <p
                className="text-[length:var(--text-body-lg)] leading-relaxed mb-6"
                style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
              >
                {eventType.description}
              </p>
            ) : null}

            <dl
              className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6 py-6 border-y"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <div>
                <MonoLabel as="dt" className="mb-1">Durata</MonoLabel>
                <dd style={{ color: 'var(--color-text-primary)' }}>
                  {eventType.duration_minutes} minuti
                </dd>
              </div>
              <div>
                <MonoLabel as="dt" className="mb-1">Modalità</MonoLabel>
                <dd style={{ color: 'var(--color-text-primary)' }}>
                  {locationLabel}
                </dd>
              </div>
              <div>
                <MonoLabel as="dt" className="mb-1">Preavviso minimo</MonoLabel>
                <dd style={{ color: 'var(--color-text-primary)' }}>
                  {eventType.min_notice_hours} ore
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </header>

      <Section spacing="default">
        <BookingWidget eventType={eventType} />
      </Section>

      <Section spacing="default" bordered="top">
        <Eyebrow as="p" mono className="mb-12">
          Come funziona
        </Eyebrow>
        <ol role="list" className="flex flex-col">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className="border-t py-8 grid grid-cols-12 gap-4"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <span
                aria-hidden="true"
                className="col-span-2 md:col-span-1 tabular-nums"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '2rem',
                  color: 'var(--color-accent-deep)',
                  fontWeight: 500,
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                }}
              >
                {s.n}
              </span>
              <div className="col-span-10 md:col-span-11">
                <Heading as="h3" size="card" className="mb-3">
                  {s.t}
                </Heading>
                <p
                  className="text-base md:text-lg leading-relaxed"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {s.b}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-12">
          <Button href="/contatti" variant="underline" size="md">
            Torna ai contatti
            <span aria-hidden="true">→</span>
          </Button>
        </div>
      </Section>
    </article>
  );
}
