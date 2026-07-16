/**
 * Deterministic parser for STRUCTURED quote briefs in Markdown.
 *
 * When the brief follows the house convention (YAML frontmatter + the
 * headings below), this parses it into the editor's section model with zero
 * LLM involvement: instant, free, and faithful to the cent. Free-form briefs
 * return null and fall back to the LLM extraction path.
 *
 * Recognized structure (see preventivo-taxi-ncc.md as the reference):
 *   frontmatter: oggetto, cliente, cliente_piva, referente, data,
 *                validita_giorni, sottotitolo?
 *   ## Oggetto                  → premessa (testo)
 *   ## Cosa include             → include[] of the first/main offerta
 *   ## Dettaglio economico      → | Voce | Importo | table → offerte
 *                                 (righe "Totale…" ignorate; sconti = prezzo negativo)
 *   ## Modalità di pagamento    → | Modalità | Importo | table → pagamento
 *                                 (rate da pattern "NN% <momento>" nel testo)
 *   ## Materiali*               → materiali (bullet list)
 *   ## Tempistiche / Consegna   → tempistiche (prima riga utile)
 *   ## Validità                 → notes
 *   qualsiasi altro H2          → clausole (warning se contiene ⚠️, altrimenti info)
 */

export interface ParsedSection {
  type: string;
  data: Record<string, unknown>;
}

export interface ParsedQuote {
  title: string;
  description?: string;
  sections: ParsedSection[];
  notes?: string;
  premessa?: string;
  valid_until?: string;
}

interface MdBlock {
  heading: string; // without '## '
  lines: string[];
}

/** "€ 790", "**€ 999**", "− € 350", "€ 216,33", "1.234,56" → number (negative for −). */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\*/g, '').trim();
  const m = /([−-])?\s*€\s*([\d.][\d.,]*)/.exec(cleaned);
  if (!m) return null;
  const negative = m[1] !== undefined || /[−-]\s*€/.test(cleaned);
  let num = m[2];
  // it-IT: '.' thousands, ',' decimals — normalize.
  if (num.includes(',')) num = num.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(?:\D|$)/.test(num)) num = num.replace(/\./g, '');
  const value = parseFloat(num);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function splitBlocks(body: string): { intro: string[]; blocks: MdBlock[] } {
  const lines = body.split(/\r?\n/);
  const intro: string[] = [];
  const blocks: MdBlock[] = [];
  let current: MdBlock | null = null;
  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      current = { heading: stripMd(h2[1]), lines: [] };
      blocks.push(current);
      continue;
    }
    if (/^#\s+/.test(line) || /^---\s*$/.test(line)) continue; // H1 / hr
    if (current) current.lines.push(line);
    else intro.push(line);
  }
  return { intro, blocks };
}

function tableRows(lines: string[]): string[][] {
  return lines
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 2 && !cells.every((c) => /^[:\-\s]*$/.test(c)));
}

function bullets(lines: string[]): string[] {
  return lines
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => stripMd(l.replace(/^\s*[-*]\s+/, '')));
}

function paragraphs(lines: string[]): string {
  return lines
    .filter((l) => !/^\s*[-*]\s+/.test(l) && !l.trim().startsWith('|') && !l.trim().startsWith('>'))
    .map((l) => stripMd(l))
    .filter(Boolean)
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function quotes(lines: string[]): string {
  return lines
    .filter((l) => l.trim().startsWith('>'))
    .map((l) => stripMd(l.replace(/^\s*>\s?/, '')))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function matchesAny(heading: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(heading));
}

const H_OGGETTO = [/^oggetto/i, /^premessa/i, /^descrizione/i];
const H_INCLUDE = [/cosa include/i, /^incluso/i, /^include/i];
const H_ECONOMICO = [/dettaglio economico/i, /^prezz/i, /economic/i, /^investimento/i];
const H_PAGAMENTO = [/pagamento/i];
const H_MATERIALI = [/^material/i];
const H_TEMPISTICHE = [/tempistich/i, /consegna/i, /tempi\b/i];
const H_VALIDITA = [/^validit/i];

/**
 * Try the deterministic parse. Returns null when the brief doesn't follow the
 * convention (caller falls back to the LLM).
 */
export function parseStructuredQuoteMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): ParsedQuote | null {
  const { blocks } = splitBlocks(body);
  if (!blocks.length) return null;

  const economico = blocks.find((b) => matchesAny(b.heading, H_ECONOMICO));
  if (!economico) return null;

  // --- Offerte from the price table -----------------------------------------
  const includeList = blocks.find((b) => matchesAny(b.heading, H_INCLUDE));
  const include = includeList ? bullets(includeList.lines) : [];

  const offerte: Array<Record<string, unknown>> = [];
  for (const cells of tableRows(economico.lines)) {
    const nome = stripMd(cells[0]);
    if (!nome || /^voce$/i.test(nome) || /^total/i.test(nome)) continue;
    const amount = parseAmount(cells[1] ?? '');
    if (amount === null) continue;
    offerte.push({
      nome,
      descrizione: '',
      prezzo: amount,
      consigliata: false,
      include: [] as string[],
      esclude: [] as string[],
    });
  }
  if (!offerte.length) return null;
  // The "Cosa include" bullets describe the whole package → attach to the
  // first (main) voice, which is also the highlighted one.
  offerte[0].include = include;
  offerte[0].consigliata = true;

  const sections: ParsedSection[] = [];

  // --- Premessa --------------------------------------------------------------
  const oggettoBlock = blocks.find((b) => matchesAny(b.heading, H_OGGETTO));
  if (oggettoBlock) {
    const testo = paragraphs(oggettoBlock.lines);
    if (testo) sections.push({ type: 'premessa', data: { testo, statistiche: [], problemi_critici: [] } });
  }

  sections.push({ type: 'offerte', data: { offerte } });

  // --- Pagamento --------------------------------------------------------------
  const totale = offerte.reduce((s, o) => s + (o.prezzo as number), 0);
  const pagamentoBlock = blocks.find((b) => matchesAny(b.heading, H_PAGAMENTO));
  if (pagamentoBlock) {
    const modalita: Array<Record<string, unknown>> = [];
    const sectionText = pagamentoBlock.lines.join(' ');
    // Explicit installment pattern anywhere in the section: "33% alla firma / …"
    const rateMatches = [...sectionText.matchAll(/(\d{1,2})%\s+((?:alla|a|al)\s+[^/|)\n]+)/gi)]
      .map((m) => ({ percentuale: parseInt(m[1], 10), momento: stripMd(m[2]).trim() }));

    for (const cells of tableRows(pagamentoBlock.lines)) {
      const nomeRaw = stripMd(cells[0]);
      if (!nomeRaw || /^modalit/i.test(nomeRaw)) continue;
      const amount = parseAmount(cells[1] ?? '');
      const nRate = /(\d+)\s*rate/i.exec(nomeRaw);
      const isSingle = !nRate;
      let sconto = 0;
      if (isSingle && amount !== null && totale > 0 && amount < totale) {
        sconto = Math.round((1 - amount / totale) * 1000) / 10;
      }
      modalita.push({
        nome: nomeRaw,
        sconto_percentuale: sconto,
        rate: !isSingle && rateMatches.length ? rateMatches : [],
      });
    }
    if (modalita.length) sections.push({ type: 'pagamento', data: { modalita } });
  }

  // --- Materiali / Tempistiche -------------------------------------------------
  const materialiBlock = blocks.find((b) => matchesAny(b.heading, H_MATERIALI));
  if (materialiBlock) {
    const lista = bullets(materialiBlock.lines);
    if (lista.length) sections.push({ type: 'materiali', data: { lista } });
  }

  const tempisticheBlock = blocks.find((b) => matchesAny(b.heading, H_TEMPISTICHE));
  if (tempisticheBlock) {
    const testo = paragraphs(tempisticheBlock.lines) || bullets(tempisticheBlock.lines).join(' · ');
    if (testo) {
      sections.push({ type: 'tempistiche', data: { prima_bozza: testo.split('\n')[0].slice(0, 120), nota: '' } });
    }
  }

  // --- Catch-all: every other H2 becomes a clausole box -----------------------
  const mapped = new Set([oggettoBlock, includeList, economico, pagamentoBlock, materialiBlock, tempisticheBlock]);
  const validitaBlock = blocks.find((b) => matchesAny(b.heading, H_VALIDITA));
  for (const block of blocks) {
    if (mapped.has(block) || block === validitaBlock) continue;
    const testo = paragraphs(block.lines);
    const quoted = quotes(block.lines);
    const lista = bullets(block.lines);
    // Add-on style tables → keep rows as list entries.
    const rows = tableRows(block.lines)
      .filter((cells) => !/^servizio|^voce/i.test(cells[0] || ''))
      .map((cells) => stripMd(cells.slice(0, 2).join(' — ')));
    const fullTesto = [testo, quoted].filter(Boolean).join(' ');
    const fullLista = [...lista, ...rows];
    if (!fullTesto && !fullLista.length) continue;
    const isWarning = /⚠️|attenzione|critic/i.test(block.lines.join(' ') + block.heading);
    sections.push({
      type: 'clausole',
      data: { tipo: isWarning ? 'warning' : 'info', titolo: block.heading, testo: fullTesto, lista: fullLista },
    });
  }

  // --- Header fields -----------------------------------------------------------
  const title = String(frontmatter.oggetto || frontmatter.titolo || '').trim()
    || stripMd((/^#\s+(.+)$/m.exec(body)?.[1] || 'Preventivo'));

  let valid_until: string | undefined;
  const baseDate = String(frontmatter.data || '').trim();
  const validityDays = parseInt(String(frontmatter.validita_giorni || ''), 10);
  if (baseDate && Number.isFinite(validityDays)) {
    const d = new Date(baseDate);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + validityDays);
      valid_until = d.toISOString().split('T')[0];
    }
  }

  const notes = validitaBlock ? paragraphs(validitaBlock.lines).split('\n')[0] : undefined;

  return {
    title,
    description: String(frontmatter.sottotitolo || '').trim() || undefined,
    sections,
    notes,
    valid_until,
  };
}
