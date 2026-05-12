import type { Metadata } from 'next';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { ManageBooking } from '@/components/booking/ManageBooking';
import { fetchBooking } from '@/lib/booking-api';

interface Params {
  uid: string;
}

interface Search {
  token?: string;
}

export const metadata: Metadata = {
  title: 'Prenotazione confermata',
  description: 'La tua chiamata è confermata. Ci sentiamo presto.',
  robots: { index: false, follow: false },
};

/**
 * /prenotazione/[uid] — pagina dual-mode:
 *   - SENZA `?token=`: pagina di conferma generica (post-redirect dal BookingWidget).
 *     Non possiamo fetchare il booking detail (richiede HMAC token, in arrivo via email).
 *   - CON `?token=`: ManageBooking completo (fetch detail + cancel / reschedule).
 */
export default async function PrenotazioneUidPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { uid } = await params;
  const sp = await searchParams;
  const token = sp.token;

  if (token) {
    const booking = await fetchBooking(uid, token);
    if (booking) {
      return (
        <article>
          <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-10 md:pb-14">
            <div className="grid grid-cols-12 gap-6 md:gap-8">
              <div className="col-span-12 md:col-span-9">
                <Eyebrow as="p" mono className="mb-6" tone="accent">
                  Manage prenotazione
                </Eyebrow>
                <Heading
                  as="h1"
                  size="display-lg"
                  className="mb-6"
                  style={{ maxWidth: '24ch' }}
                >
                  Modifica o cancella la prenotazione.
                </Heading>
              </div>
            </div>
          </header>
          <Section spacing="default">
            <ManageBooking booking={booking} token={token} />
          </Section>
        </article>
      );
    }
    // Token presente ma non valido o booking inesistente → cade in conferma generica
  }

  // Pagina di conferma generica post-redirect
  return (
    <article>
      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-10 md:pb-14">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9 md:col-start-1">
            <Eyebrow as="p" mono tone="accent" className="mb-6">
              Confermato
            </Eyebrow>

            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '16ch' }}
            >
              Ci vediamo presto.
            </Heading>

            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              La tua prenotazione è andata a buon fine. Ti ho mandato un&apos;email
              con il link per il meeting + il file `.ics` da aggiungere al
              calendario. Controlla anche la cartella spam, non si sa mai.
            </p>
          </div>
        </div>
      </header>

      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-1">
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <MonoLabel as="dt" className="mb-1">
                  ID prenotazione
                </MonoLabel>
                <dd
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-primary)',
                    wordBreak: 'break-all',
                  }}
                >
                  {uid}
                </dd>
              </div>
              <div>
                <MonoLabel as="dt" className="mb-1">
                  Modificare o cancellare
                </MonoLabel>
                <dd style={{ color: 'var(--color-text-primary)' }}>
                  Usa il link nell&apos;email di conferma. Oppure scrivimi: meglio
                  non farmi aspettare a vuoto.
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Section>

      <Section spacing="default" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-1 flex flex-wrap gap-6">
            <Button href="/" variant="solid" size="md">
              Torna alla home
              <span aria-hidden="true">→</span>
            </Button>
            <Button href="/lavori" variant="ghost" size="md">
              Intanto guarda i lavori
            </Button>
          </div>
        </div>
      </Section>
    </article>
  );
}
