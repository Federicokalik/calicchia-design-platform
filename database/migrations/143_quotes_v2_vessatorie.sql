-- 143: Specific approval of "clausole vessatorie" (artt. 1341-1342 c.c.)
-- in the quotes_v2 FEA signing flow.
--
-- vessatorie_approved_at  → when the client explicitly approved the clauses
-- vessatorie_snapshot     → frozen list [{numero, titolo}] of the clauses as
--                           they were presented at signature time (evidentiary
--                           value: later edits to quote.settings must not
--                           change what was approved).

ALTER TABLE quotes_v2
  ADD COLUMN IF NOT EXISTS vessatorie_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vessatorie_snapshot JSONB;

COMMENT ON COLUMN quotes_v2.vessatorie_approved_at IS 'Specific approval timestamp for clausole vessatorie (artt. 1341-1342 c.c.)';
COMMENT ON COLUMN quotes_v2.vessatorie_snapshot IS 'Frozen [{numero, titolo}] of the vessatorie clauses approved at signature time';
