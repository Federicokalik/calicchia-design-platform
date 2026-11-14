/**
 * Impostazioni usate da una proforma, lette da site_settings:
 * - quote.settings: brand (logo, colore), fornitore (ragione sociale,
 *   indirizzo, P.IVA, contatti, IBAN), diciture (nota_iva, marca_bollo_nota),
 *   soglia e importo del bollo. Sono le stesse dei preventivi;
 * - business.profile e billing.bank_accounts come ripiego per P.IVA,
 *   indirizzo e IBAN se quote.settings li lascia vuoti;
 * - freelancer.studio.vat_regime per il regime.
 *
 * All'emissione fornitore e diciture vengono congelati nella proforma
 * (metadata.supplier, legal_notes): una modifica successiva delle
 * impostazioni non cambia una proforma già emessa.
 */
import { loadSetting } from '../settings-store';
import { currentVatRegime, type VatRegime } from '../tax/default-rate';
import type { StampDutyRule } from './totals';

export const NOT_FISCAL_NOTICE = 'Documento non valido ai fini fiscali. La fattura sarà emessa al ricevimento del pagamento.';

export interface ProformaSupplier {
  name: string;
  address: string;
  vat_number: string;
  fiscal_code: string;
  email: string;
  phone: string;
  website: string;
  iban: string;
  bank: string;
  bic: string;
  holder: string;
  logo_url: string;
  color: string;
}

export interface ProformaSettings {
  regime: VatRegime;
  supplier: ProformaSupplier;
  notaIva: string;
  bolloNota: string;
  stampDuty: StampDutyRule;
  defaultDueDays: number;
}

type Rec = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function loadProformaSettings(): Promise<ProformaSettings> {
  const [quote, profile, banks, regime] = await Promise.all([
    loadSetting('quote.settings') as Promise<Rec>,
    loadSetting('business.profile') as Promise<Rec>,
    loadSetting('billing.bank_accounts') as Promise<Rec>,
    currentVatRegime(),
  ]);
  const address = (profile.address && typeof profile.address === 'object' ? profile.address : {}) as Rec;
  const profileAddress = [
    s(profile.address_street) || s(address.street),
    [s(profile.address_zip) || s(address.postal_code), s(profile.address_city) || s(address.city), s(profile.address_province)].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  const accounts = Array.isArray(banks.accounts) ? (banks.accounts as Rec[]) : [];
  const bank = accounts.find((a) => a.is_default) ?? accounts[0] ?? {};

  return {
    regime,
    supplier: {
      name: s(quote.ragione_sociale) || s(profile.legal_name) || s(profile.company_name),
      address: s(quote.indirizzo) || profileAddress,
      vat_number: s(quote.piva) || s(profile.vat_number),
      fiscal_code: s(profile.fiscal_code) || s(profile.tax_code),
      email: s(quote.email_fornitore) || s(profile.email),
      phone: s(quote.telefono) || s(profile.phone),
      website: s(quote.sito_web) || s(profile.website),
      iban: s(quote.iban) || s(bank.iban),
      bank: s(quote.banca) || s(bank.label),
      bic: s(quote.bic) || s(bank.bic),
      holder: s(bank.holder_name) || s(quote.ragione_sociale) || s(profile.legal_name) || s(profile.company_name),
      logo_url: s(quote.logo_url) || s(profile.logo_url),
      color: s(quote.colore_primario) || '#f57f44',
    },
    notaIva: s(quote.nota_iva),
    bolloNota: s(quote.marca_bollo_nota),
    stampDuty: {
      threshold_cents: Math.round(Number(quote.soglia_bollo ?? 77.47) * 100),
      amount_cents: Math.round(Number(quote.importo_bollo ?? 2) * 100),
    },
    defaultDueDays: 15,
  };
}

/** Diciture della proforma (snapshot in legal_notes). */
export function buildLegalNotes(settings: ProformaSettings, hasStampDuty: boolean): string {
  return [settings.notaIva, hasStampDuty ? settings.bolloNota : '', NOT_FISCAL_NOTICE].filter(Boolean).join('\n');
}
