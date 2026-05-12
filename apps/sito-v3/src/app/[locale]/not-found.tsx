import { Button } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';

export default function NotFound() {
  return (
    <section className="min-h-[100dvh] px-6 md:px-10 lg:px-14 flex flex-col justify-center max-w-[1600px] mx-auto">
      <Eyebrow className="mb-6">404</Eyebrow>
      <Heading as="h1" size="display-xl" className="mb-8" style={{ maxWidth: '16ch' }}>
        Niente da vedere<br />qui.
      </Heading>
      <p
        className="text-lg leading-relaxed max-w-[50ch] mb-10"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        Hai seguito un link rotto, oppure ho cambiato qualcosa senza dirtelo. Dai
        un&apos;occhiata alla home.
      </p>
      <Button
        href="/"
        variant="solid"
        size="md"
        className="self-start"
        iconAfter={<span>→</span>}
      >
        Torna alla home
      </Button>
    </section>
  );
}
