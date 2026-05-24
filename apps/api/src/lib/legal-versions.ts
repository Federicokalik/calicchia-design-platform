/**
 * Major version delle policy contrattuali esposte ai clienti dal portale.
 *
 * Bumpare un valore qui forza la ri-accettazione al prossimo login del cliente:
 * la lookup in `customer_legal_acceptances` filtra per la versione corrente,
 * quindi una nuova versione non trova righe pre-esistenti e il gate si
 * riattiva. Stringhe semplici per readability nei log e nei dump SQL.
 *
 * Quando bumpare:
 *  - Modifiche sostanziali ai T&C (es. cambio foro, durata, prezzi base).
 *  - Modifiche sostanziali al DPA (es. nuovo sub-processor non in lista,
 *    cambio policy retention, cambio garanzie per trasferimenti extra-UE).
 *  - NON bumpare per typo, refactor, riformulazione senza impatto sostanziale.
 *
 * Mirror in `apps/sito-v3/src/data/legal-content.ts` per coerenza FE/BE.
 */
export const LEGAL_MAJOR_VERSIONS = {
  'termini-e-condizioni': '1',
  'dpa-clienti': '1',
} as const;

export type LegalDocumentSlug = keyof typeof LEGAL_MAJOR_VERSIONS;

export const LEGAL_DOCUMENT_SLUGS: readonly LegalDocumentSlug[] = [
  'termini-e-condizioni',
  'dpa-clienti',
];

/**
 * Versione bootstrap: il "primo lancio" del gate. Mentre la coppia (T&C, DPA)
 * e` ferma a questa versione, i clienti che hanno gia` un preventivo
 * accettato/firmato vengono whitelisted (si presume che l'accettazione del
 * preventivo includa T&C+DPA via clausola di richiamo nella sez. 11 dei T&C).
 *
 * Quando uno dei due documenti supera BOOTSTRAP_VERSION (es. T&C passa da '1'
 * a '2'), il quote-bypass non vale piu` e tutti — anche chi ha quotes — devono
 * ri-accettare esplicitamente la nuova versione.
 */
export const BOOTSTRAP_VERSION = '1';

/** True se siamo ancora sul bootstrap: entrambi i documenti a versione '1'. */
export function isBootstrapPhase(): boolean {
  return Object.values(LEGAL_MAJOR_VERSIONS).every((v) => v === BOOTSTRAP_VERSION);
}
