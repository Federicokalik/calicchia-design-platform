-- Estensione site_faqs con `section` + seed perchi-faqs + seed delle 3
-- nuove tabelle (site_curiosita, site_approach, site_clients).
--
-- 1) site_faqs ottiene una colonna `section` (default 'general') per
--    distinguere le FAQ generiche di /faq dalle FAQ section-specific
--    della pagina /perche-scegliere-me. Estendibile in futuro a
--    'service:<slug>' senza creare tabelle dedicate.
--
-- 2) Seed dei perchi-faqs (PERCHI_FAQS + PERCHI_FAQS_EN) con section='perche'.
--
-- 3) Seed di curiosita/approach/clients dai rispettivi data/*.ts —
--    idempotente con WHERE NOT EXISTS sul flag source='seed'.

-- ── ALTER site_faqs: aggiungi section ───────────────────────────
ALTER TABLE public.site_faqs
  ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'general';

-- Constraint estendibile (per ora general+perche, in futuro 'service:<slug>').
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'site_faqs_section_check'
  ) THEN
    ALTER TABLE public.site_faqs
      ADD CONSTRAINT site_faqs_section_check
      CHECK (section IN ('general', 'perche') OR section LIKE 'service:%');
  END IF;
END $$;

-- Indice esteso a section per query filtrate.
DROP INDEX IF EXISTS idx_site_faqs_published_sort;
CREATE INDEX IF NOT EXISTS idx_site_faqs_published_section_sort
  ON public.site_faqs (locale, section, is_published, sort_order NULLS LAST, id);

-- ── Seed perchi-faqs (data/perchi-faqs.ts) ──────────────────────
INSERT INTO public.site_faqs (locale, section, question, answer, sort_order, source)
SELECT v.locale, 'perche', v.question, v.answer, v.sort_order, 'seed'
FROM (VALUES
  ('it', E'Perché dovrei scegliere un freelance e non un''agenzia?',
   E'Bella domanda. Con un''agenzia il tuo progetto passa tra 4-5 persone diverse, ognuna con le sue priorità.\nCon me parli con una persona sola — quella che lo progetta, lo sviluppa e lo mette online.\nPiù veloce, più coerente, e soprattutto: nessun dettaglio si perde per strada.',
   0),
  ('it', 'Che tipo di progetti segui?',
   E'Siti web, e-commerce, landing page, branding e strategie digitali.\nLavoro con PMI, professionisti e startup che vogliono fare sul serio online.\nNiente template riadattati: ogni progetto parte da zero, dai tuoi obiettivi reali.',
   1),
  ('it', 'Ok, ma quanto costa?',
   E'Dipende da cosa ti serve davvero — e te lo dico subito, senza girarci intorno.\nDopo una prima chiacchierata (gratuita, senza impegno) ti scrivo nero su bianco cosa ottieni, in quanto tempo, con quale impegno economico.\nNiente sorprese a fine progetto. Niente listini gonfiati. Niente catena di fornitori che alza il conto. Decidi tu.',
   2),
  ('it', E'E dopo che il sito è online?',
   E'Il lancio è solo l''inizio.\nOffro piani di manutenzione per tenere il tuo sito sicuro, aggiornato e veloce nel tempo.\nAggiornamenti, backup, monitoraggio — tutto incluso. Non ti lascio da solo dopo la consegna.',
   3),
  ('it', 'Lavori da solo o hai un team?',
   E'Io sono il tuo unico punto di contatto, sempre.\nMa quando un progetto richiede competenze specifiche — copywriting, fotografia, campagne ADV — mi affianco a professionisti fidati che condividono i miei standard.\nIl risultato? Tu parli con me, ma hai un team intero che lavora per te.',
   4),
  ('it', 'Come funziona il processo di lavoro?',
   E'Si parte da una chiacchierata per capire dove vuoi arrivare.\nPoi disegno il progetto e te lo mostro prima di scrivere una riga di codice.\nSviluppo, test su ogni dispositivo, lancio — e accompagnamento anche dopo. In ogni fase, sai sempre a che punto siamo.',
   5),
  ('en', 'Why should I pick a freelance instead of an agency?',
   E'Fair question. With an agency your project passes through 4–5 different people, each with their own priorities.\nWith me you talk to one person — the one who designs it, builds it and ships it.\nFaster, more consistent, and most importantly: nothing falls through the cracks.',
   0),
  ('en', 'What kind of projects do you take on?',
   E'Websites, e-commerce, landing pages, branding and digital strategy.\nI work with SMEs, professionals and startups that want to do serious things online.\nNo retro-fitted templates: every project starts from zero, from your real goals.',
   1),
  ('en', 'OK, but how much does it cost?',
   E'It depends on what you actually need — and I tell you straight, without dressing it up.\nAfter a first call (free, no commitment) I write you in black and white what you get, in what timeline, for what budget.\nNo surprises at the end. No inflated price lists. No supplier chain padding the bill. You decide.',
   2),
  ('en', 'And after the site is online?',
   E'Launch is just the start.\nI offer maintenance plans to keep your site safe, updated and fast over time.\nUpdates, backups, monitoring — all included. I do not leave you alone after delivery.',
   3),
  ('en', 'Do you work alone or do you have a team?',
   E'I am your single point of contact, always.\nBut when a project needs specific skills — copywriting, photography, ad campaigns — I bring in trusted professionals who share my standard.\nThe result? You talk to me, but you have a whole team working for you.',
   4),
  ('en', 'How does the process work?',
   E'It starts with a conversation to understand where you want to get to.\nThen I design the project and show it to you before writing a line of code.\nDevelopment, testing on every device, launch — and follow-up afterwards. At every step, you always know where we are.',
   5)
) AS v(locale, question, answer, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.site_faqs WHERE source = 'seed' AND section = 'perche');

-- ── Seed site_curiosita (data/curiosita.ts: CURIOSITA + CURIOSITA_EN) ──
INSERT INTO public.site_curiosita (locale, label, body, sort_order, source)
SELECT v.locale, v.label, v.body, v.sort_order, 'seed'
FROM (VALUES
  ('it', 'Designer da sempre',
   E'I primi layout li facevo da ragazzino con AutoCAD e Photoshop.\nNon ho scelto il design come lavoro — è il design che ha scelto me, e non ha mai smesso.',
   0),
  ('it', 'Geometra di formazione',
   E'Precisione, progettazione, attenzione maniacale ai dettagli.\nIl diploma da geometra mi ha insegnato a misurare tutto due volte.\nSi vede in ogni pixel che consegno.',
   1),
  ('it', 'Imprenditore, non solo freelance',
   E'Nel 2021 ho co-fondato Aeron Sim, nel mondo dei simulatori di guida.\nSo cosa vuol dire costruire un brand da zero — con i propri soldi, i propri errori e le proprie vittorie.',
   2),
  ('it', 'Render 3D e video',
   E'Video editing, motion graphics, post-produzione e persino render 3D interattivi.\nSe il tuo progetto ha bisogno di prendere vita, so come farlo.',
   3),
  ('it', 'Certificato Google',
   E'Digital marketing non è una buzzword per me.\nHo la certificazione Google e anni di pratica sul campo tra SEO, campagne e analisi dati.',
   4),
  ('it', 'Mentalità da problem solver',
   E'Modding Android, reverse-engineering, automazioni.\nQuando qualcosa non funziona, non mi fermo — trovo un modo. È più forte di me.',
   5),
  ('en', 'Designer from day one',
   E'I made my first layouts as a kid in AutoCAD and Photoshop.\nI did not pick design as a job — design picked me, and never let go.',
   0),
  ('en', 'Surveyor by training',
   E'Precision, planning, obsessive attention to detail.\nThe surveyor diploma taught me to measure everything twice.\nYou can see it in every pixel I ship.',
   1),
  ('en', 'Founder, not just freelance',
   E'In 2021 I co-founded Aeron Sim, in the racing simulators world.\nI know what it means to build a brand from zero — with your own money, your own mistakes and your own wins.',
   2),
  ('en', '3D renders and video',
   E'Video editing, motion graphics, post-production and even interactive 3D renders.\nIf your project needs to come alive, I know how to make it happen.',
   3),
  ('en', 'Google certified',
   E'Digital marketing is not a buzzword for me.\nI have the Google certification and years of hands-on practice across SEO, campaigns and data analysis.',
   4),
  ('en', 'Problem-solver mindset',
   E'Android modding, reverse-engineering, automations.\nWhen something does not work, I do not stop — I find a way. It is stronger than me.',
   5)
) AS v(locale, label, body, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.site_curiosita WHERE source = 'seed');

-- ── Seed site_approach (data/approach.ts: APPROACH + APPROACH_EN) ──
INSERT INTO public.site_approach (locale, title, description, phosphor_icon, sort_order, source)
SELECT v.locale, v.title, v.description, v.phosphor_icon, v.sort_order, 'seed'
FROM (VALUES
  ('it', 'Ossessione per i dettagli',
   E'Non mi accontento del "va bene così".\nOgni pixel, ogni riga di codice, ogni interazione — tutto è pensato per essere impeccabile.\nLa differenza la fanno i dettagli che gli altri ignorano.',
   'ph-crosshair', 0),
  ('it', 'Sempre un passo avanti',
   E'Il web cambia ogni giorno.\nStudio, sperimento e applico le tecnologie più recenti prima che diventino mainstream.\nIl tuo progetto non nasce già vecchio.',
   'ph-rocket-launch', 1),
  ('it', 'Competenze trasversali',
   E'Design, sviluppo, SEO, branding: non devo delegare niente.\nQuesto significa più coerenza, meno errori di comunicazione e un risultato finale che tiene tutto insieme.',
   'ph-circles-three-plus', 2),
  ('it', 'Tutto in un unico punto',
   E'Non devi coordinare designer, sviluppatore e consulente SEO.\nParlo con te, capisco cosa ti serve e me ne occupo io. Punto.',
   'ph-user-focus', 3),
  ('it', 'Risultati, non promesse',
   E'Non ti vendo "visibilità" o "engagement".\nTi mostro numeri reali: più contatti, più vendite, più crescita. È l''unica metrica che conta.',
   'ph-chart-line-up', 4),
  ('en', 'Obsession with details',
   E'I do not settle for "good enough".\nEvery pixel, every line of code, every interaction — all built to be impeccable.\nFocusing on the details that others ignore.',
   'ph-crosshair', 0),
  ('en', 'Always one step ahead',
   E'The web changes every day.\nI study, experiment and apply recent technologies before they go mainstream.\nYour project is not born already old.',
   'ph-rocket-launch', 1),
  ('en', 'Cross-disciplinary skills',
   E'Design, development, SEO, branding: I do not have to delegate.\nThat means more consistency, fewer miscommunications, and a final result that holds together.',
   'ph-circles-three-plus', 2),
  ('en', 'One single point of contact',
   E'You do not coordinate a designer, a developer and an SEO consultant.\nI talk to you, I understand what you need, and I handle it. Period.',
   'ph-user-focus', 3),
  ('en', 'Results, not promises',
   E'I do not sell you "visibility" or "engagement".\nI show you real numbers: more leads, more sales, more growth. It is the only metric that matters.',
   'ph-chart-line-up', 4)
) AS v(locale, title, description, phosphor_icon, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.site_approach WHERE source = 'seed');

-- ── Seed site_clients (data/clients.ts: CLIENTS) ──
INSERT INTO public.site_clients (name, url, industry, logo_url, sort_order, source)
SELECT v.name, v.url, v.industry, v.logo_url, v.sort_order, 'seed'
FROM (VALUES
  ('Creattivamente Shop', 'https://creattivamente.shop/', 'E-Commerce', '/img/works/creattivamente.webp', 0),
  ('Pool Tech Piscine', 'https://pooltechpiscine.it/', 'Costruzioni', '/img/works/pooltech.webp', 1),
  ('Masi Costruzioni', 'https://masicostruzioni.it/', 'Edilizia', '/img/works/masicostruzioni.webp', 2),
  ('Italian Green Costruzioni', 'https://italiangreencostruzioni.it/', 'Edilizia', '/img/works/italiangreencostruzioni.webp', 3),
  ('Crimatek', 'https://www.crimatek.com/', 'Tecnico', '/img/works/crimatek.webp', 4),
  ('Massimiliano Maggio', 'https://massimilianomaggio.com/', 'Personal Brand', '/img/works/massimilianomaggio.webp', 5),
  ('Gianmarco Scarsella', '#', 'Personal Brand', '/img/works/Gianmarco-Scarsella-logo-dark.webp', 6)
) AS v(name, url, industry, logo_url, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.site_clients WHERE source = 'seed');
