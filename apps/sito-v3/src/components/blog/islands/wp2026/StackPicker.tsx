'use client';

import { useId, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { wp2026Copy } from './copy';

type Answers = { chi: string; shop: string; logica: string; host: string };

interface Pick {
  title: string;
  body: string;
}

/** Decision tree from the original article — same branches, localized copy. */
function pick({ chi, shop, logica, host }: Answers, locale: Locale): Pick {
  const en = locale === 'en';
  const woo = shop === 'piccolo' ? (en ? ' and WooCommerce' : ' e WooCommerce') : '';

  if (logica === 'core') {
    return en
      ? {
          title: 'Laravel or Next.js',
          body: 'The project is an application. Laravel if the complexity lives in the backend (roles, payments, queues, integrations), Next.js if it lives in the interface. Editorial content, if needed, goes into a headless CMS.',
        }
      : {
          title: 'Laravel o Next.js',
          body: "Il progetto è un'applicazione. Laravel se la complessità sta nel backend (ruoli, pagamenti, code, integrazioni), Next.js se sta nell'interfaccia. I contenuti editoriali, se servono, vanno in un CMS headless.",
        };
  }
  if (shop === 'grande') {
    return en
      ? {
          title: 'Headless e-commerce',
          body: 'With a large catalogue or marketplaces involved, it pays to separate the store from the frontend: Shopify with Hydrogen, or Medusa with Next.js if you need full control over the data.',
        }
      : {
          title: 'E-commerce headless',
          body: 'Con un catalogo ampio o i marketplace di mezzo, conviene separare il negozio dal frontend: Shopify con Hydrogen, oppure Medusa con Next.js se serve pieno controllo sui dati.',
        };
  }
  if (chi === 'cliente') {
    if (logica === 'media' || shop === 'piccolo') {
      if (host === 'vps') {
        return en
          ? {
              title: `WordPress with Roots${woo}`,
              body: "The client manages content from the WordPress admin, while the code stays structured with Bedrock, Sage and Acorn. The hosting allows Composer and automated deploys.",
            }
          : {
              title: `WordPress con Roots${woo}`,
              body: "Il cliente gestisce i contenuti dall'admin di WordPress, il codice resta strutturato con Bedrock, Sage e Acorn. L'hosting permette Composer e deploy automatici.",
            };
      }
      return en
        ? {
            title: `WordPress with a custom theme${woo}`,
            body: 'Shared hosting limits the use of Roots. A custom-built theme, a few carefully chosen plugins and a maintenance contract are the bare minimum.',
          }
        : {
            title: `WordPress con tema su misura${woo}`,
            body: "L'hosting condiviso limita l'uso di Roots. Un tema sviluppato su misura, pochi plugin scelti con cura e un contratto di manutenzione sono la base minima.",
          };
    }
    return en
      ? {
          title: 'WordPress',
          body: 'The value is in the editor and in the autonomy of whoever publishes. A block or custom theme, few plugins and regular updates.',
        }
      : {
          title: 'WordPress',
          body: "Il valore sta nell'editor e nell'autonomia di chi pubblica. Tema a blocchi o su misura, pochi plugin e aggiornamenti regolari.",
        };
  }
  if (shop === 'piccolo') {
    return en
      ? {
          title: 'Astro with Shopify as the backend',
          body: 'A very fast static site for the pages and Shopify for cart and payments. No server to maintain for the storefront.',
        }
      : {
          title: 'Astro con Shopify come backend',
          body: 'Un sito statico velocissimo per le pagine e Shopify per carrello e pagamenti. Niente server da mantenere per la parte vetrina.',
        };
  }
  if (logica === 'media') {
    return en
      ? {
          title: 'Astro with server functions',
          body: 'The site stays static; the few dynamic parts (forms, integrations) run as server endpoints or serverless functions.',
        }
      : {
          title: 'Astro con funzioni server',
          body: 'Il sito resta statico, le poche parti dinamiche (moduli, integrazioni) girano come endpoint server o funzioni serverless.',
        };
  }
  return en
    ? {
        title: 'Astro',
        body: 'Stable content updated by a developer: a static site is faster, safer and cheaper to maintain than any CMS.',
      }
    : {
        title: 'Astro',
        body: 'Contenuti stabili e aggiornati da uno sviluppatore: un sito statico è più veloce, più sicuro e costa meno da mantenere di qualsiasi CMS.',
      };
}

export default function StackPicker({ locale }: { locale: Locale }) {
  const copy = wp2026Copy(locale).picker;
  const uid = useId();
  const [answers, setAnswers] = useState<Answers>({
    chi: 'cliente',
    shop: 'no',
    logica: 'nessuna',
    host: 'condiviso',
  });
  const result = pick(answers, locale);

  return (
    <form className="bl-picker" onSubmit={(e) => e.preventDefault()}>
      <p className="bl-eyebrow">{copy.eyebrow}</p>
      {copy.questions.map((q) => (
        <fieldset key={q.name}>
          <legend>{q.legend}</legend>
          <div className="bl-picker-opts">
            {q.options.map((o) => {
              const id = `${uid}-${q.name}-${o.value}`;
              return (
                <label key={o.value} htmlFor={id}>
                  <input
                    id={id}
                    type="radio"
                    name={`${uid}-${q.name}`}
                    value={o.value}
                    checked={answers[q.name] === o.value}
                    onChange={() => setAnswers((a) => ({ ...a, [q.name]: o.value }))}
                  />
                  <span>{o.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="bl-picker-out" aria-live="polite">
        <p className="bl-eyebrow">{copy.resultLabel}</p>
        <p className="bl-picker-title">{result.title}</p>
        <p>{result.body}</p>
      </div>
    </form>
  );
}
