/**
 * Client roster — used by case-study back-links and TrustBento client logos
 * grid. Logo paths point to apps/sito-v3/public/img/works/ (real client logos
 * kept in the public site asset tree).
 */
export interface Client {
  name: string;
  url: string;
  industry?: string;
  /** Path to client logo image (webp). */
  logo?: string;
}

export const CLIENTS: Client[] = [
  { name: 'Creattivamente Shop', url: 'https://creattivamente.shop/', industry: 'E-Commerce', logo: '/img/works/creattivamente.webp' },
  { name: 'Pool Tech Piscine', url: 'https://pooltechpiscine.it/', industry: 'Costruzioni', logo: '/img/works/pooltech.webp' },
  { name: 'Masi Costruzioni', url: 'https://masicostruzioni.it/', industry: 'Edilizia', logo: '/img/works/masicostruzioni.webp' },
  { name: 'Italian Green Costruzioni', url: 'https://italiangreencostruzioni.it/', industry: 'Edilizia', logo: '/img/works/italiangreencostruzioni.webp' },
  { name: 'Crimatek', url: 'https://www.crimatek.com/', industry: 'Tecnico', logo: '/img/works/crimatek.webp' },
  { name: 'Massimiliano Maggio', url: 'https://massimilianomaggio.com/', industry: 'Personal Brand', logo: '/img/works/massimilianomaggio.webp' },
  { name: 'Gianmarco Scarsella', url: '#', industry: 'Personal Brand', logo: '/img/works/Gianmarco-Scarsella-logo-dark.webp' },
];
