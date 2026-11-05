/**
 * Numerazione delle proforma: "PF n/anno", progressivo annuale in
 * document_sequences (migrazione 168).
 *
 * - Automatico: UPDATE ... SET last_number = last_number + 1 RETURNING sulla
 *   riga (proforma, anno). Il lock di riga serializza le emissioni
 *   concorrenti; il numero e il cambio di stato della proforma stanno nella
 *   stessa transazione, quindi un rollback non brucia numeri.
 * - Indicato a mano (decisione 1): il numero deve essere libero nell'anno e
 *   la sequenza avanza a GREATEST(last_number, n), così il successivo
 *   automatico non lo riusa. Un numero più basso dell'ultimo riempie un
 *   buco, se è libero.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
type Tx = any;

export class ProformaNumberConflict extends Error {
  constructor(readonly year: number, readonly seq: number) {
    super(`Il numero PF ${seq}/${year} è già usato`);
    this.name = 'ProformaNumberConflict';
  }
}

export function formatProformaNumber(seq: number, year: number): string {
  return `PF ${seq}/${year}`;
}

/**
 * "3", 3, "3/2026", "PF 3/2026" → { seq, year? }. Restituisce null se non
 * riconosce il formato.
 */
export function parseProformaNumber(input: string | number): { seq: number; year?: number } | null {
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 ? { seq: input } : null;
  const m = /^\s*(?:PF\s*)?(\d{1,6})(?:\s*\/\s*(\d{4}))?\s*$/i.exec(input);
  if (!m) return null;
  const seq = Number(m[1]);
  if (seq <= 0) return null;
  return m[2] ? { seq, year: Number(m[2]) } : { seq };
}

export async function assignProformaNumber(tx: Tx, year: number, explicitSeq?: number): Promise<number> {
  await tx`
    INSERT INTO document_sequences (kind, year, last_number) VALUES ('proforma', ${year}, 0)
    ON CONFLICT (kind, year) DO NOTHING
  `;
  if (explicitSeq === undefined) {
    const [row] = await tx`
      UPDATE document_sequences SET last_number = last_number + 1
      WHERE kind = 'proforma' AND year = ${year}
      RETURNING last_number
    `;
    return row.last_number as number;
  }
  // Lock della sequenza prima del controllo, così due emissioni con lo
  // stesso numero manuale non passano entrambe.
  await tx`SELECT last_number FROM document_sequences WHERE kind = 'proforma' AND year = ${year} FOR UPDATE`;
  const [taken] = await tx`SELECT 1 FROM proformas WHERE year = ${year} AND seq = ${explicitSeq} LIMIT 1`;
  if (taken) throw new ProformaNumberConflict(year, explicitSeq);
  await tx`
    UPDATE document_sequences SET last_number = GREATEST(last_number, ${explicitSeq}::int)
    WHERE kind = 'proforma' AND year = ${year}
  `;
  return explicitSeq;
}
