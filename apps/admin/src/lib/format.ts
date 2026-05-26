/**
 * Display helpers used by admin pages.
 *
 * Keep these pure (no React, no i18n imports) so they can be called from any
 * component or reducer without pulling extra dependencies into a bundle chunk.
 */

/**
 * Format a phone number stored in E.164-without-plus form (the shape used by
 * `whatsapp_conversations.phone`, e.g. "393517773467") into a human-readable
 * "+39 351 777 3467" string.
 *
 * Italian numbers (39 country code, 12 digits total) are grouped XXX XXX XXXX
 * which matches how Italian mobile numbers are read aloud. Other countries
 * fall back to a generic "+CC XXX XXX XXXX" grouping by three. Strings that
 * are not numeric are returned unchanged so we don't mangle anything weird
 * that ends up in the DB.
 */
export function formatPhoneE164(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return String(raw);

  // Italian mobile: +39 + 10 digits → +39 XXX XXX XXXX
  if (digits.length === 12 && digits.startsWith('39')) {
    return `+39 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }

  // Italian variable-length (landline, older mobile shapes) — group remainder by 3
  if (digits.startsWith('39') && digits.length >= 10 && digits.length <= 13) {
    const rest = digits.slice(2);
    const groups = rest.match(/.{1,3}/g) ?? [rest];
    return `+39 ${groups.join(' ')}`;
  }

  // Generic international fallback: assume 2-digit country code, group rest by 3
  const cc = digits.slice(0, 2);
  const rest = digits.slice(2);
  const groups = rest.match(/.{1,3}/g) ?? [rest];
  return `+${cc} ${groups.join(' ')}`;
}

/**
 * Initials extracted from a person/contact display name. Used by chat avatars.
 * Falls back to "?" for empty input so the avatar circle is never blank.
 */
export function initialsOf(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic color for an avatar background derived from an arbitrary key
 * (phone number, chat id, name). The output is an HSL string with fixed
 * saturation/lightness so it always reads well against white text.
 */
export function avatarColorFor(key: string | null | undefined): string {
  const seed = String(key ?? '');
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return `hsl(${h}, 55%, 50%)`;
}
