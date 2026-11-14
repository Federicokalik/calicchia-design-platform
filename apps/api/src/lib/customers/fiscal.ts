/**
 * Dati fiscali del cliente: customers.vat_number, fiscal_code, sdi_code, pec
 * (migrazione 169). Prima erano chiavi di billing_address.
 *
 * - Normalizzazione: maiuscolo senza spazi/punti/trattini; "IT" + 11 cifre →
 *   11 cifre; PEC minuscolo.
 * - Validazione: P.IVA italiana con cifra di controllo; codice fiscale di 16
 *   caratteri con carattere di controllo (omocodie comprese) o di 11 cifre
 *   (persone giuridiche, stessa cifra di controllo della P.IVA); P.IVA estera
 *   con prefisso paese; codice SDI di 7 caratteri (6 per la PA).
 * - Compatibilità: l'API accetta ancora `billing_address.vat_number` & co.
 *   (li sposta sulle colonne) e nelle risposte li rimette anche dentro
 *   billing_address, così i client esistenti (admin, MCP) leggono gli stessi
 *   campi di prima.
 */
import { z } from 'zod';
import { parseOr400 } from '../validation';

export const FISCAL_COLUMNS = ['vat_number', 'fiscal_code', 'sdi_code', 'pec'] as const;
export type FiscalColumn = (typeof FISCAL_COLUMNS)[number];

/** Chiavi di billing_address che corrispondono a una colonna fiscale. */
export const LEGACY_FISCAL_KEYS: Readonly<Record<string, FiscalColumn>> = {
  vat_number: 'vat_number',
  fiscal_code: 'fiscal_code',
  sdi_code: 'sdi_code',
  codice_destinatario: 'sdi_code',
  pec: 'pec',
  pec_email: 'pec',
};

function stripSeparators(v: string): string {
  return v.replace(/[\s.\-/]/g, '').toUpperCase();
}

/** Cifra di controllo della P.IVA italiana (e del CF numerico delle persone giuridiche). */
export function isValidItalianVat(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^0{11}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let n = Number(digits[i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const CF_ODD: Record<string, number> = {
  0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

function cfEven(ch: string): number {
  return /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
}

/** Codice fiscale di 16 caratteri: struttura (con omocodie) e carattere di controllo. */
export function isValidPersonalFiscalCode(cf: string): boolean {
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(cf)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += i % 2 === 0 ? CF_ODD[cf[i]] : cfEven(cf[i]);
  return String.fromCharCode(65 + (sum % 26)) === cf[15];
}

export function normalizeVatNumber(raw: string): string {
  const v = stripSeparators(raw);
  return /^IT\d{11}$/.test(v) ? v.slice(2) : v;
}

export function vatNumberError(v: string): string | null {
  if (/^\d{11}$/.test(v)) return isValidItalianVat(v) ? null : 'partita IVA italiana non valida (cifra di controllo errata)';
  if (/^IT/.test(v)) return 'partita IVA italiana non valida: servono 11 cifre';
  if (/^[A-Z]{2}[0-9A-Z]{2,28}$/.test(v)) return null;
  return 'partita IVA non valida: 11 cifre per l\'Italia, oppure prefisso paese + codice (es. DE123456789)';
}

export function fiscalCodeError(v: string): string | null {
  if (/^\d{11}$/.test(v)) return isValidItalianVat(v) ? null : 'codice fiscale numerico non valido (cifra di controllo errata)';
  if (v.length === 16) return isValidPersonalFiscalCode(v) ? null : 'codice fiscale non valido (formato o carattere di controllo)';
  return 'codice fiscale non valido: 16 caratteri (persona) o 11 cifre (persona giuridica)';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Schemi zod: stringa vuota o null → null (cancella il dato). */
export const fiscalSchemas = {
  vat_number: z.preprocess(
    blankToNull,
    z.string().transform(normalizeVatNumber).superRefine((v, ctx) => {
      const err = vatNumberError(v);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }).nullable(),
  ),
  fiscal_code: z.preprocess(
    blankToNull,
    z.string().transform(stripSeparators).superRefine((v, ctx) => {
      const err = fiscalCodeError(v);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }).nullable(),
  ),
  sdi_code: z.preprocess(
    blankToNull,
    z.string().transform(stripSeparators).refine((v) => /^[A-Z0-9]{6,7}$/.test(v), 'codice SDI non valido: 7 caratteri (6 per la PA)').nullable(),
  ),
  pec: z.preprocess(
    blankToNull,
    z.string().trim().toLowerCase().refine((v) => EMAIL_RE.test(v), 'PEC non valida').nullable(),
  ),
} as const;

export type FiscalValues = Partial<Record<FiscalColumn, string | null>>;

/**
 * Separa da un patch di billing_address le chiavi fiscali (vat_number,
 * fiscal_code, sdi_code/codice_destinatario, pec/pec_email): restituisce il
 * patch senza di esse e i valori grezzi per le colonne.
 */
export function splitLegacyFiscalKeys(patch: Record<string, unknown>): {
  address: Record<string, unknown>;
  fiscal: Partial<Record<FiscalColumn, unknown>>;
} {
  const address: Record<string, unknown> = {};
  const fiscal: Partial<Record<FiscalColumn, unknown>> = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = LEGACY_FISCAL_KEYS[key];
    if (column) {
      // A parità di colonna vince la chiave canonica (vat_number su ..., pec su pec_email).
      if (!(column in fiscal) || key === column) fiscal[column] = value;
    } else {
      address[key] = value;
    }
  }
  return { address, fiscal };
}

/** Rimuove da billing_address le chiavi legacy delle colonne che si stanno scrivendo. */
export function dropLegacyKeys(address: Record<string, unknown>, columns: Iterable<FiscalColumn>): Record<string, unknown> {
  const drop = new Set(columns);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(address)) {
    const column = LEGACY_FISCAL_KEYS[key];
    if (!column || !drop.has(column)) out[key] = value;
  }
  return out;
}

/** Valori fiscali effettivi: colonna, altrimenti il valore legacy rimasto in billing_address. */
export function effectiveFiscal(row: {
  vat_number?: string | null;
  fiscal_code?: string | null;
  sdi_code?: string | null;
  pec?: string | null;
  billing_address?: unknown;
}): Record<FiscalColumn, string | null> {
  const billing = row.billing_address && typeof row.billing_address === 'object' && !Array.isArray(row.billing_address)
    ? (row.billing_address as Record<string, unknown>)
    : {};
  const legacy = (...keys: string[]) => {
    for (const k of keys) {
      const v = billing[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  return {
    vat_number: row.vat_number || legacy('vat_number'),
    fiscal_code: row.fiscal_code || legacy('fiscal_code'),
    sdi_code: row.sdi_code || legacy('sdi_code', 'codice_destinatario'),
    pec: row.pec || legacy('pec', 'pec_email'),
  };
}

/**
 * Cliente per le risposte API: colonne fiscali anche dentro billing_address
 * (compatibilità con chi legge billing_address.vat_number).
 */
export function withFiscalInBillingAddress<T extends Record<string, unknown>>(row: T): T {
  const billing = row.billing_address && typeof row.billing_address === 'object' && !Array.isArray(row.billing_address)
    ? (row.billing_address as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { ...billing };
  for (const col of FISCAL_COLUMNS) {
    const value = row[col];
    if (typeof value === 'string' && value) merged[col] = value;
  }
  return { ...row, billing_address: merged };
}

/**
 * Valori fiscali dal body: colonne top-level (vat_number, ...) oppure chiavi
 * legacy dentro billing_address (vat_number, pec_email, ...), validati con lo
 * stesso schema. A parità di campo vince il top-level.
 */
export function resolveFiscalInput(
  body: { billing_address?: Record<string, unknown> } & Partial<Record<FiscalColumn, string | null>>,
): { addressPatch: Record<string, unknown> | undefined; fiscal: Partial<Record<FiscalColumn, string | null>> } {
  const split: { address: Record<string, unknown> | undefined; fiscal: Partial<Record<FiscalColumn, unknown>> } = body.billing_address
    ? splitLegacyFiscalKeys(body.billing_address)
    : { address: undefined, fiscal: {} };
  const fiscal: Partial<Record<FiscalColumn, string | null>> = {};
  for (const col of FISCAL_COLUMNS) {
    if (body[col] !== undefined) {
      fiscal[col] = body[col] ?? null;
    } else if (col in split.fiscal) {
      fiscal[col] = parseOr400(fiscalSchemas[col], split.fiscal[col], {}, `Validazione fallita (billing_address.${col})`) as string | null;
    }
  }
  return { addressPatch: split.address, fiscal };
}
