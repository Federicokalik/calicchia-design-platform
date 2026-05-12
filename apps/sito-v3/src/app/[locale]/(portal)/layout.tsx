/**
 * Portal layout — pass-through. Each portal page wraps itself with
 * `<PortalShell>` explicitly so login and share-link pages can opt out
 * (they render bare).
 *
 * Auth gate (TODO Phase 7+): a server-side session check reads the
 * httpOnly cookie set by `apps/api` and redirects unauthenticated visits
 * away from shelled pages to `/clienti/login`. Wiring is out of scope of
 * this UI plan — the structure is ready.
 */
export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  await params;
  // data-portal-shell scopes shadcn token overrides defined in
  // styles/portal-theme.css (e.g. --color-accent → surface-elev). Outside
  // this attribute, brand tokens stay untouched.
  return <div data-portal-shell>{children}</div>;
}
