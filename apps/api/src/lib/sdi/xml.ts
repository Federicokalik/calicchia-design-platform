import { fileURLToPath } from 'node:url';

export interface FatturaPAInvoice {
  id: string;
  invoice_number: string;
  issue_date: string;
  currency?: string;
  total: number;
  line_items: FatturaPALineItem[];
  notes?: string | null;
}

export interface FatturaPALineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface FatturaPACustomer {
  name: string;
  fiscal_code?: string;
  vat_number?: string;
  sdi_code?: string;
  pec_email?: string;
  address: {
    street: string;
    postal_code: string;
    city: string;
    province: string;
    country?: string;
  };
  is_company?: boolean;
}

export interface FatturaPAConfig {
  vat_number: string;
  fiscal_code: string;
  company_name?: string;
  first_name?: string;
  last_name?: string;
  address: {
    street: string;
    postal_code: string;
    city: string;
    province: string;
    country?: string;
  };
  regime_fiscale?: string;
  rea?: { ufficio: string; nrea: string };
  forfettario_reference?: string;
}

const DEFAULT_CURRENCY = 'EUR';
const DEFAULT_COUNTRY = 'IT';
const DEFAULT_REGIME_FISCALE = 'RF19';
const DEFAULT_FORFETTARIO_REFERENCE =
  "Operazione in franchigia da IVA ai sensi dell'art.1, commi 54-89, L. 190/2014";
const RIFERIMENTO_NORMATIVO = 'Art.1 commi 54-89 L. 190/2014 - Regime Forfettario';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function sanitizeVatNumber(value: string): string {
  return value.replace(/\s+/g, '');
}

function sanitizePostalCode(value: string): string {
  const digits = value.trim().replace(/\D/g, '');

  if (digits.length > 0) {
    return digits.length < 5 ? digits.padStart(5, '0') : digits;
  }

  return value.trim();
}

function sanitizeProvince(value: string): string {
  return value.trim().toUpperCase().slice(0, 2);
}

function country(value: string | undefined): string {
  return cleanOptional(value)?.toUpperCase() ?? DEFAULT_COUNTRY;
}

function deriveProgressivoInvio(id: string): string {
  const normalized = id.replace(/-/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return normalized.slice(0, 8) || '00001';
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function shouldUseDenominazione(customer: FatturaPACustomer): boolean {
  if (customer.is_company === true || cleanOptional(customer.vat_number) !== undefined) {
    return true;
  }

  return /\b(s\.?\s*r\.?\s*l\.?|srl|s\.?\s*p\.?\s*a\.?|spa|s\.?\s*n\.?\s*c\.?|snc|s\.?\s*a\.?\s*s\.?|sas)\b|&\s*c\.?/i.test(
    customer.name,
  );
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { firstName: '', lastName: '' };
  }

  if (parts.length === 1) {
    return { firstName: parts[0] ?? '', lastName: parts[0] ?? '' };
  }

  const [firstName, ...lastNameParts] = parts;
  return { firstName: firstName ?? '', lastName: lastNameParts.join(' ') };
}

function tag(name: string, value: string, indent: number): string {
  const spaces = ' '.repeat(indent);
  return `${spaces}<${name}>${escapeXml(value)}</${name}>`;
}

function optionalTag(name: string, value: string | undefined, indent: number): string[] {
  return value === undefined ? [] : [tag(name, value, indent)];
}

function cedenteAnagrafica(config: FatturaPAConfig): string[] {
  const companyName = cleanOptional(config.company_name);

  if (companyName !== undefined) {
    return [tag('Denominazione', companyName, 10)];
  }

  return [
    tag('Nome', cleanOptional(config.first_name) ?? '', 10),
    tag('Cognome', cleanOptional(config.last_name) ?? '', 10),
  ];
}

function cessionarioAnagrafica(customer: FatturaPACustomer): string[] {
  if (shouldUseDenominazione(customer)) {
    return [tag('Denominazione', customer.name.trim(), 10)];
  }

  const { firstName, lastName } = splitName(customer.name);
  return [tag('Nome', firstName, 10), tag('Cognome', lastName, 10)];
}

function lineItemXml(item: FatturaPALineItem, index: number): string[] {
  const amount = item.quantity * item.unit_price;

  return [
    '      <DettaglioLinee>',
    tag('NumeroLinea', String(index + 1), 8),
    tag('Descrizione', item.description, 8),
    tag('Quantita', formatAmount(item.quantity), 8),
    tag('PrezzoUnitario', formatAmount(item.unit_price), 8),
    tag('PrezzoTotale', formatAmount(amount), 8),
    tag('AliquotaIVA', '0.00', 8),
    tag('Natura', 'N2.2', 8),
    '      </DettaglioLinee>',
  ];
}

/**
 * Genera XML FatturaPA 1.2.2 per regime forfettario (esente IVA, Natura N2.2).
 *
 * Output: stringa XML completa con prolog '<?xml version="1.0" encoding="UTF-8"?>'.
 * Conforme allo schema FatturaElettronicaHeader/FatturaElettronicaBody.
 *
 * Riferimento normativo: L. 190/2014 art.1 commi 54-89 (regime forfettario).
 */
export function generateFatturaPAXml(
  invoice: FatturaPAInvoice,
  customer: FatturaPACustomer,
  config: FatturaPAConfig,
): string {
  const configVatNumber = sanitizeVatNumber(config.vat_number);
  const customerVatNumber = cleanOptional(customer.vat_number);
  const sanitizedCustomerVatNumber =
    customerVatNumber === undefined ? undefined : sanitizeVatNumber(customerVatNumber);
  const destinationCode = cleanOptional(customer.sdi_code) ?? '0000000';
  const pecEmail = cleanOptional(customer.pec_email);
  const progressivo = deriveProgressivoInvio(invoice.id);
  const forfettarioReference =
    cleanOptional(config.forfettario_reference) ?? DEFAULT_FORFETTARIO_REFERENCE;
  const notes = cleanOptional(invoice.notes);
  const riepilogoAmount = invoice.line_items.reduce(
    (total, item) => total + item.quantity * item.unit_price,
    0,
  );

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<p:FatturaElettronica',
    '  xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xsi:schemaLocation="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2 http://www.fatturapa.gov.it/export/fatturazione/sdi/fatturapa/v1.2/Schema_del_file_xml_FatturaPA_versione_1.2.2.xsd"',
    '  versione="FPR12">',
    '',
    '  <FatturaElettronicaHeader>',
    '    <DatiTrasmissione>',
    '      <IdTrasmittente>',
    tag('IdPaese', DEFAULT_COUNTRY, 8),
    tag('IdCodice', configVatNumber, 8),
    '      </IdTrasmittente>',
    tag('ProgressivoInvio', progressivo, 6),
    tag('FormatoTrasmissione', 'FPR12', 6),
    tag('CodiceDestinatario', destinationCode, 6),
    ...(destinationCode === '0000000' ? optionalTag('PECDestinatario', pecEmail, 6) : []),
    '    </DatiTrasmissione>',
    '',
    '    <CedentePrestatore>',
    '      <DatiAnagrafici>',
    '        <IdFiscaleIVA>',
    tag('IdPaese', DEFAULT_COUNTRY, 10),
    tag('IdCodice', configVatNumber, 10),
    '        </IdFiscaleIVA>',
    tag('CodiceFiscale', config.fiscal_code.trim(), 8),
    '        <Anagrafica>',
    ...cedenteAnagrafica(config),
    '        </Anagrafica>',
    tag('RegimeFiscale', cleanOptional(config.regime_fiscale) ?? DEFAULT_REGIME_FISCALE, 8),
    '      </DatiAnagrafici>',
    '      <Sede>',
    tag('Indirizzo', config.address.street, 8),
    tag('CAP', sanitizePostalCode(config.address.postal_code), 8),
    tag('Comune', config.address.city, 8),
    tag('Provincia', sanitizeProvince(config.address.province), 8),
    tag('Nazione', country(config.address.country), 8),
    '      </Sede>',
    ...(config.rea === undefined
      ? []
      : [
          '      <IscrizioneREA>',
          tag('Ufficio', config.rea.ufficio, 8),
          tag('NumeroREA', config.rea.nrea, 8),
          '      </IscrizioneREA>',
        ]),
    '    </CedentePrestatore>',
    '',
    '    <CessionarioCommittente>',
    '      <DatiAnagrafici>',
    ...(sanitizedCustomerVatNumber === undefined
      ? []
      : [
          '        <IdFiscaleIVA>',
          tag('IdPaese', DEFAULT_COUNTRY, 10),
          tag('IdCodice', sanitizedCustomerVatNumber, 10),
          '        </IdFiscaleIVA>',
        ]),
    ...optionalTag('CodiceFiscale', cleanOptional(customer.fiscal_code), 8),
    '        <Anagrafica>',
    ...cessionarioAnagrafica(customer),
    '        </Anagrafica>',
    '      </DatiAnagrafici>',
    '      <Sede>',
    tag('Indirizzo', customer.address.street, 8),
    tag('CAP', sanitizePostalCode(customer.address.postal_code), 8),
    tag('Comune', customer.address.city, 8),
    tag('Provincia', sanitizeProvince(customer.address.province), 8),
    tag('Nazione', country(customer.address.country), 8),
    '      </Sede>',
    '    </CessionarioCommittente>',
    '  </FatturaElettronicaHeader>',
    '',
    '  <FatturaElettronicaBody>',
    '    <DatiGenerali>',
    '      <DatiGeneraliDocumento>',
    tag('TipoDocumento', 'TD01', 8),
    tag('Divisa', cleanOptional(invoice.currency) ?? DEFAULT_CURRENCY, 8),
    tag('Data', invoice.issue_date, 8),
    tag('Numero', invoice.invoice_number, 8),
    tag('ImportoTotaleDocumento', formatAmount(invoice.total), 8),
    tag('Causale', forfettarioReference, 8),
    ...optionalTag('Causale', notes, 8),
    '      </DatiGeneraliDocumento>',
    '    </DatiGenerali>',
    '',
    '    <DatiBeniServizi>',
    ...invoice.line_items.flatMap(lineItemXml),
    '',
    '      <DatiRiepilogo>',
    tag('AliquotaIVA', '0.00', 8),
    tag('Natura', 'N2.2', 8),
    tag('ImponibileImporto', formatAmount(riepilogoAmount), 8),
    tag('Imposta', '0.00', 8),
    tag('EsigibilitaIVA', 'I', 8),
    tag('RiferimentoNormativo', RIFERIMENTO_NORMATIVO, 8),
    '      </DatiRiepilogo>',
    '    </DatiBeniServizi>',
    '  </FatturaElettronicaBody>',
    '</p:FatturaElettronica>',
  ];

  return `${lines.join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const xml = generateFatturaPAXml(
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      invoice_number: 'FT-2026-0042',
      issue_date: '2026-05-13',
      total: 1500,
      line_items: [
        { description: 'Sviluppo sito web', quantity: 1, unit_price: 1500, amount: 1500 },
      ],
    },
    {
      name: 'Mario Rossi',
      fiscal_code: 'RSSMRA80A01H501Z',
      address: { street: 'Via Roma 1', postal_code: '00100', city: 'Roma', province: 'RM' },
      sdi_code: '0000000',
      pec_email: 'mario@pec.it',
      is_company: false,
    },
    {
      vat_number: '03160480608',
      fiscal_code: 'CLCFRC85M01D810Y',
      first_name: 'Federico',
      last_name: 'Calicchia',
      address: { street: 'Via Scifelli 74', postal_code: '03023', city: 'Ceccano', province: 'FR' },
    },
  );
  console.log(xml);
}
