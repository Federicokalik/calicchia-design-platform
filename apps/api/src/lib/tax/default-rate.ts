/**
 * Aliquota IVA di default per fatture e preventivi, dall'unica fonte giusta:
 * il regime fiscale (freelancer.studio.vat_regime).
 *
 * - forfettario / none → 0: nessuna IVA (art. 1 c. 54-89 L. 190/2014);
 * - ordinario → billing.defaults.default_tax_rate (22 di default).
 *
 * Prima ogni percorso aveva il suo `?? 22` e le colonne tax_rate avevano
 * DEFAULT 22 (corretto dalla migrazione 170): le bozze nascevano al 22% con
 * imposta 0.
 */
import { loadSetting } from '../settings-store';

export type VatRegime = 'forfettario' | 'ordinario' | 'none';

export async function currentVatRegime(): Promise<VatRegime> {
  const studio = (await loadSetting('freelancer.studio')) as { vat_regime?: VatRegime };
  return studio.vat_regime ?? 'forfettario';
}

export async function defaultTaxRate(): Promise<number> {
  const regime = await currentVatRegime();
  if (regime !== 'ordinario') return 0;
  const billing = (await loadSetting('billing.defaults')) as { default_tax_rate?: number };
  return typeof billing.default_tax_rate === 'number' ? billing.default_tax_rate : 22;
}
