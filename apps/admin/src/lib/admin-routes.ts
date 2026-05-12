import type { AdminLocale } from '@/lib/i18n-storage';

interface LocalizedRoute {
  it: string;
  en: string;
}

const ROUTES: LocalizedRoute[] = [
  { it: '/', en: '/' },
  { it: '/oggi', en: '/today' },
  { it: '/posta', en: '/mail' },
  { it: '/pipeline', en: '/pipeline' },
  { it: '/clienti/:id', en: '/clients/:id' },
  { it: '/clienti', en: '/clients' },
  { it: '/collaboratori/:id', en: '/collaborators/:id' },
  { it: '/collaboratori', en: '/collaborators' },
  { it: '/preventivi/new', en: '/quotes/new' },
  { it: '/preventivi/:id/edit', en: '/quotes/:id/edit' },
  { it: '/preventivi/:id', en: '/quotes/:id' },
  { it: '/preventivi', en: '/quotes' },
  { it: '/progetti/:id', en: '/projects/:id' },
  { it: '/progetti', en: '/projects' },
  { it: '/calendario/calendari', en: '/calendar/calendars' },
  { it: '/calendario/prenotazioni', en: '/calendar/bookings' },
  { it: '/calendario/disponibilita', en: '/calendar/availability' },
  { it: '/calendario/event-types/:id', en: '/calendar/event-types/:id' },
  { it: '/calendario/event-types', en: '/calendar/event-types' },
  { it: '/calendario', en: '/calendar' },
  { it: '/blog/ai', en: '/blog/ai' },
  { it: '/blog/new', en: '/blog/new' },
  { it: '/blog/:id', en: '/blog/:id' },
  { it: '/blog', en: '/blog' },
  { it: '/portfolio/new', en: '/portfolio/new' },
  { it: '/portfolio/:id', en: '/portfolio/:id' },
  { it: '/portfolio', en: '/portfolio' },
  { it: '/brain', en: '/second-brain' },
  { it: '/notes/:id', en: '/notes/:id' },
  { it: '/notes', en: '/notes' },
  { it: '/boards/sketch/:id', en: '/boards/sketch/:id' },
  { it: '/boards/sketch', en: '/boards/sketch' },
  { it: '/boards/mindmap/:id', en: '/boards/mind-maps/:id' },
  { it: '/boards/mindmap', en: '/boards/mind-maps' },
  { it: '/workflows/:id', en: '/workflows/:id' },
  { it: '/workflows', en: '/workflows' },
  { it: '/domini', en: '/domains' },
  { it: '/fatturazione', en: '/billing' },
  { it: '/analytics', en: '/analytics' },
  { it: '/impostazioni', en: '/settings' },
];

function splitPath(raw: string) {
  const hashIndex = raw.indexOf('#');
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  const queryIndex = beforeHash.indexOf('?');
  return {
    pathname: queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash,
    suffix: `${queryIndex >= 0 ? beforeHash.slice(queryIndex) : ''}${hash}`,
  };
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

function fillPattern(pattern: string, params: Record<string, string>) {
  return pattern
    .split('/')
    .map((part) => (part.startsWith(':') ? params[part.slice(1)] : part))
    .join('/');
}

export function localizeAdminPath(rawPath: string, locale: AdminLocale): string {
  if (!rawPath.startsWith('/')) return rawPath;
  const { pathname, suffix } = splitPath(rawPath);
  const targetLocale = locale;
  const sourceLocales: AdminLocale[] = targetLocale === 'en' ? ['it', 'en'] : ['en', 'it'];

  for (const sourceLocale of sourceLocales) {
    for (const route of ROUTES) {
      const params = matchPattern(route[sourceLocale], pathname);
      if (!params) continue;
      return `${fillPattern(route[targetLocale], params)}${suffix}`;
    }
  }

  return rawPath;
}

export function getLocalizedRoutePair(itPath: string): LocalizedRoute | undefined {
  return ROUTES.find((route) => route.it === itPath);
}
