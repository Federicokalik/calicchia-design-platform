/**
 * Domain types — single source of truth for content shape.
 * Keep narrow and serializable: no functions, no Date raw → ISO strings.
 */

export type SectionKind =
  | 'overview'
  | 'challenge'
  | 'metrics'
  | 'sequence'
  | 'gallery';

export interface Asset {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  poster?: string;
  video?: string;
}

export interface Metric {
  label: string;
  value: number;
  suffix?: string;        // "%", "+", "x"
  formatter?: 'integer' | 'currency';
}

export interface ProjectSection {
  kind: SectionKind;
  title?: string;
  body?: string;
  assets?: Asset[];
  metrics?: Metric[];
}

/** @deprecated P0-04 — type legacy del case study editoriale; il nuovo flow è API-driven via lib/projects-api.ts (ApiProjectDetail). */
export interface Project {
  slug: string;
  title: string;
  client: string;
  year: number;
  tags: string[];
  excerpt: string;
  hero: Asset;
  sections: ProjectSection[];
  /** Slug of the next project in the showcase loop. */
  next: string;
}

export interface Service {
  slug: string;
  title: string;
  /** Short editorial lead (1–2 sentences). */
  lead: string;
  /** Bullet deliverables shown in cards. */
  deliverables: string[];
  /** Phosphor icon name, e.g. "globe". */
  icon: string;
}

export interface SocialLink {
  label: string;
  url: string;
  /** Phosphor icon name. */
  icon: string;
}

export interface NavItem {
  label: string;
  href: string;
}

export interface ContactInfo {
  email: string;
  phone: string;
  address: string;
  vat: string;
  cal: string;
}

export interface GeoCoordinates {
  /** Latitudine WGS84 (decimal degrees) */
  lat: number;
  /** Longitudine WGS84 (decimal degrees) */
  lng: number;
  /** Città di riferimento (city) */
  city: string;
  /** Provincia (es. "FR") */
  province: string;
  /** Regione (es. "Lazio") */
  region: string;
  /** Country code (ISO 3166-1 alpha-2, default IT) */
  country: string;
  /** CAP / postal code */
  postalCode: string;
}

export interface SiteConfig {
  brand: string;
  legalName: string;
  url: string;
  description: string;
  nav: NavItem[];
  social: SocialLink[];
  contact: ContactInfo;
  experienceStartYear: number;
  /** Coordinate geografiche per LocalBusiness JSON-LD */
  geo: GeoCoordinates;
}
