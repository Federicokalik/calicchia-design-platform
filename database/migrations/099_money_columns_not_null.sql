-- Migration: 099_money_columns_not_null.sql
-- Descrizione: Rende NOT NULL le colonne monetarie di `quotes` e `quotes_v2` (DB-09).
-- Data: 2026-05-21
--
-- `invoices` ha già subtotal/tax_amount/total NOT NULL, ma `quotes` (010) e
-- `quotes_v2` (048) le tengono nullable: un NULL in un totale si propagherebbe
-- silenziosamente nei report e nelle viste (es. invoices_extended). Le colonne
-- hanno già DEFAULT 0, quindi un INSERT che le omette resta valido — qui si
-- aggiunge solo il vincolo NOT NULL, dopo aver normalizzato eventuali NULL.

UPDATE quotes SET
  subtotal   = COALESCE(subtotal, 0),
  tax_amount = COALESCE(tax_amount, 0),
  total      = COALESCE(total, 0)
WHERE subtotal IS NULL OR tax_amount IS NULL OR total IS NULL;

ALTER TABLE quotes ALTER COLUMN subtotal   SET NOT NULL;
ALTER TABLE quotes ALTER COLUMN tax_amount SET NOT NULL;
ALTER TABLE quotes ALTER COLUMN total      SET NOT NULL;

UPDATE quotes_v2 SET
  subtotal   = COALESCE(subtotal, 0),
  tax_amount = COALESCE(tax_amount, 0),
  total      = COALESCE(total, 0)
WHERE subtotal IS NULL OR tax_amount IS NULL OR total IS NULL;

ALTER TABLE quotes_v2 ALTER COLUMN subtotal   SET NOT NULL;
ALTER TABLE quotes_v2 ALTER COLUMN tax_amount SET NOT NULL;
ALTER TABLE quotes_v2 ALTER COLUMN total      SET NOT NULL;
