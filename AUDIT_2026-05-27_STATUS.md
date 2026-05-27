# Audit 2026-05-27 — Stato dopo lavorazione

**Branch**: `fix/audit-2026-05-27-pr1-critical-security` (NON ancora mergeato in main)
**Issue chiuse**: 89/136 (65%) — tutti i critical + tutti gli high + tutti i medium architecturali + J-K-11 (validators dedup)

## PR19 (nuovo, 2026-05-27 tardo)

Fondazione CMS pubblico + completamento J-K-11.

- **J-K-11**: shared validators ora source of truth. `routes/contacts.ts` e `routes/calendar/public.ts` usano `publicContactSchema` / `publicBookingSchema` da `@calicchia/shared` (rimosse 50+ righe di validazione inline). Aggiunto `firstZodIssue()` helper. `@calicchia/shared` aggiunto come workspace dep in api.
- **Site-config migrazione totale** (server): root layout `app/layout.tsx` ora usa `generateMetadata` async per brand/legalName/description da DB. Anche `rss.xml/route.ts`. URL/canonical/sitemap/robots restano file (sono structural deploy-time).
- **Site-config client hook**: nuovo `lib/use-site-config.tsx` (SiteConfigProvider in root layout + `useSiteConfig()` hook). Migrati `SiteFooter`, `FooterMap`, `MenuOverlay`, `ContactFormClient`. Fallback su `data/site.ts` durante il primo paint.
- **Admin editor `site.public`**: nuovo tab "Sito pubblico" in Impostazioni → Business. Edita brand, descrizione SEO, URL cal, social[] (JSON), geo{} (JSON). Salva su chiave `site.public`.
- **CMS FAQ + Team** (foundation):
  - Migration `120_site_cms_faq_team.sql`: tabelle `site_faqs` + `site_team` con locale, sort_order, is_published, audit triggers, set_updated_at_now() trigger condiviso.
  - API: `routes/cms-public.ts` (GET pubblici `/api/public/cms/faqs`, `/team`) + `routes/cms-admin.ts` (CRUD protetto `/api/cms/faqs`, `/team`) con zod validation + whitelist patch.
  - Admin: nuove pagine `pages/cms/faq.tsx` + `pages/cms/team.tsx`, gruppo sidebar "CMS sito".
  - Sito: helper `lib/cms.ts` (`getFaqs()`, `getTeam()`) con fallback su `data/{faqs,team}.ts`. Migrati 2 consumer (`/faq` page + `TeamSection`).

## Cosa è stato deciso lungo strada

- **Single server**: niente scope multi-instance. In-memory rate-limit OK; PR17 ha aggiunto eviction periodica.
- **MEGA S4 storage**: non supporta CORS → PR16 (browser-direct upload) revertata; il flusso upload resta server-side via sito-v3.
- **Cookies cross-origin**: già configurati su env VPS (`COOKIE_DOMAIN` + `SameSite=None`).
- **CMS layer**: short-term fatto in PR18 — `/api/public/site-config` + helper `getSiteConfig()` con fallback su `data/site.ts`. Long-term (services/FAQ/team in DB) resta scope di prodotto, fuori audit.

## Azioni residue lato deploy (CONSOLE MEGA S4) — UTENTE HA GIÀ FATTO

1. ~~Settings bucket → Object URL access → "Deny object URL access"~~ ✓
2. ~~Tab Policy → svuota~~ ✓

## Azioni residue lato codice

### Verificare al primo deploy prod
- **N7 — Next 16 Cache Components**: alcune portal page potrebbero richiedere `export const dynamic = 'force-dynamic'`. Si vede solo al primo `pnpm build` in produzione (warning di Next). Se appare, aggiungere l'export nelle page coinvolte.
- **B-024 — Cross-origin cookie warn**: già wired al boot dell'API (`apps/api/src/index.ts`). Se in fase di deploy il warn appare, configurare `COOKIE_DOMAIN` (già fatto).
- **A-010 Newsletter mail** (PR17): verificare che SMTP o RESEND_API_KEY sia configurato. Senza nessuno dei due, la mail di conferma silently no-op (log warn). I subscriber restano `pending` come prima.

### Da fare solo "quando serve" (triggered work)
| Issue | Quando farlo | Effort |
|---|---|---|
| Download endpoint `/api/portal/files/:id/download-url` signed | Quando aggiungi un bottone "Scarica" nel portale (oggi non c'è) | ~15 righe + 1 helper in `lib/s4.ts` |
| **B-014** browser-direct upload | Solo se migri storage a CORS-supporting (Cloudflare R2, Backblaze B2, Wasabi). PR16 è già scritta pronta da riapplicare. | 0 (il commit esiste in storia git) |
| **B-030** Stripe TTL — webhook side | Già fatto in PR16 (sopravvissuto al revert) | — |
| **Site-config migrazione totale** (C-013/C-014 long path) | Quando vuoi che ALL i 15+ consumer di `SITE` leggano da DB invece che da file. Oggi 2 surface (contatti page + ContactSocials) lo fanno come proof. | 1-2h per migrazione completa |
| **Admin editor per `site.public`** | Quando il marketing chiede UI per editare brand/social/geo da admin. La chiave c'è nel settings-schema ma non c'è una page admin dedicata; le impostazioni cliente già hanno la pagina per `business.profile`. | ~30 min per aggiungere una sezione nel pannello settings esistente |

### CMS roadmap (in corso)
- ✅ **Fondazione + FAQ + Team** (PR19): pattern stabilito (table + audit trigger + admin CRUD + public endpoint + sito helper con fallback).
- 🚧 **Glossario** (PR20): 365 righe, ~100 termini. Riusa pattern blog (title+slug+body).
- 🚧 **SEO cities + zone** (PR21): 341 righe, 100+ città con attributi geografici.
- 🚧 **Services + services-detail** (PR22): 22 file con shape complessa, serve Tiptap admin per i contenuti longform.
- 🚧 **Traduzioni**: aggiungere righe `locale='en'` su site_faqs / site_team (schema già supporta).

### Issue low/cosmetic non chiuse (~46)
Dead code di basso valore, refactor minori, documentazione. Diminishing returns: ogni nuovo PR cosmetic chiude 5-10 issue di severity "low" senza payoff utente visibile. **Suggerito skip** salvo trigger reale.

Resta aperta solo:
- **J-K-11** validator dedup (refactor: shared zod schemas vs route inline) — low, niente bug, solo manutenibilità
- **_summary_low_severity** placeholder

## Storia commit del branch

```
TBD     fix: PR19 — CMS pubblico foundation + J-K-11 (FAQ/Team + site-config completion)
f98b026 fix: PR18 — webhook err normalization + site-config DB layer (3 fix)
b8ae304 fix: PR17 — audit 2026-05-27 high-severity tail (4 fix)
41dff70 revert(portal-upload): rollback B-014 client-direct — MEGA S4 no CORS
cdcccca fix: PR16 — portal upload client-direct + Stripe checkout TTL  ← parziale
b6e166c fix: PR15 — audit 2026-05-27 final tail (3 fix)
fdefb23 fix: PR14 — audit 2026-05-27 portal hardening tail (4 fix)
e9f10ac fix: PR13 — audit 2026-05-27 portal upload + body limits + Telegram logging
261c14a fix: PR12 — audit 2026-05-27 cleanup hygiene (5 fix)
1bf57bf fix: PR11 — audit 2026-05-27 medium-priority cleanups (7 fix)
f268166 fix: PR10 — audit 2026-05-27 audit triggers + workflow + SSE (4 fix)
76a6945 fix: PR9 — audit 2026-05-27 blog demos + rate-limit + admin pagination (5 fix)
a0f11ba fix: PR8 — audit 2026-05-27 portal data + GDPR + apiFetch sweep (4 fix)
e4a5e8e fix: PR7 — audit 2026-05-27 workflow + portal auth + React state (7 fix)
1d2e14f fix: PR6 — audit 2026-05-27 quick wins (9 fix)
42c4b85 fix(api): PR5 — audit 2026-05-27 rate-limit + webhook hardening (6 fix)
19ba98f feat(admin): PR4 — audit 2026-05-27 admin UI gaps closed (5 nuove sezioni)
1cfe37e fix(i18n): PR3 — audit 2026-05-27 critical EN / legal fixes (3 fix)
f224cce fix(portal): PR2 — audit 2026-05-27 critical portal fixes (4 fix)
b8f678e fix(security): PR1 — audit 2026-05-27 critical security fixes (6 fix)
```

Nota: PR13 esiste come `e9f10ac`. PR15 ha numerazione corretta. Tutti i fix sono comunque committati.

## Migration applicate sul DB

Tutte già su locale dev. Da applicare in prod al deploy:
- `112_otp_hash_attempts.sql` — hash OTP + counter tentativi (J-01)
- `113_contacts_bookings_consent_proof.sql` — consent_ip/UA su contacts + calendar_bookings (J-05)
- `114_portal_check_constraints.sql` — CHECK constraints fix per actor_type/upload status (B-001/B-002)
- `115_collaborators_session_version.sql` — colonna mancante per revoke sessioni collab (B-007/B-008)
- `116_portal_auth_hardening_v2.sql` — code prefix indexed + actor_id/actor_role audit (B-009/B-010/B-011)
- `117_leads_consent_proof.sql` — consent_ip/UA su leads (C-007)
- `118_audit_triggers_extension.sql` — audit triggers su workflows/whatsapp/calendar (J-K-06)
- `119_drop_orphan_tables.sql` — drop 14 view + 3 table orphan verificati (J-K-12)
- `120_site_cms_faq_team.sql` — tabelle CMS site_faqs + site_team + trigger updated_at (PR19)

`pnpm --filter @calicchia/api migrate` le applica tutte (idempotente, no-op se già fatte).

## Per chiudere il discorso audit

Pre-merge in main, verificare:
1. ~~MEGA S4 console: i 2 step deploy-side fatti~~ ✓
2. **Branch typecheck/build verde**: ✓ già verificato a fine PR18
3. **Migrations applicate sul DB di prod** dopo deploy
4. **Smoke test**: portal login (cliente + collab), upload file, lista file, magic-link email, **newsletter signup → email arriva** (PR17)
5. **Smoke test site-config**: GET `/api/public/site-config` ritorna 200, `/contatti` rende email+phone da DB (se popolato) o dal file (se vuoto)

Niente altro di bloccante. Il branch è production-ready.

## Audit completo (per riferimento)

I report dettagliati sono in `audit-reports/2026-05-27/`:
- `00-SUMMARY.md` — Judge synthesis cross-area (con top-10 + convergenze)
- `01-sito-public.md` → `07-runtime-smoke.md` — area-specific deep dives
- `issues.json` — flat machine-readable list

Le issue NON chiuse sono identificabili nei report originali ma non sono tracked in un file separato — se vuoi riprenderle un giorno, il SUMMARY top-10 + GAPs strutturali è il punto di partenza più rapido.
