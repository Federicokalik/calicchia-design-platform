-- Migration 160 — rotazione atomica del refresh token admin.
--
-- Due refresh concorrenti (più schede che ricevono 401 insieme) leggevano lo
-- stesso hash ed emettevano due token: il cookie poteva restare quello
-- scartato e al refresh successivo la sessione "Ricordami" veniva revocata
-- come riuso. La rotazione ora è compare-and-swap; l'hash precedente resta
-- valido per pochi secondi solo per riconoscere la richiesta "perdente"
-- (che non riceve un nuovo cookie e tiene quello del vincitore).

ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS previous_refresh_token_hash TEXT;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
