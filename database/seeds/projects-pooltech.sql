-- Seed case study: Pool Tech Piscine (pooltechpiscine.it)
-- Restyling 2022 + maintenance/render 3D occasionali post-launch.
-- Idempotent: ON CONFLICT (slug) DO UPDATE.
-- Asset: apps/api/uploads/works/pooltech-2026/ -> /media/works/pooltech-2026/

INSERT INTO public.projects (
  slug,
  title,
  excerpt,
  description,
  cover_image,
  client,
  services,
  industries,
  technologies,
  tags,
  year,
  challenge,
  solution,
  outcome,
  metrics,
  gallery,
  feedback,
  live_url,
  seo_title,
  seo_description,
  is_published,
  is_featured,
  display_order,
  published_at
) VALUES (
  'pooltechpiscine-restyling',
  'Pool Tech — Restyling sito vetrina + SEO locale piscine',
  'Azienda con 30+ anni di esperienza nella realizzazione di piscine, sito visibilità quasi zero. Restyling completo + SEO locale come unica metrica di successo.',
  'Pool Tech progetta e realizza piscine interrate, semi-interrate e fuori terra in Lazio, Campania e Abruzzo. Il sito esisteva ma sembrava molto più vecchio dell''azienda: comunicava poca qualità reale e non intercettava le ricerche locali. Restyling completo nel 2022, ancora cliente attivo per manutenzione, contenuti e render 3D occasionali.',
  'works/pooltech-2026/hero-desktop.webp',
  'Pool Tech Piscine',
  'Web design, SEO, Sviluppo web',
  'Costruzioni / Outdoor design',
  ARRAY['WordPress', 'Avada', 'PHP', 'Mulish', 'Schema.org', 'Google Business Profile'],
  ARRAY['wordpress', 'restyling', 'seo-locale', 'lazio', 'piscine', 'b2c', 'lead-generation'],
  2022,
  -- challenge JSONB { text, detail }
  '{
    "text": "Un''azienda con 30+ anni di esperienza, visibilità online quasi zero.",
    "detail": "Il vecchio sito sembrava fermo agli anni 2010: layout statico, foto piccole, niente claim, niente prove sociali. Per ricerche tipo «realizzazione piscine Frosinone» o «piscine interrate Latina» il sito non compariva nemmeno nelle prime due pagine Google. La qualità del lavoro reale (foto cantieri, progetti consegnati, recensioni) non passava online: il sito raccontava un''azienda diversa da quella che il cliente chiamava al telefono."
  }'::jsonb,
  -- solution JSONB { text, detail }
  '{
    "text": "Restyling completo + SEO locale come unico obiettivo misurabile.",
    "detail": "Tema custom basato su Avada (WordPress mantenuto per gestione autonoma dell''azienda), hero con foto reali, claim diretto «Realizzazione Piscine», contatto telefonico in primo piano + form Contattaci sempre raggiungibile. Sui contenuti: pagine dedicate alle tipologie (interrate, semi-interrate, fuori terra), alle fasi costruttive, ai progetti realizzati. Su SEO locale: ottimizzazione on-page tutta in italiano, schema LocalBusiness, sitemap XML, integrazione Google Business Profile, copy ottimizzato per query multi-provincia (Frosinone, Latina, Caserta + estensione Lazio/Abruzzo/Campania)."
  }'::jsonb,
  -- outcome (sintesi 80-150 parole)
  'Dal lancio nel 2022, Pool Tech occupa stabilmente le prime posizioni Google per le query locali principali — «realizzazione piscine Frosinone», «costruzione piscine Latina», «piscine interrate Lazio» — con un mix di pagine territoriali e contenuti tematici (fasi costruttive, tipologie, materiali). Il sito ha superato la fase di vetrina: oggi le richieste di preventivo arrivano direttamente dal modulo Contattaci, lo stesso form che prima era sepolto in fondo. Le recensioni Google integrate nell''hero costruiscono fiducia immediata sulla qualità reale del lavoro. Continuo a curare il sito post-launch — render 3D occasionali, aggiornamenti contenuti, manutenzione tecnica — perché la presenza locale è un''attività continua, non un progetto chiuso al go-live.',
  -- metrics JSONB array
  '[
    { "label": "Posizione Google query locali principali", "value": "Top 3" },
    { "label": "Cliente attivo da", "value": "2022" },
    { "label": "Province servite", "value": "6" }
  ]'::jsonb,
  -- gallery JSONB
  '[
    { "src": "works/pooltech-2026/hero-desktop.webp", "alt": "Pool Tech home desktop — hero con foto piscina interrata, claim Realizzazione Piscine e CTA Contattaci", "width": 1920, "height": 1080 },
    { "src": "works/pooltech-2026/section-04.webp", "alt": "Pool Tech — header e hero al ridraw, copy intro azienda 30+ anni", "width": 1440, "height": 900 },
    { "src": "works/pooltech-2026/section-02.webp", "alt": "Pool Tech — sezione tipologie piscine (fuori terra, semi interrate)", "width": 1440, "height": 900 },
    { "src": "works/pooltech-2026/hero-mobile.webp", "alt": "Pool Tech mobile — adattamento responsive dell''hero su iPhone", "width": 390, "height": 844 }
  ]'::jsonb,
  NULL, -- feedback skip (utente: nessuna quote letterale)
  'https://pooltechpiscine.it',
  -- SEO override
  'Restyling sito Pool Tech Piscine + SEO locale Lazio · Case Study',
  'Restyling completo del sito Pool Tech Piscine (Frosinone) + SEO locale per Lazio, Campania e Abruzzo. Da invisibili su Google a Top 3 per le query principali. Cliente attivo dal 2022.',
  true,  -- is_published
  true,  -- is_featured
  1,     -- display_order
  '2022-09-01T00:00:00Z'::timestamptz
)
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  description = EXCLUDED.description,
  cover_image = EXCLUDED.cover_image,
  client = EXCLUDED.client,
  services = EXCLUDED.services,
  industries = EXCLUDED.industries,
  technologies = EXCLUDED.technologies,
  tags = EXCLUDED.tags,
  year = EXCLUDED.year,
  challenge = EXCLUDED.challenge,
  solution = EXCLUDED.solution,
  outcome = EXCLUDED.outcome,
  metrics = EXCLUDED.metrics,
  gallery = EXCLUDED.gallery,
  feedback = EXCLUDED.feedback,
  live_url = EXCLUDED.live_url,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  is_published = EXCLUDED.is_published,
  is_featured = EXCLUDED.is_featured,
  display_order = EXCLUDED.display_order,
  published_at = EXCLUDED.published_at,
  updated_at = NOW();
