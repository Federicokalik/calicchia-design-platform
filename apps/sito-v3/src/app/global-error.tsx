'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * Swiss compliance audit 2026-05-09: ECCEZIONE TECNICA DOCUMENTATA.
 * global-error.tsx renderizza fuori dall'app shell quando l'intero React tree
 * fallisce: NON ha accesso a Tailwind, providers, design tokens, font Funnel.
 * Per questo motivo i token (--ink, --muted, --paper, --line, --accent) sono
 * ridichiarati inline e usa font system fallback. La duplicazione e' richiesta
 * dal contratto Next.js: deve essere zero-dependency self-contained HTML.
 * Se cambiano i token globali, aggiornare manualmente anche qui.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="it">
      <body>
        <style
          dangerouslySetInnerHTML={{
            __html: `
              :root {
                color-scheme: light;
                --ink: #111111;
                --muted: #66615c;
                --paper: #faf8f3;
                --line: #d8d2ca;
                --accent: #F57F44;
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                min-height: 100vh;
                background: var(--paper);
                color: var(--ink);
                font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              }
              main {
                min-height: 100vh;
                padding: clamp(48px, 8vw, 112px) clamp(24px, 5vw, 72px);
                display: grid;
                grid-template-columns: repeat(12, minmax(0, 1fr));
                gap: 24px;
                align-content: center;
              }
              section {
                grid-column: 3 / span 7;
              }
              p.label {
                margin: 0 0 28px;
                color: var(--muted);
                font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                letter-spacing: 0.22em;
                text-transform: uppercase;
              }
              h1 {
                margin: 0;
                font-size: clamp(44px, 8vw, 92px);
                line-height: 0.98;
                font-weight: 500;
                letter-spacing: 0;
              }
              p.lead {
                max-width: 55ch;
                margin: 28px 0 0;
                color: var(--muted);
                font-size: clamp(18px, 2vw, 22px);
                line-height: 1.55;
              }
              nav {
                display: flex;
                gap: 24px;
                align-items: center;
                flex-wrap: wrap;
                margin-top: 40px;
              }
              button,
              a {
                min-height: 44px;
                display: inline-flex;
                align-items: center;
                color: var(--ink);
                background: transparent;
                border: 0;
                border-bottom: 1px solid currentColor;
                padding: 0;
                font: 700 12px/1 ui-sans-serif, system-ui, sans-serif;
                letter-spacing: 0.16em;
                text-transform: uppercase;
                text-decoration: none;
                cursor: pointer;
              }
              button:focus-visible,
              a:focus-visible {
                outline: 2px solid var(--accent);
                outline-offset: 5px;
              }
              @media (max-width: 760px) {
                main { display: block; }
                section { max-width: 100%; }
              }
            `,
          }}
        />
        <main>
          <section>
            <p className="label">ERRORE GLOBALE · ROOT</p>
            <h1>Errore globale.</h1>
            <p className="lead">
              Il sito è momentaneamente inaccessibile. Riprovo tra poco.
            </p>
            <nav>
              <button type="button" onClick={reset}>
                Riprova
              </button>
              <a href="/">home</a>
            </nav>
          </section>
        </main>
      </body>
    </html>
  );
}
