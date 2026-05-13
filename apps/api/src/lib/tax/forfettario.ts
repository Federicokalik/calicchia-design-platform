import { fileURLToPath } from 'node:url';

/**
 * Forfettario tax calculator (Italia).
 * Reference: L. 190/2014 art. 1 commi 54-89 e successive modifiche.
 */

export interface FreelancerStudioConfig {
  vat_regime?: 'forfettario' | 'ordinario' | 'none';
  forfettario_coefficient?: number;
  inps_rate?: number;
  irpef_substitute_rate?: number;
  forfettario_plafond_eur?: number;
}

export interface TaxComputation {
  gross_revenue_eur: number;
  taxable_eur: number;
  irpef_eur: number;
  inps_eur: number;
  total_due_eur: number;
  plafond_eur: number;
  plafond_percent: number; // 0-100, may exceed 100 if oltre soglia
  plafond_warning: 'ok' | 'approaching' | 'exceeded';
  effective_tax_rate: number; // 0-1, totale_due / gross
  regime: 'forfettario' | 'ordinario' | 'none';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeTaxes(grossRevenueEur: number, config: FreelancerStudioConfig): TaxComputation {
  const regime = config.vat_regime ?? 'forfettario';
  const coefficient = config.forfettario_coefficient ?? 0.78;
  const inpsRate = config.inps_rate ?? 0.2607;
  const irpefRate = config.irpef_substitute_rate ?? 0.05;
  const plafond = config.forfettario_plafond_eur ?? 85000;

  // Nel regime forfettario l'imponibile e' determinato applicando il
  // coefficiente di redditivita' previsto dalla L. 190/2014 al fatturato lordo.
  const taxable = regime === 'forfettario' ? grossRevenueEur * coefficient : 0;
  const irpef = regime === 'forfettario' ? taxable * irpefRate : 0;
  const inps = regime === 'forfettario' ? taxable * inpsRate : 0;
  const totalDue = irpef + inps;

  // La soglia di permanenza nel regime e' verificata sul fatturato lordo annuo
  // secondo i limiti aggiornati della disciplina forfettaria.
  const plafondPercent = plafond > 0 ? (grossRevenueEur / plafond) * 100 : 0;
  const plafondWarning = plafondPercent > 100
    ? 'exceeded'
    : plafondPercent >= 82
      ? 'approaching'
      : 'ok';

  return {
    gross_revenue_eur: round2(grossRevenueEur),
    taxable_eur: round2(taxable),
    irpef_eur: round2(irpef),
    inps_eur: round2(inps),
    total_due_eur: round2(totalDue),
    plafond_eur: round2(plafond),
    plafond_percent: round2(plafondPercent),
    plafond_warning: plafondWarning,
    effective_tax_rate: grossRevenueEur > 0 ? round2(totalDue / grossRevenueEur) : 0,
    regime,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Caso 1: forfettario, 30000€, coefficient 0.78, inps 0.2607, irpef 0.05
  // -> taxable=23400, irpef=1170, inps=6100.38, total=7270.38, plafond 35.29%, warning 'ok'
  // Caso 2: forfettario, 80000€ -> plafond 94.12%, warning 'approaching'
  // Caso 3: forfettario, 90000€ -> plafond 105.88%, warning 'exceeded'
  console.log(computeTaxes(30000, {}));
  console.log(computeTaxes(80000, {}));
  console.log(computeTaxes(90000, {}));
}
