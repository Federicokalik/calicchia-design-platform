interface BlogBodyProps {
  /** HTML pre-rendered dal backend (sanitizzato lato API se trustato). */
  content: string;
  /** Se true, layout 2-col con TOC sticky (richiede BlogTOC montato fuori). */
  withTOC?: boolean;
}

/**
 * Renderer del corpo articolo.
 * NOTE: il backend `apps/api` produce HTML già pronto a partire dal markdown
 * editor del pannello admin. Si assume `content` trustato (server first-party).
 * Server Component — niente JS al client.
 *
 * Quando `withTOC` è true, BlogBody si limita a renderizzare l'article senza
 * max-width / mx-auto: la pagina contenitore gestisce la griglia 2-col.
 */
export function BlogBody({ content, withTOC = false }: BlogBodyProps) {
  const className = withTOC
    ? 'prose-blog'
    : 'prose-blog px-6 md:px-10 lg:px-14 py-16 md:py-24 max-w-[800px] mx-auto';

  return (
    <article
      data-blog-article
      className={className}
      style={{ color: 'var(--color-ink)' }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}
