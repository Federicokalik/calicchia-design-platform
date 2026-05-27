import sanitizeHtml from 'sanitize-html';

/**
 * Sanitize blog/article HTML before it is sent to a client that renders it
 * with `dangerouslySetInnerHTML` (finding SEC-03/ST-03).
 *
 * Strips <script>, inline event handlers and javascript: URLs while keeping the
 * formatting, image and (allowlisted) video-embed tags a blog post needs.
 * Applied at the public serving chokepoint so it covers admin-written,
 * AI-generated and imported content alike.
 */
export function sanitizeBlogHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'figure', 'figcaption', 'h1', 'h2', 'iframe',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      a: ['href', 'name', 'target', 'rel'],
      iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'title'],
      // div.demo-embed[data-demo-index] is the AI-demo placeholder the client
      // island BlogDemoIslands hydrates into an iframe (audit C-003). Without
      // this allowlist sanitize-html stripped the data- attr and the island
      // couldn't tell which demo to load.
      div: ['data-demo-index'],
      '*': ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedIframeHostnames: ['www.youtube.com', 'youtube.com', 'player.vimeo.com'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
}
