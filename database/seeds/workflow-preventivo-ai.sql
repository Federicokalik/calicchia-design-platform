-- Workflow: Genera Preventivo con AI

INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Genera Preventivo con AI',
  'Dato un cliente e le sue esigenze, l''AI ricerca l''azienda, analizza i problemi e genera un preventivo completo con voci, prezzi e premessa personalizzata.',
  'draft', 'manual', '{}',
  '[
    {"id":"t1","type":"trigger_manual","position":{"x":50,"y":250},"data":{"label":"Input dati cliente"}},

    {"id":"r1","type":"llm_chat","position":{"x":300,"y":150},"data":{
      "label":"Ricerca azienda",
      "prompt":"Cerca informazioni sull''azienda/sito web: {{website}}. Descrivi in italiano: cosa fa, settore, dimensione stimata, stato del sito web attuale (se lo trovi), eventuali problemi visibili (SEO, design, velocità). Max 300 parole.",
      "provider":"auto",
      "task":"blog_research"
    }},

    {"id":"a1","type":"llm_chat","position":{"x":300,"y":380},"data":{
      "label":"Analizza report manuale",
      "prompt":"Analizza questo report/note sul cliente e identifica: 1) Problemi principali 2) Opportunità 3) Servizi consigliati. Report: {{notes}}",
      "provider":"auto",
      "task":"chat"
    }},

    {"id":"g1","type":"llm_chat","position":{"x":600,"y":250},"data":{
      "label":"Genera voci preventivo",
      "prompt":"Sei un web designer freelance italiano. Basandoti su queste informazioni:\n\nCliente: {{client_name}} ({{company}})\nServizi richiesti: {{services}}\nBudget indicativo: {{budget}}\n\nRicerca azienda:\n{{text}}\n\nAnalisi report:\n{{text}}\n\nGenera un preventivo JSON con questa struttura ESATTA (rispondi SOLO con il JSON, niente altro):\n{\n  \"title\": \"Titolo preventivo\",\n  \"premessa\": \"Testo premessa 2-3 paragrafi personalizzati\",\n  \"offerte\": [\n    {\"nome\": \"Nome servizio\", \"descrizione\": \"Breve desc\", \"prezzo\": 1000, \"consigliata\": true, \"include\": [\"voce 1\", \"voce 2\"], \"esclude\": [\"voce 1\"]}\n  ],\n  \"materiali\": [\"Logo vettoriale\", \"Testi\", \"Foto\"],\n  \"tempistiche\": \"10-15 giorni lavorativi\",\n  \"note\": \"Note per il cliente\"\n}",
      "provider":"auto",
      "task":"task_breakdown",
      "temperature":0.5
    }},

    {"id":"n1","type":"tool_send_telegram","position":{"x":900,"y":250},"data":{
      "label":"Notifica con bozza",
      "message":"📄 Preventivo generato per {{client_name}} ({{company}})!\n\nVoci generate dall''AI. Vai nell''editor per revisione e invio.\n\nDati generati:\n{{text}}"
    }},

    {"id":"b1","type":"output_brain_fact","position":{"x":900,"y":400},"data":{
      "label":"Ricorda cliente",
      "entity_type":"customer",
      "fact":"Generato preventivo per {{client_name}} ({{company}}). Servizi: {{services}}. Budget: {{budget}}."
    }}
  ]',
  '[
    {"id":"e1","source":"t1","target":"r1"},
    {"id":"e2","source":"t1","target":"a1"},
    {"id":"e3","source":"r1","target":"g1"},
    {"id":"e4","source":"a1","target":"g1"},
    {"id":"e5","source":"g1","target":"n1"},
    {"id":"e6","source":"g1","target":"b1"}
  ]'
);
