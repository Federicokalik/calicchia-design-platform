interface StructuredDataProps {
  /** Plain JSON object (or array di oggetti) per JSON-LD. */
  json: object | object[];
}

/**
 * Renderer JSON-LD safe. Niente useEffect, niente client component:
 * inietta `<script type="application/ld+json">` server-side.
 *
 * Pattern: passa un singolo schema o un array (es. Article + FAQPage + Breadcrumb
 * sulla stessa pagina). Google legge tutti gli script della pagina, quindi più
 * istanze sono OK; uso un array per ridurre boilerplate.
 */
export function StructuredData({ json }: StructuredDataProps) {
  const items = Array.isArray(json) ? json : [json];
  return (
    <>
      {items.map((item, i) => (
        <script
          key={i}
          type="application/ld+json"
          // safe: oggetto plain server-side, niente input utente
          dangerouslySetInnerHTML={{ __html: JSON.stringify(item) }}
        />
      ))}
    </>
  );
}
