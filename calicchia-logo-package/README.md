# Calicchia Design — Logo Animation Package

Pacchetto pronto per integrare l'animazione del logo (full → tilde) nel sito Next.js 16.

## Contenuto

```
calicchia-logo-package/
├── IMPLEMENTATION.md          # Spec tecnica completa (passare a Claude Code)
├── components/Logo/
│   ├── Logo.tsx               # Componente client React + animazione viewBox
│   ├── Logo.module.css        # Stili scoped swiss-revival
│   ├── Logo.paths.ts          # SVG path data estratti
│   └── index.ts               # Barrel export
├── hooks/
│   └── useScrollCollapse.ts   # Hook scroll trigger riusabile
└── styles/
    └── motion-tokens.css      # Design tokens motion globali
```

## Prompt suggerito per Claude Code

Copia il contenuto qui sotto in Claude Code dopo aver caricato il pacchetto:

```
Implementa il componente Logo seguendo IMPLEMENTATION.md.

Contesto progetto:
- Next.js 16 (App Router)
- TypeScript strict
- pnpm
- CSS Modules (non Tailwind, almeno non per questo componente)
- Path alias @/* configurato in tsconfig.json verso ./

Steps:
1. Copia i file nelle path indicate (components/Logo/*, hooks/*, styles/*)
2. Importa motion-tokens.css in app/globals.css se non esiste già un sistema motion tokens
3. Identifica l'header esistente nel progetto (probabile: app/components/Header.tsx
   o app/(layout)/header.tsx — cerca la sezione che contiene l'attuale logo
   "Calicchia / Design ~ web designer")
4. Sostituisci l'asset logo esistente con <Logo /> in modalità uncontrolled
5. Esegui i test descritti nella sezione 6 di IMPLEMENTATION.md
6. Verifica che non ci siano warning di hydration mismatch (lo stato iniziale
   deve essere "espanso" sia server-side che al primo render client)

Vincoli:
- Non aggiungere dipendenze npm (no Framer Motion, no GSAP)
- Non toccare il resto del layout — solo sostituire l'asset logo
- Mantenere accessibilità: il <title> dell'SVG resta "Calicchia Design"
- Se il progetto già ha motion design tokens definiti diversi da quelli in
  motion-tokens.css, NON sovrascriverli — adatta i nomi nel CSS module
  a quelli esistenti

Dopo l'integrazione, mostrami:
- Il diff sull'header
- L'eventuale aggiunta su globals.css
- Conferma dei test eseguiti
```

## Personalizzazioni post-integrazione

Tutte modificabili senza toccare il componente:

```css
/* Sovrascrivi nel parent del Logo per cambiare altezza */
.header :global(svg) {
  --logo-height: 56px; /* default 48px */
}

/* Sovrascrivi i motion tokens per allineare ad altri timing del sito */
:root {
  --motion-fast: 200ms;
  --motion-base: 280ms;
}
```

## API del componente

```tsx
<Logo />                                      // uncontrolled, threshold 80px
<Logo collapsed={isScrolled} />               // controlled
<Logo scrollThreshold={120} />                // custom threshold
<Logo className="my-custom-class" />          // styling aggiuntivo
```
