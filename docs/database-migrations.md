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

## Rollback (`database/migrations/down/`)

Il runner applica solo in avanti. Dalla 167 ogni migrazione ha il suo rollback in
`database/migrations/down/<nome>.down.sql`: la cartella non viene letta dal
runner, che considera solo i `.sql` al primo livello di `database/migrations/`.
Il file di rollback rimuove anche la riga del ledger, così una nuova esecuzione
del runner riapplica la migrazione. Si esegue a mano, in una sola transazione,
**dopo** aver rimesso in produzione il codice precedente (che non legge le
colonne rimosse):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/migrations/down/167_billing_emails_mail_attachments.down.sql
```

Il ciclo up → down → up va provato su un database di test prima del rilascio.

## Migrazioni distruttive — backup obbligatorio (DB-10)

La maggior parte delle migrazioni è additiva, ma alcune sono **distruttive** e
non reversibili:

| File | Operazione |
|------|-----------|
| `081_drop_woocommerce.sql` | `DROP TABLE` delle tabelle WooCommerce |
| `083_portal_access_code_drop_plaintext.sql` | `DROP COLUMN` del codice portale in chiaro |

**Prima di applicarle a un ambiente che contiene dati**, eseguire un backup
verificato del database (`scripts/backup-db.sh`, che dalla fase F1 del
calendario delega a `scripts/backup-calendar-stack.sh`: il dump è in
`$BACKUP_DIR/calendar-stack/<id>/caldes-db.sql.gz` e su MEGA S4 in
`s3://$S4_BUCKET/calendar-stack/<id>/`). Per tornare indietro:
`scripts/restore-calendar-stack.sh --only db <run>` oppure
`scripts/restore-db.sh <…>/calendar-stack/<id>/caldes-db.sql.gz`. La cartella
`s3://$S4_BUCKET/db/` contiene solo i dump precedenti alla F1. Su un DB creato
da zero non c'è nulla da perdere; il vincolo riguarda gli ambienti con dati
reali.

## ON DELETE RESTRICT su `customers` (MG-05)

Diverse foreign key verso `customers` sono `ON DELETE RESTRICT` (es. `quotes.customer_id`
in `010_invoicing.sql`). Conseguenza: **un cliente con preventivi/fatture collegati
non può essere cancellato con un `DELETE` diretto** — Postgres lo rifiuta.

È intenzionale: protegge l'integrità di documenti fiscali. La cancellazione GDPR
di un interessato NON deve quindi passare da un `DELETE` su `customers`, ma
dall'endpoint dedicato `/api/gdpr-requests/erase` che **anonimizza** il record e
i dati collegati mantenendo i riferimenti contabili. Vedi `GDPR-COMPLIANCE.md` e
il finding GDPR-03.
