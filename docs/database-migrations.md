# Database: migrazioni e operazioni

## Runner

`apps/api/scripts/migrate.ts` applica le migrazioni. Traccia i file applicati in
una tabella `schema_migrations` (ledger) e applica solo quelli mancanti — la
ri-esecuzione è un no-op. NON ingoia gli errori "already exists": una migrazione
che fallisce blocca l'intera esecuzione.

```bash
pnpm --filter @calicchia/api migrate    # applica le migrazioni pendenti
```

Ordine: prima lo schema base pulito (`apps/api/database/*.sql`), poi le
migrazioni numerate (`database/migrations/*.sql`). I file Supabase-only
(`002_rls_policies.sql`, `028_supabase_storage.sql`) sono saltati di proposito.

Le migrazioni sono **append-only**: non modificare un file già spedito, aggiungine
uno nuovo con il numero successivo.

## Migrazioni distruttive — backup obbligatorio (DB-10)

La maggior parte delle migrazioni è additiva, ma alcune sono **distruttive** e
non reversibili:

| File | Operazione |
|------|-----------|
| `081_drop_woocommerce.sql` | `DROP TABLE` delle tabelle WooCommerce |
| `083_portal_access_code_drop_plaintext.sql` | `DROP COLUMN` del codice portale in chiaro |

**Prima di applicarle a un ambiente che contiene dati**, eseguire un backup
verificato del database (`scripts/backup-db.sh` — il dump viene anche caricato
off-site su MEGA S4). Su un DB creato da zero non c'è nulla da perdere; il
vincolo riguarda gli ambienti con dati reali.

## ON DELETE RESTRICT su `customers` (MG-05)

Diverse foreign key verso `customers` sono `ON DELETE RESTRICT` (es. `quotes.customer_id`
in `010_invoicing.sql`). Conseguenza: **un cliente con preventivi/fatture collegati
non può essere cancellato con un `DELETE` diretto** — Postgres lo rifiuta.

È intenzionale: protegge l'integrità di documenti fiscali. La cancellazione GDPR
di un interessato NON deve quindi passare da un `DELETE` su `customers`, ma
dall'endpoint dedicato `/api/gdpr-requests/erase` che **anonimizza** il record e
i dati collegati mantenendo i riferimenti contabili. Vedi `GDPR-COMPLIANCE.md` e
il finding GDPR-03.
