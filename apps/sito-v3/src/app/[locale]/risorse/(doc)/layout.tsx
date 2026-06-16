import { Link } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { SITE } from '@/data/site';
import type { Locale } from '@/lib/i18n';

/**
 * Standalone-document layout for /risorse resources that ship their own full
 * design (e.g. the GEO white paper). No SiteHeader/SiteFooter — only a minimal
 * "back to calicchia.design" bar. The page itself injects its own CSS, so this
 * wrapper stays intentionally bare.
 */
export default async function ResourceDocLayout({ children }: { children: React.ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const back = locale === 'en' ? 'Back to calicchia.design' : 'Torna a calicchia.design';

  return (
    <div className="geo-doc-shell">
      <div
        className="geo-doc-bar"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '10px 20px',
          borderBottom: '1px solid #111111',
          background: '#f7f6f3',
          fontFamily: 'var(--font-sans), system-ui, sans-serif',
        }}
      >
        <Link
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            color: '#111111',
            textDecoration: 'none',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          <span aria-hidden>←</span>
          {back}
        </Link>
        <span
          style={{
            fontFamily: 'var(--font-display), sans-serif',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: '#f57f44',
          }}
        >
          {SITE.brand}
        </span>
      </div>
      {children}
    </div>
  );
}
