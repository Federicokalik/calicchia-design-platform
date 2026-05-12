import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';
import type { ComponentProps, ComponentType } from 'react';

/**
 * next-intl navigation primitives — wrapper sopra Next.js navigation.
 *
 * Usage:
 *   import { Link, useRouter, usePathname, redirect } from '@/i18n/navigation';
 *   <Link href="/lavori">Lavori</Link>  // genera /lavori (IT) o /en/works (EN)
 *
 * Differenza vs next/link diretto: questi helper preservano automaticamente la
 * locale corrente nei link interni e gestiscono redirect locale-aware. Per
 * locale switch esplicito, passa `locale` prop come `<Link locale="en" ...>`.
 *
 * Il wrapper Link sotto cast l'href a `string` per evitare l'over-strict
 * typing di next-intl quando `pathnames` è definito. La traduzione segmenti
 * IT→EN rimane runtime (gestita da next-intl pathnames config). Tradeoff
 * accettato: meno safety statica sugli href, più velocità di iterazione.
 */
const navigation = createNavigation(routing);

type RawLink = typeof navigation.Link;
type RawLinkProps = ComponentProps<RawLink>;

type AppLinkProps = Omit<RawLinkProps, 'href'> & {
  href: string;
};

export const Link = navigation.Link as unknown as ComponentType<AppLinkProps>;
export const redirect = navigation.redirect;
export const usePathname = navigation.usePathname;
export const useRouter = navigation.useRouter;
export const getPathname = navigation.getPathname;
