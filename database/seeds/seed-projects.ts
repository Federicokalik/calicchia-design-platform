/**
 * Seed script for fake projects
 * Run with: npx tsx database/seeds/seed-projects.ts
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import postgres from 'postgres';

// Load root .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in .env');
}

const sql = postgres(process.env.DATABASE_URL);

const fakeProjects = [
  {
    slug: 'aurora-ecommerce',
    title: 'Aurora E-commerce',
    description: 'Piattaforma e-commerce moderna per un brand di moda sostenibile. Design minimalista con focus sulla user experience.',
    excerpt: 'E-commerce fashion con design minimalista e checkout ottimizzato.',
    cover_image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=1200&h=800&fit=crop',
    technologies: ['Next.js', 'Stripe', 'Tailwind CSS', 'PostgreSQL'],
    live_url: 'https://aurora-store.example.com',
    is_featured: true,
    is_published: true,
    display_order: 1,
    content: `## Il Progetto

Aurora è un brand di moda sostenibile che cercava una piattaforma e-commerce in grado di trasmettere i valori del brand: eleganza, semplicità e rispetto per l'ambiente.

## Sfide

- Creare un'esperienza di acquisto fluida e veloce
- Integrare un sistema di pagamento sicuro
- Ottimizzare le performance per mobile

## Soluzione

Ho sviluppato una piattaforma custom con Next.js, sfruttando le funzionalità di SSR per garantire tempi di caricamento rapidissimi e un'ottima SEO.

## Risultati

- **+45%** tasso di conversione
- **-2s** tempo di caricamento medio
- **98/100** PageSpeed score`,
  },
  {
    slug: 'flavour-lab-ristorante',
    title: 'Flavour Lab Restaurant',
    description: 'Sito web e sistema di prenotazione per ristorante stellato. Integrazione con gestionale e menu digitale.',
    excerpt: 'Sito ristorante con prenotazioni online e menu digitale interattivo.',
    cover_image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&h=800&fit=crop',
    technologies: ['Astro', 'React', 'PostgreSQL', 'Twilio'],
    live_url: 'https://flavourlab.example.com',
    is_featured: true,
    is_published: true,
    display_order: 2,
    content: `## Il Progetto

Flavour Lab è un ristorante gourmet che necessitava di un sito web all'altezza della sua reputazione, con un sistema di prenotazione integrato.

## Funzionalità Principali

- Prenotazione tavoli in tempo reale
- Menu digitale con filtri allergeni
- Galleria fotografica immersiva
- Notifiche SMS per conferme

## Stack Tecnologico

Astro per le performance, React per l'interattività, PostgreSQL per il backend.`,
  },
  {
    slug: 'mindful-wellness-app',
    title: 'Mindful - Wellness App',
    description: 'Web app per il benessere mentale con meditazioni guidate, tracking mood e statistiche personali.',
    excerpt: 'App wellness con meditazioni, journaling e analytics personali.',
    cover_image: 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=1200&h=800&fit=crop',
    technologies: ['React', 'Node.js', 'PostgreSQL', 'Chart.js'],
    live_url: 'https://mindful-app.example.com',
    is_featured: true,
    is_published: true,
    display_order: 3,
    content: `## Il Progetto

Mindful è una web app dedicata al benessere mentale, con funzionalità di meditazione guidata e tracking dell'umore.

## Features

- Meditazioni guidate con timer
- Diario giornaliero
- Statistiche e grafici mood
- Promemoria personalizzati
- Modalità offline

## Impatto

Oltre 5.000 utenti attivi mensili nei primi 3 mesi dal lancio.`,
  },
  {
    slug: 'techstart-landing',
    title: 'TechStart Landing Page',
    description: 'Landing page ad alta conversione per startup tech. A/B testing e ottimizzazione continua.',
    excerpt: 'Landing page startup con focus su conversioni e performance.',
    cover_image: 'https://images.unsplash.com/photo-1551434678-e076c223a692?w=1200&h=800&fit=crop',
    technologies: ['Next.js', 'Framer Motion', 'Tailwind CSS', 'Vercel'],
    live_url: 'https://techstart.example.com',
    is_featured: false,
    is_published: true,
    display_order: 4,
    content: `## Il Progetto

TechStart necessitava di una landing page che comunicasse innovazione e affidabilità, ottimizzata per la lead generation.

## Obiettivi

- Massimizzare il tasso di conversione
- Comunicare il valore del prodotto in 5 secondi
- Performance eccellenti su mobile

## Risultati A/B Test

- Variante con video hero: **+32%** conversioni
- CTA animata: **+18%** click-through rate`,
  },
  {
    slug: 'portfolio-fotografo',
    title: 'Marco Visuals Portfolio',
    description: 'Portfolio fotografico con galleria full-screen, lazy loading ottimizzato e animazioni fluide.',
    excerpt: 'Portfolio fotografo con galleria immersiva e caricamento ottimizzato.',
    cover_image: 'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?w=1200&h=800&fit=crop',
    technologies: ['Astro', 'GSAP', 'Cloudinary', 'View Transitions'],
    live_url: 'https://marcovisuals.example.com',
    is_featured: false,
    is_published: true,
    display_order: 5,
    content: `## Il Progetto

Marco è un fotografo professionista che cercava un portfolio capace di mostrare il suo lavoro in modo immersivo senza sacrificare le performance.

## Sfide Tecniche

- Gestione di immagini ad alta risoluzione
- Transizioni fluide tra pagine
- Lazy loading intelligente

## Soluzione

Ho utilizzato Cloudinary per l'ottimizzazione automatica delle immagini e GSAP per animazioni performanti.`,
  },
  {
    slug: 'green-energy-dashboard',
    title: 'GreenEnergy Dashboard',
    description: 'Dashboard analytics per azienda di energia rinnovabile. Visualizzazione dati real-time e reportistica.',
    excerpt: 'Dashboard energia con grafici real-time e report automatizzati.',
    cover_image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=800&fit=crop',
    technologies: ['React', 'D3.js', 'WebSocket', 'Node.js'],
    live_url: null,
    is_featured: false,
    is_published: true,
    display_order: 6,
    content: `## Il Progetto

GreenEnergy aveva bisogno di una dashboard per monitorare in tempo reale la produzione energetica dei propri impianti.

## Funzionalità

- Grafici real-time con WebSocket
- Mappe interattive degli impianti
- Report PDF automatici
- Alert e notifiche

## Tecnologie

React per l'interfaccia, D3.js per le visualizzazioni custom, WebSocket per i dati live.`,
  },
];

async function seedProjects() {
  console.log('🌱 Seeding projects...\n');

  for (const project of fakeProjects) {
    try {
      await sql`
        INSERT INTO projects (slug, title, description, excerpt, cover_image, technologies, live_url, is_featured, is_published, display_order, content, published_at)
        VALUES (
          ${project.slug},
          ${project.title},
          ${project.description},
          ${project.excerpt},
          ${project.cover_image},
          ${project.technologies},
          ${project.live_url},
          ${project.is_featured},
          ${project.is_published},
          ${project.display_order},
          ${project.content},
          ${new Date().toISOString()}
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
          content = EXCLUDED.content
      `;
      console.log(`✅ ${project.title} (${project.slug})`);
    } catch (err) {
      console.error(`❌ Error inserting ${project.slug}:`, (err as Error).message);
    }
  }

  console.log('\n🎉 Done! Projects seeded successfully.');
  await sql.end();
}

seedProjects();
