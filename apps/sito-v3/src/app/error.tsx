'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import * as Sentry from '@sentry/nextjs';
import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isDev = process.env.NODE_ENV !== 'production';

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <Section spacingTop="epic" spacingBottom="epic">
      <div className="grid grid-cols-12 gap-x-6 gap-y-12">
        <div className="col-span-12 md:col-span-2">
          <Eyebrow mono>ERRORE 500 · SERVER</Eyebrow>
        </div>

        <div className="col-span-12 md:col-span-7 md:col-start-4">
          <Heading as="h1" size="display-xl">
            Qualcosa è esploso.
          </Heading>

          <p
            className="mt-8 max-w-[55ch] text-lg leading-relaxed md:text-xl"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Stavo facendo qualcosa, qualcosa si è rotto. Posso provare a
            ricaricare oppure scrivermi: di solito rispondo entro qualche ora.
          </p>

          <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <Button href="/" variant="solid">
              Torna alla home
            </Button>
            <button
              type="button"
              onClick={reset}
              className="border-b border-current px-0 py-2 text-sm font-medium uppercase tracking-[0.15em] transition-opacity hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-3"
            >
              Riprova
            </button>
            <Link
              href="/contatti"
              className="border-b border-current px-0 py-2 text-sm font-medium uppercase tracking-[0.15em] transition-opacity hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-3"
            >
              Scrivimi
            </Link>
          </div>

          {isDev && (
            <pre
              className="mt-12 overflow-auto whitespace-pre-wrap border-t pt-6 font-mono text-xs leading-relaxed"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {JSON.stringify(
                {
                  digest: error.digest ?? null,
                  message: error.message,
                },
                null,
                2,
              )}
            </pre>
          )}
        </div>
      </div>
    </Section>
  );
}
