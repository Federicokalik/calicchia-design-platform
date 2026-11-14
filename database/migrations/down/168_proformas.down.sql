-- Rollback di 168_proformas.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/migrations/down/168_proformas.down.sql
-- ATTENZIONE: elimina tutte le proforma e i progressivi (i PDF in
-- PRIVATE_UPLOAD_DIR/proformas restano: rimuoverli a mano). Le fatture create
-- dalla conversione restano (metadata.proforma_id). Prima del rollback va
-- ripristinato il codice precedente.

DROP TABLE IF EXISTS proformas;
DROP TABLE IF EXISTS document_sequences;

DELETE FROM schema_migrations WHERE version = '168_proformas.sql';
