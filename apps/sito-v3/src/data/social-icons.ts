/**
 * Mapping centrale icon-key → componente Phosphor.
 * Riusato da SiteFooter, MenuOverlay, ContactSocials, qualsiasi altra
 * UI che renderizzi `SITE.social[]`.
 *
 * Aggiungere nuovi social = un'entry qui + estensione di SITE.social[].
 * La key è quella di `icon` in `SITE.social[i].icon` (kebab-case lower).
 */

import {
  FacebookLogo,
  GitBranch,
  GithubLogo,
  Globe,
  InstagramLogo,
  LinkedinLogo,
  MastodonLogo,
  TelegramLogo,
  WhatsappLogo,
  XLogo,
  YoutubeLogo,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType } from 'react';

type PhosphorIcon = ComponentType<{
  size?: number;
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
  className?: string;
  'aria-hidden'?: boolean;
}>;

const ICON_MAP: Record<string, PhosphorIcon> = {
  'instagram-logo': InstagramLogo,
  'linkedin-logo': LinkedinLogo,
  'github-logo': GithubLogo,
  'git-branch': GitBranch,
  'facebook-logo': FacebookLogo,
  'telegram-logo': TelegramLogo,
  'whatsapp-logo': WhatsappLogo,
  'mastodon-logo': MastodonLogo,
  'x-logo': XLogo,
  'youtube-logo': YoutubeLogo,
};

/**
 * Resolve un icon-key (es. "instagram-logo") al componente Phosphor.
 * Fallback: `Globe` (icona generica) se la key non è registrata —
 * graceful per nuovi social aggiunti in `SITE.social[]` prima di
 * mappare l'icona qui.
 */
export function getSocialIcon(iconKey: string | undefined | null): PhosphorIcon {
  if (!iconKey) return Globe;
  return ICON_MAP[iconKey] ?? Globe;
}

export type { PhosphorIcon };
