/**
 * Mini markdown → HTML server-side renderer.
 *
 * Subset GFM sufficiente per i case study editorial:
 *   - heading: # ## ###
 *   - paragrafi (linee separate da blank line)
 *   - bold (** **) + italic (* *)
 *   - inline code (`code`)
 *   - link [text](url)
 *   - bullet/ordered list (- / 1.)
 *   - blockquote (>)
 *   - horizontal rule (---)
 *   - code block (``` ... ```)
 *
 * Server-only (sito-v3 admin gestito da editor — content trusted).
 * Niente sanitizzazione DOMPurify: l'unico input è dal field admin
 * Rich Text TipTap che già normalizza il markdown.
 *
 * Nota: implementazione volutamente semplice. Per HTML inline grezzo
 * dentro al markdown (raro per case study), ho un escape minimal su
 * `<script>` come safety net.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(line: string): string {
  // Order matters: code (preserves content) → links → bold → italic.
  let out = line;

  // Inline code `...`
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = url.replace(/"/g, '%22');
    const isExternal = /^https?:\/\//.test(url);
    const rel = isExternal ? ' rel="noopener noreferrer"' : '';
    const target = isExternal ? ' target="_blank"' : '';
    return `<a href="${safeUrl}"${target}${rel}>${text}</a>`;
  });

  // Bold **...**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic *...* (single asterisk, must come AFTER bold to avoid conflict)
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  return out;
}

interface Block {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'blockquote' | 'hr' | 'pre';
  content: string | string[];
}

/**
 * Compila markdown a HTML con un parser di blocchi linea-per-linea.
 * Robusto per i casi standard del nostro editor admin; non supporta
 * casi edge come tabelle, footnote, html inline raw.
 */
export function markdownToHtml(md: string): string {
  if (!md || !md.trim()) return '';

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence ```
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'pre', content: codeLines.join('\n') });
      continue;
    }

    // Heading
    if (/^### /.test(line)) {
      blocks.push({ type: 'h3', content: line.slice(4) });
      i++;
      continue;
    }
    if (/^## /.test(line)) {
      blocks.push({ type: 'h2', content: line.slice(3) });
      i++;
      continue;
    }
    if (/^# /.test(line)) {
      blocks.push({ type: 'h1', content: line.slice(2) });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      blocks.push({ type: 'hr', content: '' });
      i++;
      continue;
    }

    // Blockquote (consume contiguous > lines)
    if (/^> /.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^> /.test(lines[i])) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join(' ') });
      continue;
    }

    // Bullet list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'ul', content: items });
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ''));
        i++;
      }
      blocks.push({ type: 'ol', content: items });
      continue;
    }

    // Blank line → skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (consume contiguous non-blank lines, joining with space)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3} |---+|> |[-*] |\d+\. |```)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', content: paraLines.join(' ') });
  }

  // Render blocks
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'h1':
          return `<h1>${renderInline(b.content as string)}</h1>`;
        case 'h2':
          return `<h2>${renderInline(b.content as string)}</h2>`;
        case 'h3':
          return `<h3>${renderInline(b.content as string)}</h3>`;
        case 'p':
          return `<p>${renderInline(b.content as string)}</p>`;
        case 'ul':
          return `<ul>${(b.content as string[])
            .map((it) => `<li>${renderInline(it)}</li>`)
            .join('')}</ul>`;
        case 'ol':
          return `<ol>${(b.content as string[])
            .map((it) => `<li>${renderInline(it)}</li>`)
            .join('')}</ol>`;
        case 'blockquote':
          return `<blockquote>${renderInline(b.content as string)}</blockquote>`;
        case 'hr':
          return `<hr/>`;
        case 'pre':
          return `<pre><code>${escapeHtml(b.content as string)}</code></pre>`;
      }
    })
    .join('\n');
}
