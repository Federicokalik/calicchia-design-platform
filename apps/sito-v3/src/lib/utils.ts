import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Tailwind v4 + custom utilities — teach tailwind-merge that our portal type
 * scale (`text-portal-*`) is a font-size group, NOT a color group, so it
 * doesn't strip those classes when paired with `text-muted-foreground`,
 * `text-destructive`, etc. (color group).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'portal-display',
            'portal-h1',
            'portal-h2',
            'portal-h3',
            'portal-body',
            'portal-caption',
            'portal-label',
          ],
        },
      ],
    },
  },
});

/** Tailwind-aware classnames helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Clamp `n` between `min` and `max`. */
export const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

/** Linear remap of `n` from input range to output range. */
export const mapRange = (
  n: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number => outMin + ((n - inMin) * (outMax - outMin)) / (inMax - inMin);
