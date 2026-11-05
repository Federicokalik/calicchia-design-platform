/**
 * Importi di una proforma in regime forfettario (funzione pura, in centesimi).
 *
 * - Nessuna IVA (art. 1 c. 54-89 L. 190/2014).
 * - Rivalsa dell'imposta di bollo: se l'imponibile supera la soglia
 *   (77,47 €, strettamente maggiore) si aggiunge la riga `stamp_duty` di
 *   2,00 €, compresa nel totale (decisione 3). Il bollo è poi assolto in modo
 *   virtuale sulla fattura (DatiBollo nell'XML SDI).
 * - quantity fino a 3 decimali, prezzi in centesimi interi: nessun float
 *   negli importi salvati.
 */

export type ProformaLineKind = 'service' | 'domain_renewal' | 'stamp_duty';

export interface ProformaLineInput {
  kind?: 'service' | 'domain_renewal';
  description: string;
  quantity: number;
  unit_price_cents: number;
  domain_id?: string;
  years?: number;
}

export interface ProformaLine {
  kind: ProformaLineKind;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  domain_id?: string;
  years?: number;
}

export interface ProformaTotals {
  lines: ProformaLine[];
  subtotal_cents: number;
  stamp_duty_cents: number;
  total_cents: number;
}

export interface StampDutyRule {
  /** Soglia in centesimi (7747 = 77,47 €). */
  threshold_cents: number;
  /** Importo in centesimi (200 = 2,00 €). */
  amount_cents: number;
}

export const STAMP_DUTY_DESCRIPTION = "Rivalsa imposta di bollo (assolta in modo virtuale sulla fattura)";

export function computeProformaTotals(
  inputs: readonly ProformaLineInput[],
  opts: { applyStampDuty: boolean; stampDuty: StampDutyRule },
): ProformaTotals {
  const lines: ProformaLine[] = inputs.map((l) => ({
    kind: l.kind ?? 'service',
    description: l.description.trim(),
    quantity: l.quantity,
    unit_price_cents: l.unit_price_cents,
    amount_cents: Math.round(l.quantity * l.unit_price_cents),
    ...(l.domain_id ? { domain_id: l.domain_id } : {}),
    ...(l.years ? { years: l.years } : {}),
  }));
  const subtotal = lines.reduce((n, l) => n + l.amount_cents, 0);
  const stamp = opts.applyStampDuty && subtotal > opts.stampDuty.threshold_cents ? opts.stampDuty.amount_cents : 0;
  if (stamp) {
    lines.push({
      kind: 'stamp_duty',
      description: STAMP_DUTY_DESCRIPTION,
      quantity: 1,
      unit_price_cents: stamp,
      amount_cents: stamp,
    });
  }
  return { lines, subtotal_cents: subtotal, stamp_duty_cents: stamp, total_cents: subtotal + stamp };
}

/** Euro (numero o stringa "15,50") → centesimi interi; NaN se non valido. */
export function eurosToCents(value: number | string): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}
