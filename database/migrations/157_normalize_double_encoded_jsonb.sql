-- Migration 157 — jsonb salvati come stringa JSON (doppia codifica).
--
-- workflows, notes e boards scrivevano con `${JSON.stringify(obj)}`: con
-- postgres-js una stringa passata a una colonna jsonb diventa uno scalare
-- stringa, non un oggetto. Effetto più grave: trigger_config->>'event_type'
-- e ->>'webhook_id' restavano NULL, quindi fireEvent() e /api/wh/:id non
-- trovavano mai i workflow a evento/webhook creati o salvati dall'admin.
-- Le route ora scrivono con sql.json(); qui si convertono i dati esistenti.
-- `#>> '{}'` estrae il testo dello scalare stringa, che viene riletto come jsonb.
-- Idempotente: tocca solo le righe ancora di tipo 'string'.

UPDATE workflows SET trigger_config = (trigger_config #>> '{}')::jsonb
  WHERE jsonb_typeof(trigger_config) = 'string';
UPDATE workflows SET nodes = (nodes #>> '{}')::jsonb
  WHERE jsonb_typeof(nodes) = 'string';
UPDATE workflows SET edges = (edges #>> '{}')::jsonb
  WHERE jsonb_typeof(edges) = 'string';
UPDATE workflows SET variables = (variables #>> '{}')::jsonb
  WHERE jsonb_typeof(variables) = 'string';

UPDATE notes SET content = (content #>> '{}')::jsonb
  WHERE jsonb_typeof(content) = 'string';

UPDATE boards SET data = (data #>> '{}')::jsonb
  WHERE jsonb_typeof(data) = 'string';

-- Note scritte nell'editor: raw_markdown (che alimenta search_vector,
-- anteprima e ricerca dell'agente) non veniva mai aggiornato. Per quelle con
-- contenuto ma senza testo, si ricava il testo dai nodi `text` del JSON Tiptap;
-- dal prossimo salvataggio lo deriva l'API. Il trigger su raw_markdown
-- aggiorna search_vector.
UPDATE notes n SET raw_markdown = t.txt
FROM (
  SELECT id, string_agg(v #>> '{}', ' ') AS txt
  FROM notes, jsonb_path_query(content, 'strict $.**.text') AS v
  WHERE content IS NOT NULL AND jsonb_typeof(content) = 'object'
    AND (raw_markdown IS NULL OR raw_markdown = '')
  GROUP BY id
) t
WHERE n.id = t.id AND t.txt IS NOT NULL;
