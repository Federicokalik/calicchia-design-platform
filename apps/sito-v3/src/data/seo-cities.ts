// All Italian cities for SEO landing pages
// Sources: capoluoghi di provincia + comuni Ciociaria

export interface SeoCity {
  slug: string;
  nome: string;
  regione: string;
  tipo: 'capoluogo' | 'ciociaria';
  /** Priority tier: 1 = MVP (top cities + Frosinone area hub), 2 = expansion, 3 = long-tail */
  tier: 1 | 2 | 3;
}

export interface CityContext {
  heading: string;       // h2 for local section
  description: string;   // paragraph for local section
  searchPhrase: string;  // what people search, e.g. "dentista a Roma"
  localAdvantage: string; // why working with someone who knows the area matters
}

export const SEO_CITIES: SeoCity[] = [
  // ─── ABRUZZO ───────────────────────────────
  { slug: 'l-aquila', nome: "L'Aquila", regione: 'Abruzzo', tipo: 'capoluogo', tier: 2 },
  { slug: 'chieti', nome: 'Chieti', regione: 'Abruzzo', tipo: 'capoluogo', tier: 2 },
  { slug: 'pescara', nome: 'Pescara', regione: 'Abruzzo', tipo: 'capoluogo', tier: 2 },
  { slug: 'teramo', nome: 'Teramo', regione: 'Abruzzo', tipo: 'capoluogo', tier: 2 },

  // ─── BASILICATA ───────────────────────────────
  { slug: 'potenza', nome: 'Potenza', regione: 'Basilicata', tipo: 'capoluogo', tier: 2 },
  { slug: 'matera', nome: 'Matera', regione: 'Basilicata', tipo: 'capoluogo', tier: 2 },

  // ─── CALABRIA ───────────────────────────────
  { slug: 'catanzaro', nome: 'Catanzaro', regione: 'Calabria', tipo: 'capoluogo', tier: 2 },
  { slug: 'cosenza', nome: 'Cosenza', regione: 'Calabria', tipo: 'capoluogo', tier: 2 },
  { slug: 'crotone', nome: 'Crotone', regione: 'Calabria', tipo: 'capoluogo', tier: 2 },
  { slug: 'reggio-di-calabria', nome: 'Reggio di Calabria', regione: 'Calabria', tipo: 'capoluogo', tier: 2 },
  { slug: 'vibo-valentia', nome: 'Vibo Valentia', regione: 'Calabria', tipo: 'capoluogo', tier: 2 },

  // ─── CAMPANIA ───────────────────────────────
  { slug: 'napoli', nome: 'Napoli', regione: 'Campania', tipo: 'capoluogo', tier: 1 },
  { slug: 'avellino', nome: 'Avellino', regione: 'Campania', tipo: 'capoluogo', tier: 2 },
  { slug: 'benevento', nome: 'Benevento', regione: 'Campania', tipo: 'capoluogo', tier: 2 },
  { slug: 'caserta', nome: 'Caserta', regione: 'Campania', tipo: 'capoluogo', tier: 2 },
  { slug: 'salerno', nome: 'Salerno', regione: 'Campania', tipo: 'capoluogo', tier: 2 },

  // ─── EMILIA-ROMAGNA ───────────────────────────────
  { slug: 'bologna', nome: 'Bologna', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 1 },
  { slug: 'ferrara', nome: 'Ferrara', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'forli', nome: 'Forli', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'modena', nome: 'Modena', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'parma', nome: 'Parma', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'piacenza', nome: 'Piacenza', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'ravenna', nome: 'Ravenna', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'reggio-nell-emilia', nome: "Reggio nell'Emilia", regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },
  { slug: 'rimini', nome: 'Rimini', regione: 'Emilia-Romagna', tipo: 'capoluogo', tier: 2 },

  // ─── FRIULI-VENEZIA GIULIA ───────────────────────────────
  { slug: 'trieste', nome: 'Trieste', regione: 'Friuli-Venezia Giulia', tipo: 'capoluogo', tier: 2 },
  { slug: 'gorizia', nome: 'Gorizia', regione: 'Friuli-Venezia Giulia', tipo: 'capoluogo', tier: 2 },
  { slug: 'pordenone', nome: 'Pordenone', regione: 'Friuli-Venezia Giulia', tipo: 'capoluogo', tier: 2 },
  { slug: 'udine', nome: 'Udine', regione: 'Friuli-Venezia Giulia', tipo: 'capoluogo', tier: 2 },

  // ─── LAZIO ───────────────────────────────
  { slug: 'roma', nome: 'Roma', regione: 'Lazio', tipo: 'capoluogo', tier: 1 },
  // Frosinone is both capoluogo and Ciociaria hub — listed as capoluogo
  { slug: 'frosinone', nome: 'Frosinone', regione: 'Lazio', tipo: 'capoluogo', tier: 1 },
  { slug: 'latina', nome: 'Latina', regione: 'Lazio', tipo: 'capoluogo', tier: 1 },
  { slug: 'rieti', nome: 'Rieti', regione: 'Lazio', tipo: 'capoluogo', tier: 2 },
  { slug: 'viterbo', nome: 'Viterbo', regione: 'Lazio', tipo: 'capoluogo', tier: 2 },

  // ─── LIGURIA ───────────────────────────────
  { slug: 'genova', nome: 'Genova', regione: 'Liguria', tipo: 'capoluogo', tier: 2 },
  { slug: 'imperia', nome: 'Imperia', regione: 'Liguria', tipo: 'capoluogo', tier: 2 },
  { slug: 'la-spezia', nome: 'La Spezia', regione: 'Liguria', tipo: 'capoluogo', tier: 2 },
  { slug: 'savona', nome: 'Savona', regione: 'Liguria', tipo: 'capoluogo', tier: 2 },

  // ─── LOMBARDIA ───────────────────────────────
  { slug: 'milano', nome: 'Milano', regione: 'Lombardia', tipo: 'capoluogo', tier: 1 },
  { slug: 'bergamo', nome: 'Bergamo', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'brescia', nome: 'Brescia', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'como', nome: 'Como', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'cremona', nome: 'Cremona', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'lecco', nome: 'Lecco', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'lodi', nome: 'Lodi', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'mantova', nome: 'Mantova', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'monza', nome: 'Monza', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'pavia', nome: 'Pavia', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'sondrio', nome: 'Sondrio', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },
  { slug: 'varese', nome: 'Varese', regione: 'Lombardia', tipo: 'capoluogo', tier: 2 },

  // ─── MARCHE ───────────────────────────────
  { slug: 'ancona', nome: 'Ancona', regione: 'Marche', tipo: 'capoluogo', tier: 2 },
  { slug: 'ascoli-piceno', nome: 'Ascoli Piceno', regione: 'Marche', tipo: 'capoluogo', tier: 2 },
  { slug: 'fermo', nome: 'Fermo', regione: 'Marche', tipo: 'capoluogo', tier: 2 },
  { slug: 'macerata', nome: 'Macerata', regione: 'Marche', tipo: 'capoluogo', tier: 2 },
  { slug: 'pesaro', nome: 'Pesaro', regione: 'Marche', tipo: 'capoluogo', tier: 2 },

  // ─── MOLISE ───────────────────────────────
  { slug: 'campobasso', nome: 'Campobasso', regione: 'Molise', tipo: 'capoluogo', tier: 2 },
  { slug: 'isernia', nome: 'Isernia', regione: 'Molise', tipo: 'capoluogo', tier: 2 },

  // ─── PIEMONTE ───────────────────────────────
  { slug: 'torino', nome: 'Torino', regione: 'Piemonte', tipo: 'capoluogo', tier: 1 },
  { slug: 'alessandria', nome: 'Alessandria', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },
  { slug: 'asti', nome: 'Asti', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },
  { slug: 'biella', nome: 'Biella', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },
  { slug: 'cuneo', nome: 'Cuneo', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },
  { slug: 'novara', nome: 'Novara', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },
  { slug: 'verbania', nome: 'Verbania', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },
  { slug: 'vercelli', nome: 'Vercelli', regione: 'Piemonte', tipo: 'capoluogo', tier: 2 },

  // ─── PUGLIA ───────────────────────────────
  { slug: 'bari', nome: 'Bari', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'andria', nome: 'Andria', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'barletta', nome: 'Barletta', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'brindisi', nome: 'Brindisi', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'foggia', nome: 'Foggia', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'lecce', nome: 'Lecce', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'taranto', nome: 'Taranto', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },
  { slug: 'trani', nome: 'Trani', regione: 'Puglia', tipo: 'capoluogo', tier: 2 },

  // ─── SARDEGNA ───────────────────────────────
  { slug: 'cagliari', nome: 'Cagliari', regione: 'Sardegna', tipo: 'capoluogo', tier: 2 },
  { slug: 'carbonia', nome: 'Carbonia', regione: 'Sardegna', tipo: 'capoluogo', tier: 2 },
  { slug: 'nuoro', nome: 'Nuoro', regione: 'Sardegna', tipo: 'capoluogo', tier: 2 },
  { slug: 'oristano', nome: 'Oristano', regione: 'Sardegna', tipo: 'capoluogo', tier: 2 },
  { slug: 'sassari', nome: 'Sassari', regione: 'Sardegna', tipo: 'capoluogo', tier: 2 },

  // ─── SICILIA ───────────────────────────────
  { slug: 'palermo', nome: 'Palermo', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'agrigento', nome: 'Agrigento', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'caltanissetta', nome: 'Caltanissetta', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'catania', nome: 'Catania', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'enna', nome: 'Enna', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'messina', nome: 'Messina', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'ragusa', nome: 'Ragusa', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'siracusa', nome: 'Siracusa', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },
  { slug: 'trapani', nome: 'Trapani', regione: 'Sicilia', tipo: 'capoluogo', tier: 2 },

  // ─── TOSCANA ───────────────────────────────
  { slug: 'firenze', nome: 'Firenze', regione: 'Toscana', tipo: 'capoluogo', tier: 1 },
  { slug: 'arezzo', nome: 'Arezzo', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'grosseto', nome: 'Grosseto', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'livorno', nome: 'Livorno', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'lucca', nome: 'Lucca', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'massa', nome: 'Massa', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'pisa', nome: 'Pisa', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'pistoia', nome: 'Pistoia', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'prato', nome: 'Prato', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },
  { slug: 'siena', nome: 'Siena', regione: 'Toscana', tipo: 'capoluogo', tier: 2 },

  // ─── TRENTINO-ALTO ADIGE ───────────────────────────────
  { slug: 'trento', nome: 'Trento', regione: 'Trentino-Alto Adige', tipo: 'capoluogo', tier: 2 },
  { slug: 'bolzano', nome: 'Bolzano', regione: 'Trentino-Alto Adige', tipo: 'capoluogo', tier: 2 },

  // ─── UMBRIA ───────────────────────────────
  { slug: 'perugia', nome: 'Perugia', regione: 'Umbria', tipo: 'capoluogo', tier: 2 },
  { slug: 'terni', nome: 'Terni', regione: 'Umbria', tipo: 'capoluogo', tier: 2 },

  // ─── VALLE D'AOSTA ───────────────────────────────
  { slug: 'aosta', nome: 'Aosta', regione: "Valle d'Aosta", tipo: 'capoluogo', tier: 2 },

  // ─── VENETO ───────────────────────────────
  { slug: 'venezia', nome: 'Venezia', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },
  { slug: 'belluno', nome: 'Belluno', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },
  { slug: 'padova', nome: 'Padova', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },
  { slug: 'rovigo', nome: 'Rovigo', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },
  { slug: 'treviso', nome: 'Treviso', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },
  { slug: 'verona', nome: 'Verona', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },
  { slug: 'vicenza', nome: 'Vicenza', regione: 'Veneto', tipo: 'capoluogo', tier: 2 },

  // ─── CIOCIARIA / PROVINCIA DI FROSINONE ────────────────
  // (Frosinone già incluso come capoluogo sopra)
  { slug: 'acquafondata', nome: 'Acquafondata', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'acuto', nome: 'Acuto', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'alatri', nome: 'Alatri', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'alvito', nome: 'Alvito', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'amaseno', nome: 'Amaseno', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'anagni', nome: 'Anagni', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'aquino', nome: 'Aquino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'arce', nome: 'Arce', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'arnara', nome: 'Arnara', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'arpino', nome: 'Arpino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'atina', nome: 'Atina', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'ausonia', nome: 'Ausonia', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'belmonte-castello', nome: 'Belmonte Castello', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'boville-ernica', nome: 'Boville Ernica', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'broccostella', nome: 'Broccostella', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'campoli-appennino', nome: 'Campoli Appennino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'casalattico', nome: 'Casalattico', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'casalvieri', nome: 'Casalvieri', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'cassino', nome: 'Cassino', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'castelliri', nome: 'Castelliri', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'castelnuovo-parano', nome: 'Castelnuovo Parano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'castrocielo', nome: 'Castrocielo', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'castro-dei-volsci', nome: 'Castro dei Volsci', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'ceccano', nome: 'Ceccano', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'ceprano', nome: 'Ceprano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'cervaro', nome: 'Cervaro', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'colfelice', nome: 'Colfelice', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'collepardo', nome: 'Collepardo', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'colle-san-magno', nome: 'Colle San Magno', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'coreno-ausonio', nome: 'Coreno Ausonio', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'esperia', nome: 'Esperia', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'falvaterra', nome: 'Falvaterra', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'ferentino', nome: 'Ferentino', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'filettino', nome: 'Filettino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'fiuggi', nome: 'Fiuggi', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'fontana-liri', nome: 'Fontana Liri', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'fontechiari', nome: 'Fontechiari', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'fumone', nome: 'Fumone', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'gallinaro', nome: 'Gallinaro', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'giuliano-di-roma', nome: 'Giuliano di Roma', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'guarcino', nome: 'Guarcino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'isola-del-liri', nome: 'Isola del Liri', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'monte-san-giovanni-campano', nome: 'Monte San Giovanni Campano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'morolo', nome: 'Morolo', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'paliano', nome: 'Paliano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'pastena', nome: 'Pastena', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'patrica', nome: 'Patrica', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'pescosolido', nome: 'Pescosolido', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'picinisco', nome: 'Picinisco', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'pico', nome: 'Pico', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'piedimonte-san-germano', nome: 'Piedimonte San Germano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'piglio', nome: 'Piglio', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'pignataro-interamna', nome: 'Pignataro Interamna', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'pofi', nome: 'Pofi', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'pontecorvo', nome: 'Pontecorvo', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'posta-fibreno', nome: 'Posta Fibreno', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'ripi', nome: 'Ripi', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'rocca-d-arce', nome: "Rocca d'Arce", regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'roccasecca', nome: 'Roccasecca', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'san-biagio-saracinisco', nome: 'San Biagio Saracinisco', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'san-donato-val-di-comino', nome: 'San Donato Val di Comino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'san-giorgio-a-liri', nome: 'San Giorgio a Liri', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'san-giovanni-incarico', nome: 'San Giovanni Incarico', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'san-vittore-del-lazio', nome: 'San Vittore del Lazio', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'sant-ambrogio-sul-garigliano', nome: 'Sant\'Ambrogio sul Garigliano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'sant-andrea-del-garigliano', nome: 'Sant\'Andrea del Garigliano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'sant-apollinare', nome: 'Sant\'Apollinare', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'sant-elia-fiumerapido', nome: 'Sant\'Elia Fiumerapido', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'santopadre', nome: 'Santopadre', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'serrone', nome: 'Serrone', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'settefrati', nome: 'Settefrati', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'sgurgola', nome: 'Sgurgola', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'sora', nome: 'Sora', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'strangolagalli', nome: 'Strangolagalli', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'supino', nome: 'Supino', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'terelle', nome: 'Terelle', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'torre-cajetani', nome: 'Torre Cajetani', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'torrice', nome: 'Torrice', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'trevi-nel-lazio', nome: 'Trevi nel Lazio', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'trivigliano', nome: 'Trivigliano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'vallecorsa', nome: 'Vallecorsa', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'vallemaio', nome: 'Vallemaio', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'vallerotonda', nome: 'Vallerotonda', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'veroli', nome: 'Veroli', regione: 'Lazio', tipo: 'ciociaria', tier: 1 },
  { slug: 'vicalvi', nome: 'Vicalvi', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'vico-nel-lazio', nome: 'Vico nel Lazio', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'villa-latina', nome: 'Villa Latina', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'villa-santa-lucia', nome: 'Villa Santa Lucia', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'villa-santo-stefano', nome: 'Villa Santo Stefano', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
  { slug: 'viticuso', nome: 'Viticuso', regione: 'Lazio', tipo: 'ciociaria', tier: 3 },
];

// ─── Lookup maps (built once) ───────────────────────────────
const cityBySlug = new Map<string, SeoCity>();
for (const c of SEO_CITIES) cityBySlug.set(c.slug, c);

// ─── Exports ───────────────────────────────

export function getCityBySlug(slug: string): SeoCity | undefined {
  return cityBySlug.get(slug);
}

export function getAllCities(): SeoCity[] {
  return SEO_CITIES;
}

export function getCapoluoghi(): SeoCity[] {
  return SEO_CITIES.filter(c => c.tipo === 'capoluogo');
}

export function getCiociariaCities(): SeoCity[] {
  return SEO_CITIES.filter(c => c.tipo === 'ciociaria');
}

export function getCitiesByRegione(regione: string): SeoCity[] {
  return SEO_CITIES.filter(c => c.regione === regione);
}

export function getCityContext(city: SeoCity, professionLabel: string): CityContext {
  const profLower = professionLabel.toLowerCase();
  // Italian preposition: "ad" before a vowel-starting city (Anagni, Avellino, ...),
  // "a" otherwise. Guarantees the correct rendering "ad Anagni" / "a Roma".
  const prep = /^[AEIOU]/i.test(city.nome) ? 'ad' : 'a';
  const prepCap = prep === 'ad' ? 'Ad' : 'A';
  const search = `${profLower} ${prep} ${city.nome}`;

  // Grande città (tier 1 capoluogo: Roma, Milano, Napoli, Torino, Firenze, Bologna)
  if (city.tipo === 'capoluogo' && city.tier === 1 && city.slug !== 'frosinone' && city.slug !== 'latina') {
    return {
      heading: `${professionLabel} ${prep} ${city.nome}: farsi trovare in una grande città`,
      description: `${prepCap} ${city.nome} la concorrenza online è alta.\nPer un'attività come la tua, un sito professionale non è un optional.\nÈ quello che ti separa da chi ti ruba i clienti ogni giorno.\nCostruiamo una presenza digitale che si faccia notare anche in un mercato competitivo.`,
      searchPhrase: search,
      localAdvantage: `In una città come ${city.nome}, le persone cercano su Google prima di scegliere.\nSe non ti trovano per "${search}", stai lasciando spazio ai competitor.\nTi aiuto a posizionarti dove conta davvero.`,
    };
  }

  // Ciociaria hub (tier 1 ciociaria: Cassino, Sora, Alatri, Anagni, etc + Frosinone)
  if (city.tipo === 'ciociaria' || city.slug === 'frosinone') {
    const isBigCiociaria = city.tier === 1;
    return {
      heading: `${professionLabel} ${prep} ${city.nome}: il digitale arriva in Ciociaria`,
      description: isBigCiociaria
        ? `${city.nome} è un punto di riferimento per tutta la provincia.\nI tuoi clienti ti cercano su Google.\nCreo siti web per ${profLower} che funzionano davvero: belli, veloci, e fatti per portarti lead.`
        : `Anche in un comune come ${city.nome}, le persone cercano online prima di scegliere.\nNon serve essere a Roma per meritare un sito web fatto bene.\nIn un territorio come la Ciociaria, un sito professionale ti fa spiccare ancora di più.`,
      searchPhrase: search,
      localAdvantage: isBigCiociaria
        ? `Conosco la Ciociaria, i suoi ritmi e il suo mercato.\nNon ti propongo soluzioni generiche pensate per Milano.\nTi costruisco qualcosa che funziona qui, per i clienti che hai tu.`
        : `Sono di questa zona.\nCapisco il tessuto economico locale e so cosa cercano i tuoi utenti.\nIl tuo sito non sarà una copia di qualcos'altro — sarà fatto su misura per ${city.nome}.`,
    };
  }

  // Latina (tier 1 ma non grande citta, vicino a Ciociaria)
  if (city.slug === 'latina') {
    return {
      heading: `${professionLabel} ${prep} Latina: visibilità online nel basso Lazio`,
      description: `Latina è una città in crescita, e le attività locali si stanno svegliando sul digitale.\nSe sei tra i primi ${profLower} con un sito web professionale, hai un vantaggio enorme.\nTi aiuto a prenderti quel vantaggio prima degli altri.`,
      searchPhrase: search,
      localAdvantage: `Lavoro con attività nel basso Lazio — Latina, Frosinone, e tutta l'area.\nConosco il mercato locale e so cosa funziona qui.\nNon ti propongo strategie pensate per realtà diverse dalla tua.`,
    };
  }

  // Città media (tier 2 capoluogo — tutte le altre)
  return {
    heading: `${professionLabel} ${prep} ${city.nome}: il tuo sito web professionale`,
    description: `${prepCap} ${city.nome}, sempre più persone cercano online prima di scegliere.\nUn sito professionale ti mette davanti alla concorrenza e ti fa lavorare H24.\nCreo siti su misura per ${profLower} ${prep} ${city.nome}.`,
    searchPhrase: search,
    localAdvantage: `Lavoro da remoto con attività in tutta Italia.\nChe tu sia ${prep} ${city.nome} o altrove, il risultato è lo stesso.\nUn sito web su misura, ottimizzato per farti trovare dai clienti della tua zona.`,
  };
}
