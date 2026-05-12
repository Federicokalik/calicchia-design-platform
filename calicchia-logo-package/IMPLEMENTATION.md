# Calicchia Design — Logo Animation
## Spec di implementazione per Claude Code

> **Target stack:** Next.js 16+ (App Router), React 19.2+, TypeScript, CSS Modules
> **Compatibile con:** Next.js 14/15 (le API utilizzate sono stabili dal 14)
> **Approccio motion:** swiss-revival contemporaneo (Pentagram-Bierut/Jen)

---

## 1. Obiettivo

Implementare un componente `<Logo />` per il sito Calicchia Design che:

1. Renderizza il logo completo (Calicchia + Design + tilde arancione) nello stato espanso
2. Collassa a sola tilde quando l'utente scrolla oltre una soglia (default 80px)
3. Esegue un'animazione orchestrata di transizione tra i due stati
4. Funziona sia in modalità **uncontrolled** (gestisce internamente lo scroll) sia **controlled** (riceve `collapsed` come prop)
5. Rispetta `prefers-reduced-motion`
6. È SSR-safe e zero-dependencies (no Framer Motion, no GSAP)

---

## 2. Sistema di motion (parametri di design)

| Token | Valore | Note |
|---|---|---|
| `--motion-ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Easing neutro, zero overshoot |
| `--motion-fast` | `240ms` | Durata transizioni text (Calicchia, Design) |
| `--motion-base` | `320ms` | Durata animazione viewBox |
| `--motion-stagger` | `80ms` | Delay tra Calicchia e Design |

**Comportamenti specifici:**

- **Calicchia** → `translateX(-100%)` + `opacity: 0` — esce a sinistra come pannello (movimento ortogonale puro, no scale)
- **Design** → `translateY(100%)` + `opacity: 0` — esce verso il basso (movimento ortogonale, stagger 80ms)
- **Tilde** → `opacity: 0.85` → `1.0` — leggera intensificazione di saturazione (passa da componente a logo standalone). NESSUNA trasformazione spaziale.
- **viewBox** → `[0, 0, 1039.3, 428.3]` → `[14, 80, 460, 428.3]` — animato in JS via RAF, mantiene la stessa scala px/unit

> **Perché ortogonali e niente scale:** è swiss-revival. Movimenti diagonali e implosioni sono linguaggio motion espressivo (Apple, Disney). Qui parliamo Pentagram.

---

## 3. File da creare

```
calicchia-design/
├── components/
│   └── Logo/
│       ├── Logo.tsx           # Componente client React
│       ├── Logo.module.css    # Stili scoped
│       ├── Logo.paths.ts      # SVG path data (estratti per leggibilità)
│       └── index.ts           # Barrel export
├── hooks/
│   └── useScrollCollapse.ts   # Hook riusabile per scroll trigger
└── styles/
    └── motion-tokens.css      # Design tokens motion globali
```

Tutti i file sono inclusi in questo pacchetto, da copiare 1:1 nelle path corrispondenti del progetto.

---

## 4. Integrazione nel layout esistente

### 4.1. Importare i motion tokens globalmente

Nel file `app/globals.css` (o equivalente), aggiungere:

```css
@import '../styles/motion-tokens.css';
```

Oppure, se il progetto usa Tailwind con `@theme`, integrare i valori nei token Tailwind invece che come CSS variables.

### 4.2. Integrare il Logo nell'header

Identificare il componente header esistente (probabilmente `app/components/Header.tsx` o simile). Sostituire il vecchio asset logo con:

```tsx
import { Logo } from '@/components/Logo';

export function Header() {
  return (
    <header className={styles.header}>
      <Logo />
      {/* ...altri elementi: nav, CTA, language switcher */}
    </header>
  );
}
```

In modalità uncontrolled (default), il componente gestisce lo scroll observer internamente.

### 4.3. (Opzionale) Modalità controlled

Se l'header esistente ha già una sua logica di scroll/collapse (es. condivisa con altri elementi), passare `collapsed` esplicitamente:

```tsx
const [scrolled, setScrolled] = useState(false);
// ...logica scroll esistente...

<Logo collapsed={scrolled} />
```

In questo caso, `useScrollCollapse` interno viene ignorato.

---

## 5. Coerenza col sistema visivo del sito

Il logo si integra in un sistema swiss-revival contemporaneo (Pentagram-flavored). Verificare che gli altri elementi del sito condividano gli stessi motion tokens. Esempi:

- I bottoni hover dovrebbero usare `var(--motion-fast)` con `var(--motion-ease-standard)`
- L'apertura del menu (se sticky) dovrebbe usare `var(--motion-base)`
- Le transizioni di lingua (selector `IT/EN`) dovrebbero usare la stessa easing

**Se il progetto NON ha già un motion design system unificato, questo è il momento giusto per crearlo** — il file `motion-tokens.css` può fungere da seme.

---

## 6. Test post-integrazione

Verificare:

1. **Espanso (top page):** logo completo visibile, tilde con `opacity: 0.85`
2. **Scroll oltre 80px:** Calicchia esce a sinistra, Design esce in basso, tilde resta ferma e diventa `opacity: 1`. ViewBox si stringe attorno alla tilde
3. **Scroll di nuovo verso l'alto:** animazione inversa fluida
4. **Reduced motion attivo (System Preferences):** transizioni disabilitate, snap istantaneo tra stati
5. **SSR:** nessun warning di hydration mismatch (lo stato iniziale è sempre "espanso")
6. **Mobile:** la tilde nel collassato deve restare leggibile (non sotto i 24px di altezza visiva)
7. **Multiple instances:** se il logo appare in più posti (header + footer), nessun conflitto di ID/IDs

---

## 7. Edge cases gestiti

- ✅ SSR: `useScrollCollapse` non accede a `document` durante il render server
- ✅ `prefers-reduced-motion`: la viewBox animation snap immediato
- ✅ Cleanup: l'observer e il sentinel sono rimossi su unmount
- ✅ Cleanup RAF: cancelAnimationFrame su unmount o nuova animazione
- ✅ Multiple instances: gli ID `<title>` usano `useId()` di React 18+
- ✅ Controlled vs uncontrolled: la prop `collapsed` ha priorità sul valore interno
- ✅ React Compiler (Next.js 16): il componente è puro, compatibile con auto-memoization

---

## 8. Personalizzazioni esposte

Il componente accetta:

- `collapsed?: boolean` — controlled state
- `scrollThreshold?: number` — soglia px per uncontrolled (default 80)
- `className?: string` — classe aggiuntiva per il container SVG

Per modificare l'altezza del logo, sovrascrivere la CSS variable `--logo-height` nel parent:

```css
.header .logo {
  --logo-height: 56px; /* default 48px */
}
```

---

## 9. Cosa NON fare

- ❌ Non sostituire `requestAnimationFrame` con `setInterval` (jitter su mobile)
- ❌ Non aggiungere Framer Motion / GSAP per questa singola animazione (overkill, +30KB bundle)
- ❌ Non animare il viewBox via CSS — non è cross-browser per attributi SVG
- ❌ Non usare `<img src="logo.svg">` — gli elementi interni non sono targettabili
- ❌ Non cambiare i transform da ortogonali a diagonali — rompe la coerenza swiss
- ❌ Non aggiungere bounce/overshoot all'easing — anti-pattern in swiss-revival

---

## 10. Note finali

Il logo ha **una posizione semantica nel sistema visivo del sito**: la tilde è l'unico elemento arancione "stabile" (gli altri arancioni sono accent puntuali tipo il punto dopo `branding.`, lo status dot di disponibilità, il selettore lingua attivo). L'animazione preserva questa logica: la tilde resta sempre presente, gli altri elementi scivolano via.

Se in futuro il logo viene esteso (es. variante per dark mode), mantenere lo stesso pattern: la tilde è anchor, gli altri elementi sono mobili.
