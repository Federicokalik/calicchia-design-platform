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
];
