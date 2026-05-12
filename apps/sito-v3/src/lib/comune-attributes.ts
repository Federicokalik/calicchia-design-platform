/**
 * Tagging dei comuni per il routing dinamico /zone/{comune}/{service}.
 * Combina:
 *   - 10 top Ciociaria (TOP_10_COMUNI)
 *   - 110 capoluoghi (SEO_CITIES filter tipo:'capoluogo')
 *   - Dedup di Frosinone (entrambe le liste lo contengono)
 *
 * Gli attributi semantici alimentano `getComboContent(comune, service)`
 * in `comune-service-content.ts` per generare paragraph unici per ogni
 * combo (anti-doorway). Max 3 attributi semantici per comune (oltre
 * a `isCapoluogo` e `populationTier`) per mantenere il signal pulito.
 */

export interface ComuneAttributes {
  slug: string;
  nome: string;
  regione: string;
  isCapoluogo: boolean;
  /** Universita / poli accademici (Bologna, Padova, Pisa, Cassino, ecc.) */
  isUniversitaria: boolean;
  /** Polo industriale / produttivo (Modena, Bergamo, Cassino-Stellantis, ecc.) */
  isIndustriale: boolean;
  /** Destinazione turistica (Venezia, Firenze, Roma, Fiuggi, ecc.) */
  isTuristica: boolean;
  /** Patrimonio storico / arte (Roma, Firenze, Mantova, Anagni, ecc.) */
  isStorica: boolean;
  /** Termale / wellness (Fiuggi, Montecatini area; nessun capoluogo termale puro) */
  isTermale: boolean;
  /** Citta portuale / marittima (Genova, Napoli, Trieste, Bari, ecc.) */
  isPortuale: boolean;
  /** Tier popolazione: s <15k, m 15-50k, l 50-200k, xl >200k */
  populationTier: 's' | 'm' | 'l' | 'xl';
  /** True per i 10 top Ciociaria (TOP_10_COMUNI) */
  isCiociariaTop: boolean;
}

/**
 * Helper compatto per definire le entry. NON esposto fuori dal modulo.
 */
function c(
  slug: string,
  nome: string,
  regione: string,
  populationTier: ComuneAttributes['populationTier'],
  flags: Partial<Omit<ComuneAttributes, 'slug' | 'nome' | 'regione' | 'populationTier'>> = {},
): ComuneAttributes {
  return {
    slug,
    nome,
    regione,
    populationTier,
    isCapoluogo: flags.isCapoluogo ?? false,
    isUniversitaria: flags.isUniversitaria ?? false,
    isIndustriale: flags.isIndustriale ?? false,
    isTuristica: flags.isTuristica ?? false,
    isStorica: flags.isStorica ?? false,
    isTermale: flags.isTermale ?? false,
    isPortuale: flags.isPortuale ?? false,
    isCiociariaTop: flags.isCiociariaTop ?? false,
  };
}

const ENTRIES: ComuneAttributes[] = [
  // ─── CIOCIARIA TOP 10 ──────────────────────────────────────────────
  c('frosinone',     'Frosinone',     'Lazio', 'l', { isCapoluogo: true,  isIndustriale: true,                      isCiociariaTop: true }),
  c('cassino',       'Cassino',       'Lazio', 'm', { isUniversitaria: true, isIndustriale: true, isStorica: true, isCiociariaTop: true }),
  c('sora',          'Sora',          'Lazio', 'm', { isIndustriale: true,                                          isCiociariaTop: true }),
  c('alatri',        'Alatri',        'Lazio', 'm', { isStorica: true,    isTuristica: true,                        isCiociariaTop: true }),
  c('anagni',        'Anagni',        'Lazio', 'm', { isStorica: true,    isTuristica: true,                        isCiociariaTop: true }),
  c('ceccano',       'Ceccano',       'Lazio', 'm', { isIndustriale: true,                                          isCiociariaTop: true }),
  c('ferentino',     'Ferentino',     'Lazio', 'm', { isIndustriale: true, isStorica: true,                         isCiociariaTop: true }),
  c('veroli',        'Veroli',        'Lazio', 'm', { isStorica: true,                                              isCiociariaTop: true }),
  c('isola-del-liri','Isola del Liri','Lazio', 's', { isTuristica: true,  isIndustriale: true,                      isCiociariaTop: true }),
  c('fiuggi',        'Fiuggi',        'Lazio', 's', { isTermale: true,    isTuristica: true,                        isCiociariaTop: true }),

  // ─── ABRUZZO ───────────────────────────────────────────────────────
  c('l-aquila',  "L'Aquila",  'Abruzzo', 'l', { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('chieti',    'Chieti',    'Abruzzo', 'm', { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('pescara',   'Pescara',   'Abruzzo', 'l', { isCapoluogo: true, isPortuale: true,      isTuristica: true }),
  c('teramo',    'Teramo',    'Abruzzo', 'm', { isCapoluogo: true, isUniversitaria: true }),

  // ─── BASILICATA ────────────────────────────────────────────────────
  c('potenza',   'Potenza',   'Basilicata', 'm', { isCapoluogo: true, isUniversitaria: true }),
  c('matera',    'Matera',    'Basilicata', 'm', { isCapoluogo: true, isStorica: true,      isTuristica: true }),

  // ─── CALABRIA ──────────────────────────────────────────────────────
  c('catanzaro',         'Catanzaro',          'Calabria', 'm', { isCapoluogo: true, isUniversitaria: true }),
  c('cosenza',           'Cosenza',            'Calabria', 'm', { isCapoluogo: true, isUniversitaria: true }),
  c('crotone',           'Crotone',            'Calabria', 'm', { isCapoluogo: true, isPortuale: true,    isStorica: true }),
  c('reggio-di-calabria','Reggio di Calabria', 'Calabria', 'l', { isCapoluogo: true, isPortuale: true,    isUniversitaria: true }),
  c('vibo-valentia',     'Vibo Valentia',      'Calabria', 'm', { isCapoluogo: true, isTuristica: true }),

  // ─── CAMPANIA ──────────────────────────────────────────────────────
  c('napoli',    'Napoli',    'Campania', 'xl', { isCapoluogo: true, isPortuale: true, isUniversitaria: true, isTuristica: true }),
  c('avellino',  'Avellino',  'Campania', 'm',  { isCapoluogo: true, isIndustriale: true }),
  c('benevento', 'Benevento', 'Campania', 'm',  { isCapoluogo: true, isStorica: true,      isUniversitaria: true }),
  c('caserta',   'Caserta',   'Campania', 'l',  { isCapoluogo: true, isStorica: true,      isTuristica: true }),
  c('salerno',   'Salerno',   'Campania', 'l',  { isCapoluogo: true, isUniversitaria: true, isPortuale: true }),

  // ─── EMILIA-ROMAGNA ────────────────────────────────────────────────
  c('bologna',   'Bologna',           'Emilia-Romagna', 'xl', { isCapoluogo: true, isUniversitaria: true, isStorica: true,    isIndustriale: true }),
  c('ferrara',   'Ferrara',           'Emilia-Romagna', 'm',  { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('forli',     'Forli',             'Emilia-Romagna', 'l',  { isCapoluogo: true, isUniversitaria: true, isIndustriale: true }),
  c('modena',    'Modena',            'Emilia-Romagna', 'l',  { isCapoluogo: true, isIndustriale: true,   isUniversitaria: true }),
  c('parma',     'Parma',             'Emilia-Romagna', 'l',  { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('piacenza',  'Piacenza',          'Emilia-Romagna', 'l',  { isCapoluogo: true, isIndustriale: true,   isStorica: true }),
  c('ravenna',   'Ravenna',           'Emilia-Romagna', 'l',  { isCapoluogo: true, isStorica: true,       isPortuale: true }),
  c('reggio-nell-emilia', "Reggio nell'Emilia", 'Emilia-Romagna', 'l', { isCapoluogo: true, isIndustriale: true, isUniversitaria: true }),
  c('rimini',    'Rimini',            'Emilia-Romagna', 'l',  { isCapoluogo: true, isTuristica: true,     isPortuale: true }),

  // ─── FRIULI-VENEZIA GIULIA ─────────────────────────────────────────
  c('trieste',   'Trieste',   'Friuli-Venezia Giulia', 'l', { isCapoluogo: true, isPortuale: true, isUniversitaria: true, isStorica: true }),
  c('gorizia',   'Gorizia',   'Friuli-Venezia Giulia', 'm', { isCapoluogo: true, isStorica: true }),
  c('pordenone', 'Pordenone', 'Friuli-Venezia Giulia', 'm', { isCapoluogo: true, isIndustriale: true }),
  c('udine',     'Udine',     'Friuli-Venezia Giulia', 'm', { isCapoluogo: true, isUniversitaria: true, isStorica: true }),

  // ─── LAZIO ─────────────────────────────────────────────────────────
  c('roma',      'Roma',      'Lazio', 'xl', { isCapoluogo: true, isStorica: true, isTuristica: true, isUniversitaria: true }),
  c('latina',    'Latina',    'Lazio', 'l',  { isCapoluogo: true, isIndustriale: true, isPortuale: true }),
  c('rieti',     'Rieti',     'Lazio', 'm',  { isCapoluogo: true, isStorica: true }),
  c('viterbo',   'Viterbo',   'Lazio', 'm',  { isCapoluogo: true, isStorica: true, isTermale: true }),
  // Frosinone gia incluso nei top 10 sopra

  // ─── LIGURIA ───────────────────────────────────────────────────────
  c('genova',    'Genova',    'Liguria', 'xl', { isCapoluogo: true, isPortuale: true, isUniversitaria: true, isStorica: true }),
  c('imperia',   'Imperia',   'Liguria', 'm',  { isCapoluogo: true, isPortuale: true, isTuristica: true }),
  c('la-spezia', 'La Spezia', 'Liguria', 'l',  { isCapoluogo: true, isPortuale: true, isTuristica: true }),
  c('savona',    'Savona',    'Liguria', 'm',  { isCapoluogo: true, isPortuale: true, isTuristica: true }),

  // ─── LOMBARDIA ─────────────────────────────────────────────────────
  c('milano',    'Milano',    'Lombardia', 'xl', { isCapoluogo: true, isIndustriale: true, isUniversitaria: true, isTuristica: true }),
  c('bergamo',   'Bergamo',   'Lombardia', 'l',  { isCapoluogo: true, isIndustriale: true, isStorica: true }),
  c('brescia',   'Brescia',   'Lombardia', 'l',  { isCapoluogo: true, isIndustriale: true, isStorica: true }),
  c('como',      'Como',      'Lombardia', 'l',  { isCapoluogo: true, isTuristica: true,    isStorica: true }),
  c('cremona',   'Cremona',   'Lombardia', 'm',  { isCapoluogo: true, isStorica: true }),
  c('lecco',     'Lecco',     'Lombardia', 'm',  { isCapoluogo: true, isTuristica: true,    isIndustriale: true }),
  c('lodi',      'Lodi',      'Lombardia', 'm',  { isCapoluogo: true, isStorica: true }),
  c('mantova',   'Mantova',   'Lombardia', 'm',  { isCapoluogo: true, isStorica: true,      isTuristica: true }),
  c('monza',     'Monza',     'Lombardia', 'l',  { isCapoluogo: true, isIndustriale: true }),
  c('pavia',     'Pavia',     'Lombardia', 'm',  { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('sondrio',   'Sondrio',   'Lombardia', 's',  { isCapoluogo: true, isTuristica: true }),
  c('varese',    'Varese',    'Lombardia', 'm',  { isCapoluogo: true, isIndustriale: true,   isTuristica: true }),

  // ─── MARCHE ────────────────────────────────────────────────────────
  c('ancona',        'Ancona',        'Marche', 'l', { isCapoluogo: true, isPortuale: true, isUniversitaria: true }),
  c('ascoli-piceno', 'Ascoli Piceno', 'Marche', 'm', { isCapoluogo: true, isStorica: true }),
  c('fermo',         'Fermo',         'Marche', 'm', { isCapoluogo: true, isStorica: true }),
  c('macerata',      'Macerata',      'Marche', 'm', { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('pesaro',        'Pesaro',        'Marche', 'l', { isCapoluogo: true, isPortuale: true,      isTuristica: true }),

  // ─── MOLISE ────────────────────────────────────────────────────────
  c('campobasso', 'Campobasso', 'Molise', 'm', { isCapoluogo: true, isUniversitaria: true }),
  c('isernia',    'Isernia',    'Molise', 'm', { isCapoluogo: true, isStorica: true }),

  // ─── PIEMONTE ──────────────────────────────────────────────────────
  c('torino',      'Torino',      'Piemonte', 'xl', { isCapoluogo: true, isIndustriale: true, isUniversitaria: true, isStorica: true }),
  c('alessandria', 'Alessandria', 'Piemonte', 'm',  { isCapoluogo: true, isIndustriale: true }),
  c('asti',        'Asti',        'Piemonte', 'm',  { isCapoluogo: true, isStorica: true,      isTuristica: true }),
  c('biella',      'Biella',      'Piemonte', 'm',  { isCapoluogo: true, isIndustriale: true }),
  c('cuneo',       'Cuneo',       'Piemonte', 'm',  { isCapoluogo: true, isStorica: true }),
  c('novara',      'Novara',      'Piemonte', 'l',  { isCapoluogo: true, isIndustriale: true,   isUniversitaria: true }),
  c('verbania',    'Verbania',    'Piemonte', 's',  { isCapoluogo: true, isTuristica: true }),
  c('vercelli',    'Vercelli',    'Piemonte', 'm',  { isCapoluogo: true, isStorica: true }),

  // ─── PUGLIA ────────────────────────────────────────────────────────
  c('bari',      'Bari',      'Puglia', 'xl', { isCapoluogo: true, isPortuale: true, isUniversitaria: true, isIndustriale: true }),
  c('andria',    'Andria',    'Puglia', 'l',  { isCapoluogo: true, isStorica: true }),
  c('barletta',  'Barletta',  'Puglia', 'l',  { isCapoluogo: true, isPortuale: true,    isStorica: true }),
  c('brindisi',  'Brindisi',  'Puglia', 'l',  { isCapoluogo: true, isPortuale: true }),
  c('foggia',    'Foggia',    'Puglia', 'l',  { isCapoluogo: true, isUniversitaria: true }),
  c('lecce',     'Lecce',     'Puglia', 'l',  { isCapoluogo: true, isUniversitaria: true, isStorica: true,    isTuristica: true }),
  c('taranto',   'Taranto',   'Puglia', 'l',  { isCapoluogo: true, isPortuale: true,      isIndustriale: true }),
  c('trani',     'Trani',     'Puglia', 'm',  { isCapoluogo: true, isStorica: true,       isPortuale: true }),

  // ─── SARDEGNA ──────────────────────────────────────────────────────
  c('cagliari',  'Cagliari',  'Sardegna', 'l', { isCapoluogo: true, isPortuale: true, isUniversitaria: true, isStorica: true }),
  c('carbonia',  'Carbonia',  'Sardegna', 'm', { isCapoluogo: true, isIndustriale: true }),
  c('nuoro',     'Nuoro',     'Sardegna', 'm', { isCapoluogo: true, isStorica: true,      isTuristica: true }),
  c('oristano',  'Oristano',  'Sardegna', 'm', { isCapoluogo: true, isStorica: true }),
  c('sassari',   'Sassari',   'Sardegna', 'l', { isCapoluogo: true, isUniversitaria: true, isStorica: true }),

  // ─── SICILIA ───────────────────────────────────────────────────────
  c('palermo',       'Palermo',       'Sicilia', 'xl', { isCapoluogo: true, isPortuale: true,    isUniversitaria: true, isStorica: true }),
  c('agrigento',     'Agrigento',     'Sicilia', 'm',  { isCapoluogo: true, isStorica: true,     isTuristica: true }),
  c('caltanissetta', 'Caltanissetta', 'Sicilia', 'm',  { isCapoluogo: true, isStorica: true }),
  c('catania',       'Catania',       'Sicilia', 'xl', { isCapoluogo: true, isPortuale: true,    isUniversitaria: true, isStorica: true }),
  c('enna',          'Enna',          'Sicilia', 's',  { isCapoluogo: true, isStorica: true }),
  c('messina',       'Messina',       'Sicilia', 'xl', { isCapoluogo: true, isPortuale: true,    isUniversitaria: true }),
  c('ragusa',        'Ragusa',        'Sicilia', 'm',  { isCapoluogo: true, isStorica: true,     isTuristica: true }),
  c('siracusa',      'Siracusa',      'Sicilia', 'l',  { isCapoluogo: true, isStorica: true,     isTuristica: true,    isPortuale: true }),
  c('trapani',       'Trapani',       'Sicilia', 'm',  { isCapoluogo: true, isPortuale: true,    isTuristica: true }),

  // ─── TOSCANA ───────────────────────────────────────────────────────
  c('firenze',  'Firenze',  'Toscana', 'l', { isCapoluogo: true, isStorica: true,    isTuristica: true,    isUniversitaria: true }),
  c('arezzo',   'Arezzo',   'Toscana', 'm', { isCapoluogo: true, isStorica: true,    isTuristica: true }),
  c('grosseto', 'Grosseto', 'Toscana', 'm', { isCapoluogo: true, isTuristica: true }),
  c('livorno',  'Livorno',  'Toscana', 'l', { isCapoluogo: true, isPortuale: true,   isUniversitaria: true }),
  c('lucca',    'Lucca',    'Toscana', 'm', { isCapoluogo: true, isStorica: true,    isTuristica: true }),
  c('massa',    'Massa',    'Toscana', 'm', { isCapoluogo: true, isIndustriale: true, isPortuale: true }),
  c('pisa',     'Pisa',     'Toscana', 'l', { isCapoluogo: true, isUniversitaria: true, isStorica: true,    isTuristica: true }),
  c('pistoia',  'Pistoia',  'Toscana', 'm', { isCapoluogo: true, isStorica: true,    isIndustriale: true }),
  c('prato',    'Prato',    'Toscana', 'l', { isCapoluogo: true, isIndustriale: true }),
  c('siena',    'Siena',    'Toscana', 'm', { isCapoluogo: true, isUniversitaria: true, isStorica: true,    isTuristica: true }),

  // ─── TRENTINO-ALTO ADIGE ───────────────────────────────────────────
  c('trento',  'Trento',  'Trentino-Alto Adige', 'l', { isCapoluogo: true, isUniversitaria: true, isTuristica: true,    isStorica: true }),
  c('bolzano', 'Bolzano', 'Trentino-Alto Adige', 'l', { isCapoluogo: true, isTuristica: true,     isStorica: true }),

  // ─── UMBRIA ────────────────────────────────────────────────────────
  c('perugia', 'Perugia', 'Umbria', 'l', { isCapoluogo: true, isUniversitaria: true, isStorica: true,    isTuristica: true }),
  c('terni',   'Terni',   'Umbria', 'l', { isCapoluogo: true, isIndustriale: true }),

  // ─── VALLE D'AOSTA ─────────────────────────────────────────────────
  c('aosta',   'Aosta',   "Valle d'Aosta", 'm', { isCapoluogo: true, isStorica: true, isTuristica: true }),

  // ─── VENETO ────────────────────────────────────────────────────────
  c('venezia', 'Venezia', 'Veneto', 'l', { isCapoluogo: true, isPortuale: true,      isStorica: true,    isTuristica: true }),
  c('belluno', 'Belluno', 'Veneto', 'm', { isCapoluogo: true, isTuristica: true }),
  c('padova',  'Padova',  'Veneto', 'l', { isCapoluogo: true, isUniversitaria: true, isStorica: true }),
  c('rovigo',  'Rovigo',  'Veneto', 'm', { isCapoluogo: true, isStorica: true }),
  c('treviso', 'Treviso', 'Veneto', 'm', { isCapoluogo: true, isIndustriale: true,    isStorica: true }),
  c('verona',  'Verona',  'Veneto', 'l', { isCapoluogo: true, isStorica: true,        isTuristica: true,    isUniversitaria: true }),
  c('vicenza', 'Vicenza', 'Veneto', 'l', { isCapoluogo: true, isIndustriale: true,    isStorica: true }),
];

export const COMUNE_ATTRIBUTES: Record<string, ComuneAttributes> = Object.fromEntries(
  ENTRIES.map((e) => [e.slug, e]),
);

export const COMUNE_SLUGS: readonly string[] = ENTRIES.map((e) => e.slug);

export function getComuneAttributes(slug: string): ComuneAttributes | undefined {
  return COMUNE_ATTRIBUTES[slug];
}

/** Tutti i comuni con almeno una pagina /zone/{slug}/{service} attiva. */
export function getAllRoutableComuni(): ComuneAttributes[] {
  return ENTRIES;
}

/**
 * Determina la "preposizione di luogo" italiana corretta per un comune.
 * "ad Ancona", "a Roma", "a L'Aquila" ecc.
 */
export function getPreposizione(nome: string): string {
  return /^[AEIOUaeiou]/.test(nome) ? 'ad' : 'a';
}
