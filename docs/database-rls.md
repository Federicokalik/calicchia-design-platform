# Database: Row Level Security disabilitata (decisione DB-07)

## Decisione

Row Level Security (RLS) di Postgres è **deliberatamente disabilitata** su tutte le
tabelle dello schema `public`. Il controllo degli accessi è interamente delegato al
middleware di autenticazione Hono dell'API (`apps/api/src/middleware/auth.ts`).

## Perché

Lo schema originale del progetto nasceva su Supabase, dove RLS è il meccanismo di
sicurezza primario e le policy sono valutate per ogni client che si connette al DB
con la propria identità (`anon`, `authenticated`, JWT Supabase).

L'architettura attuale è diversa (vedi invariante 1 in `CLAUDE.md`):

- **`apps/api` è l'unico layer che tocca Postgres.** `sito-v3` e `admin` chiamano
  l'API via HTTP, mai il DB direttamente.
- L'API si connette con **un solo ruolo applicativo fidato** (un singleton
  `postgres` in `apps/api/src/db/index.ts`).
- L'autorizzazione (admin-only sui path protetti, sessione a scadenza, allowlist
  dei path pubblici) è applicata **prima** che la query raggiunga il DB.

In questo modello RLS non aggiungerebbe sicurezza — la connessione è già fidata —
ma introdurrebbe complessità e rischio: le policy storiche referenziano `auth.uid()`
e i ruoli Supabase (`anon`, `authenticated`, `service_role`), che qui esistono solo
come stub `NOLOGIN` creati da `apps/api/database/000_init.sql`. Lasciare RLS attiva
con policy che dipendono da un `auth.uid()` fittizio darebbe una falsa garanzia.

## Come è applicata

Il runner delle migrazioni (`apps/api/scripts/migrate.ts`), al termine di ogni
esecuzione, fa `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` su ogni tabella di
`public`. Le migrazioni storiche che creano ancora policy RLS (es. la `002` è
saltata del tutto; altre creano `CREATE POLICY` inline) restano quindi inerti.

## Conseguenza

Qualsiasi query che raggiunge Postgres è già autorizzata a monte. Non aggiungere
logica di sicurezza basata su RLS senza prima rivedere questa decisione: andrebbe
contro l'invariante "l'API è l'unico layer che tocca Postgres".
