import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  // shadcn/Radix è scopato al solo route group `(portal)/clienti/*` per
  // evitare due design system mescolati. Vieta import dal namespace portal
  // ovunque tranne dentro `app/[locale]/(portal)/**`.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/app/[locale]/(portal)/**', 'src/components/portal/**'],
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
