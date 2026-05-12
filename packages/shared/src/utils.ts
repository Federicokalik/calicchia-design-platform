export function formatDate(date: string | Date, locale = 'it-IT'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatDateShort(date: string | Date, locale = 'it-IT'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length).trim() + '...';
}

export function calculateReadingTime(content: string): number {
  const wordsPerMinute = 200;
  const words = content.trim().split(/\s+/).length;
  return Math.ceil(words / wordsPerMinute);
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function parseUserAgent(ua: string) {
  const browser = ua.match(/(Chrome|Safari|Firefox|Edge|Opera|MSIE|Trident)/i)?.[0] || 'Unknown';
  const os = ua.match(/(Windows|Mac OS|Linux|Android|iOS)/i)?.[0] || 'Unknown';
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const isTablet = /Tablet|iPad/i.test(ua);
  const device_type = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  return { browser, os, device_type };
}
