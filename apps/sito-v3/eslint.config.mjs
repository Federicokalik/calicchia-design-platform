import nextConfig from 'eslint-config-next';

export default [
  ...nextConfig,
  // Downgrade delle regole troppo strict introdotte da eslint-plugin-react-hooks v7
  // e eslint-config-next 16 — manteniamo la visibilità (warning) ma non blocchiamo
  // CI su patterns legacy che andranno ripuliti gradualmente.
  {
    rules: {
      'react/no-unescaped-entities': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/error-boundaries': 'warn',
      // React Compiler rules (eslint-plugin-react-hooks v7): keep visibility
      // as warnings instead of CI-blocking errors until codebase is audited.
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      '@next/next/no-html-link-for-pages': 'warn',
      '@next/next/no-img-element': 'warn',
    },
  },
  // shadcn/Radix è scopato al solo route group `(portal)/clienti/*` per
  // evitare due design system mescolati. Vieta import dal namespace portal
  // ovunque tranne dentro `app/[locale]/(portal)/**`.
  {
    files: ['src/**/*.{ts,tsx}'],
    // Note: `[locale]` is escaped because minimatch otherwise treats `[...]` as a
    // character class. The pay flow re-uses the portal design system for visual
    // coherence and is therefore also exempted.
    ignores: [
      'src/app/\\[locale\\]/\\(portal\\)/**',
      'src/app/\\[locale\\]/pay/**',
      'src/components/portal/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/components/portal/*', '@/components/portal/**'],
              message:
                'Componenti shadcn (components/portal/ui/*) sono scopati al route group (portal)/clienti/*. Fuori dal portal usa i primitivi Pentagram in @/components/ui/*.',
            },
          ],
        },
      ],
    },
  },
  // i18n navigation guard: impedisce di importare `next/link` raw o le primitive
  // di `next/navigation` che bypassano il wrapper next-intl. Decisione 2026-05-15:
  // tutti gli internal link/redirect DEVONO passare per `@/i18n/navigation` per
  // preservare locale + tradurre i segmenti (/servizi → /services, ecc.).
  //
  // Eccezioni:
  // - `src/i18n/navigation.ts`: il wrapper stesso, importa da next-intl/navigation.
  // - `src/components/providers/ViewTransitionsBootstrap.tsx`: intercepta in
  //   capture phase URL già risolti — non deve ri-tradurre.
  // - `src/components/layout/LanguageSwitcher.tsx`: `window.location.assign`
  //   intenzionale per server-side cookie set via /api/locale.
  // - `src/proxy.ts`: middleware Next.js (NextResponse, etc.).
  // - `src/app/error.tsx`: root error boundary, sta fuori dal NextIntlClientProvider.
  // - `src/app/api/**`: Route Handlers server-side, niente locale concern.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/i18n/navigation.ts',
      'src/components/providers/ViewTransitionsBootstrap.tsx',
      'src/components/layout/LanguageSwitcher.tsx',
      'src/components/layout/AvailabilityTopbar.tsx',
      'src/components/analytics/**',
      'src/proxy.ts',
      'src/app/error.tsx',
      'src/app/api/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/link',
              message:
                "Usa 'import { Link } from \"@/i18n/navigation\"' per preservare il locale corrente nei link interni.",
            },
            {
              name: 'next/navigation',
              importNames: ['useRouter', 'usePathname', 'redirect', 'permanentRedirect'],
              message:
                "Per navigation interna usa '@/i18n/navigation' (preserva locale + traduce segmenti). useSearchParams e notFound sono OK da next/navigation.",
            },
          ],
        },
      ],
    },
  },
];
