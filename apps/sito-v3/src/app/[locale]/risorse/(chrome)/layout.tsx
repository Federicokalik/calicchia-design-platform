import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

/**
 * Chrome layout for /risorse pages that live inside the site (the hub and the
 * migrated glossaries). Mirrors the (site) layout. The standalone documents
 * live in the sibling (doc) group, which has its own bare layout.
 */
export default function ResourceChromeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
