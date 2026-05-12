-- =============================================
-- SEED: Progetti fake per demo
-- Esegui in Supabase SQL Editor
-- =============================================

-- Disabilita temporaneamente il trigger di versioning
ALTER TABLE projects DISABLE TRIGGER project_versioning_trigger;

-- Inserisci i progetti
INSERT INTO projects (slug, title, description, excerpt, cover_image, technologies, live_url, is_featured, is_published, display_order, content, published_at, gallery)
VALUES
  (
    'aurora-ecommerce',
    'Aurora E-commerce',
    'Piattaforma e-commerce moderna per un brand di moda sostenibile. Design minimalista con focus sulla user experience.',
    'E-commerce fashion con design minimalista e checkout ottimizzato.',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=1200&h=800&fit=crop',
    ARRAY['Next.js', 'Stripe', 'Tailwind CSS', 'Supabase'],
    'https://aurora-store.example.com',
    true,
    true,
    1,
    E'## Il Progetto\n\nAurora è un brand di moda sostenibile che cercava una piattaforma e-commerce in grado di trasmettere i valori del brand: eleganza, semplicità e rispetto per l''ambiente.\n\n## Sfide\n\n- Creare un''esperienza di acquisto fluida e veloce\n- Integrare un sistema di pagamento sicuro\n- Ottimizzare le performance per mobile\n\n## Soluzione\n\nHo sviluppato una piattaforma custom con Next.js, sfruttando le funzionalità di SSR per garantire tempi di caricamento rapidissimi e un''ottima SEO.\n\n## Risultati\n\n- **+45%** tasso di conversione\n- **-2s** tempo di caricamento medio\n- **98/100** PageSpeed score',
    NOW(),
    '[]'::jsonb
  ),
  (
    'flavour-lab-ristorante',
    'Flavour Lab Restaurant',
    'Sito web e sistema di prenotazione per ristorante stellato. Integrazione con gestionale e menu digitale.',
    'Sito ristorante con prenotazioni online e menu digitale interattivo.',
    'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&h=800&fit=crop',
    ARRAY['Astro', 'React', 'Supabase', 'Twilio'],
    'https://flavourlab.example.com',
    true,
    true,
    2,
    E'## Il Progetto\n\nFlavour Lab è un ristorante gourmet che necessitava di un sito web all''altezza della sua reputazione, con un sistema di prenotazione integrato.\n\n## Funzionalità Principali\n\n- Prenotazione tavoli in tempo reale\n- Menu digitale con filtri allergeni\n- Galleria fotografica immersiva\n- Notifiche SMS per conferme\n\n## Stack Tecnologico\n\nAstro per le performance, React per l''interattività, Supabase per il backend real-time.',
    NOW(),
    '[]'::jsonb
  ),
  (
    'mindful-wellness-app',
    'Mindful - Wellness App',
    'Web app per il benessere mentale con meditazioni guidate, tracking mood e statistiche personali.',
    'App wellness con meditazioni, journaling e analytics personali.',
    'https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=1200&h=800&fit=crop',
    ARRAY['React', 'Node.js', 'PostgreSQL', 'Chart.js'],
    'https://mindful-app.example.com',
    true,
    true,
    3,
    E'## Il Progetto\n\nMindful è una web app dedicata al benessere mentale, con funzionalità di meditazione guidata e tracking dell''umore.\n\n## Features\n\n- Meditazioni guidate con timer\n- Diario giornaliero\n- Statistiche e grafici mood\n- Promemoria personalizzati\n- Modalità offline\n\n## Impatto\n\nOltre 5.000 utenti attivi mensili nei primi 3 mesi dal lancio.',
    NOW(),
    '[]'::jsonb
  ),
  (
    'techstart-landing',
    'TechStart Landing Page',
    'Landing page ad alta conversione per startup tech. A/B testing e ottimizzazione continua.',
    'Landing page startup con focus su conversioni e performance.',
    'https://images.unsplash.com/photo-1551434678-e076c223a692?w=1200&h=800&fit=crop',
    ARRAY['Next.js', 'Framer Motion', 'Tailwind CSS', 'Vercel'],
    'https://techstart.example.com',
    false,
    true,
    4,
    E'## Il Progetto\n\nTechStart necessitava di una landing page che comunicasse innovazione e affidabilità, ottimizzata per la lead generation.\n\n## Obiettivi\n\n- Massimizzare il tasso di conversione\n- Comunicare il valore del prodotto in 5 secondi\n- Performance eccellenti su mobile\n\n## Risultati A/B Test\n\n- Variante con video hero: **+32%** conversioni\n- CTA animata: **+18%** click-through rate',
    NOW(),
    '[]'::jsonb
  ),
  (
    'portfolio-fotografo',
    'Marco Visuals Portfolio',
    'Portfolio fotografico con galleria full-screen, lazy loading ottimizzato e animazioni fluide.',
    'Portfolio fotografo con galleria immersiva e caricamento ottimizzato.',
    'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?w=1200&h=800&fit=crop',
    ARRAY['Astro', 'GSAP', 'Cloudinary', 'View Transitions'],
    'https://marcovisuals.example.com',
    false,
    true,
    5,
    E'## Il Progetto\n\nMarco è un fotografo professionista che cercava un portfolio capace di mostrare il suo lavoro in modo immersivo senza sacrificare le performance.\n\n## Sfide Tecniche\n\n- Gestione di immagini ad alta risoluzione\n- Transizioni fluide tra pagine\n- Lazy loading intelligente\n\n## Soluzione\n\nHo utilizzato Cloudinary per l''ottimizzazione automatica delle immagini e GSAP per animazioni performanti.',
    NOW(),
    '[]'::jsonb
  ),
  (
    'green-energy-dashboard',
    'GreenEnergy Dashboard',
    'Dashboard analytics per azienda di energia rinnovabile. Visualizzazione dati real-time e reportistica.',
    'Dashboard energia con grafici real-time e report automatizzati.',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=800&fit=crop',
    ARRAY['React', 'D3.js', 'WebSocket', 'Node.js'],
    NULL,
    false,
    true,
    6,
    E'## Il Progetto\n\nGreenEnergy aveva bisogno di una dashboard per monitorare in tempo reale la produzione energetica dei propri impianti.\n\n## Funzionalità\n\n- Grafici real-time con WebSocket\n- Mappe interattive degli impianti\n- Report PDF automatici\n- Alert e notifiche\n\n## Tecnologie\n\nReact per l''interfaccia, D3.js per le visualizzazioni custom, WebSocket per i dati live.',
    NOW(),
    '[]'::jsonb
  )
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  excerpt = EXCLUDED.excerpt,
  cover_image = EXCLUDED.cover_image,
  technologies = EXCLUDED.technologies,
  live_url = EXCLUDED.live_url,
  is_featured = EXCLUDED.is_featured,
  is_published = EXCLUDED.is_published,
  display_order = EXCLUDED.display_order,
  content = EXCLUDED.content,
  published_at = EXCLUDED.published_at;

-- Riabilita il trigger
ALTER TABLE projects ENABLE TRIGGER project_versioning_trigger;

-- Verifica
SELECT slug, title, is_featured, is_published FROM projects ORDER BY display_order;
