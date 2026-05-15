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
 * I wrapper sotto cast href / push / replace / redirect a `string` per evitare
 * l'over-strict typing di next-intl quando `pathnames` è definito (tutti gli
 * href devono essere literal type uniti). La traduzione segmenti IT→EN rimane
 * runtime (gestita da next-intl pathnames config). Tradeoff: meno safety
 * statica sugli href, più velocità di iterazione + supporto path runtime-built
 * (es. `/servizi/${slug}`).
 */
const navigation = createNavigation(routing);

type RawLink = typeof navigation.Link;
type RawLinkProps = ComponentProps<RawLink>;

type AppLinkProps = Omit<RawLinkProps, 'href'> & {
  href: string;
};

interface NavigateOptions {
  scroll?: boolean;
}

interface AppRouter {
  push: (href: string, options?: NavigateOptions) => void;
  replace: (href: string, options?: NavigateOptions) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
}

export const Link = navigation.Link as unknown as ComponentType<AppLinkProps>;
// `redirect` non torna mai: il `: never` esplicito è necessario perché
// TypeScript narrowed correctly nelle chiamate (es. `if (!user) redirect(...)`
// dopo redirect, user è narrowed) — il cast `as unknown as` con tipo never
// preserva la semantic.
type RedirectFn = (href: string) => never;
export const redirect: RedirectFn = navigation.redirect as unknown as RedirectFn;
export const usePathname = navigation.usePathname;
export const useRouter = navigation.useRouter as unknown as () => AppRouter;
export const getPathname = navigation.getPathname;
