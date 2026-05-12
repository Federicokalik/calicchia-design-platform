import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing';

/**
 * next-intl Server Component config — invocato da next-intl per ogni request.
 * Carica lazy i namespace per locale dalla cartella `messages/{locale}/*.json`.
 *
 * Namespace caricati upfront (small payload): common, navigation.
 * Namespace lazy (caricati on-demand dalla page tramite `useTranslations`):
 * home, lavori, servizi, contatti, perche, blog, landing.
 *
 * Pattern: ogni page importa solo i namespace che usa via
 * `useTranslations('home')` etc. — next-intl tree-shake automatico.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  // Carico tutti i namespace per default (overhead ~5-15KB JSON, accettabile).
  // In futuro se i messages crescono, splittare per route via getMessages selettivo.
  const perche = (await import(`./messages/${locale}/perche.json`)).default;
  const messages = {
    ...(await import(`./messages/${locale}/common.json`)).default,
    navigation: (await import(`./messages/${locale}/navigation.json`)).default,
    home: (await import(`./messages/${locale}/home.json`)).default,
    lavori: (await import(`./messages/${locale}/lavori.json`)).default,
    servizi: (await import(`./messages/${locale}/servizi.json`)).default,
    contatti: (await import(`./messages/${locale}/contatti.json`)).default,
    perche,
    blog: (await import(`./messages/${locale}/blog.json`)).default,
    landing: (await import(`./messages/${locale}/landing.json`)).default,
    curiosita: (await import(`./messages/${locale}/curiosita.json`)).default,
    portal: (await import(`./messages/${locale}/portal.json`)).default,
    // Component-level keys consumati da useTranslations('xxx') diretto (no namespace
    // path). Estratti da perche.json ma esposti top-level perché PerchiFaqs,
    // PerChiLavoro, ApproachStack sono riusabili anche fuori da /perche-scegliere-me.
    perchiFaqs: perche.perchiFaqs,
    perChiLavoro: perche.perChiLavoro,
    approachStack: perche.approachStack,
  };

  return {
    locale,
    messages,
  };
});
