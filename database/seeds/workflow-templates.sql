-- Workflow Templates — 5 workflow predefiniti

-- 1. Lead Follow-up Automatico
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Lead Follow-up Automatico',
  'Ogni giorno alle 9 controlla lead inattivi e invia follow-up via email o WhatsApp',
  'draft',
  'cron',
  '{"interval_hours": 24, "time": "09:00"}',
  '[
    {"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno ore 9","interval_hours":24,"time":"09:00"}},
    {"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Lead inattivi 5+ giorni","query":"SELECT name, email, phone, company, status, estimated_value FROM leads WHERE status IN (''new'',''contacted'',''proposal'') AND updated_at < NOW() - INTERVAL ''5 days'' ORDER BY estimated_value DESC NULLS LAST LIMIT 10"}},
    {"id":"l1","type":"logic_loop","position":{"x":550,"y":200},"data":{"label":"Per ogni lead","array_field":"rows"}},
    {"id":"a1","type":"llm_chat","position":{"x":800,"y":150},"data":{"label":"Genera email follow-up","prompt":"Scrivi un''email di follow-up breve e professionale per {{name}} di {{company}}. Tono cordiale. Max 5 righe. Firma: Federico Calicchia, Web Designer.","provider":"auto","temperature":0.7}},
    {"id":"c1","type":"logic_condition","position":{"x":800,"y":300},"data":{"label":"Ha telefono?","condition":"input.phone && input.phone.length > 5","subtype":"condition"}},
    {"id":"w1","type":"tool_send_telegram","position":{"x":1100,"y":200},"data":{"label":"Notifica Telegram","message":"📋 Follow-up inviato a {{name}} ({{company}})"}}
  ]',
  '[
    {"id":"e1","source":"t1","target":"q1"},
    {"id":"e2","source":"q1","target":"l1"},
    {"id":"e3","source":"l1","target":"a1"},
    {"id":"e4","source":"a1","target":"c1"},
    {"id":"e5","source":"c1","target":"w1","sourceHandle":"handle-true"},
    {"id":"e6","source":"c1","target":"w1","sourceHandle":"handle-false"}
  ]'
);

-- 2. Blog Automatico Settimanale
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Blog Automatico Settimanale',
  'Ogni lunedì genera un articolo blog con ricerca Perplexity + scrittura AI + notifica',
  'draft',
  'cron',
  '{"interval_hours": 168, "time": "10:00"}',
  '[
    {"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni lunedì ore 10"}},
    {"id":"r1","type":"llm_chat","position":{"x":300,"y":200},"data":{"label":"Ricerca topic trending","prompt":"Suggerisci 1 topic trending per un blog di web design/freelancing nel 2026. Rispondi solo con il topic, niente altro.","provider":"auto","task":"blog_research"}},
    {"id":"w1","type":"llm_chat","position":{"x":550,"y":200},"data":{"label":"Scrivi articolo","prompt":"Scrivi un articolo blog di 1500 parole sul topic: {{text}}. Stile professionale ma accessibile. Includi H2, H3, liste puntate. SEO-friendly. In italiano.","provider":"auto","task":"blog_writing"}},
    {"id":"m1","type":"llm_chat","position":{"x":800,"y":200},"data":{"label":"Meta description","prompt":"Genera una meta description SEO di max 155 caratteri per questo articolo: {{text}}","provider":"auto","task":"chat_fast"}},
    {"id":"n1","type":"tool_send_telegram","position":{"x":1050,"y":200},"data":{"label":"Notifica pubblicazione","message":"📝 Articolo blog generato!\nTopic: {{text}}\nMeta: {{summary}}"}}
  ]',
  '[
    {"id":"e1","source":"t1","target":"r1"},
    {"id":"e2","source":"r1","target":"w1"},
    {"id":"e3","source":"w1","target":"m1"},
    {"id":"e4","source":"m1","target":"n1"}
  ]'
);

-- 3. Report Settimanale
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Report Settimanale',
  'Ogni venerdì alle 17 genera un report con stats della settimana e lo invia su Telegram',
  'draft',
  'cron',
  '{"interval_hours": 168, "time": "17:00"}',
  '[
    {"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni venerdì ore 17"}},
    {"id":"q1","type":"tool_db_query","position":{"x":300,"y":150},"data":{"label":"Stats lead","query":"SELECT COUNT(*) as new_leads FROM leads WHERE created_at >= date_trunc(''week'', CURRENT_DATE)"}},
    {"id":"q2","type":"tool_db_query","position":{"x":300,"y":300},"data":{"label":"Stats revenue","query":"SELECT COALESCE(SUM(amount),0) as revenue FROM payment_tracker WHERE status=''pagata'' AND paid_date >= date_trunc(''week'', CURRENT_DATE)"}},
    {"id":"s1","type":"llm_summarize","position":{"x":600,"y":200},"data":{"label":"Genera report","max_length":300,"style":"narrativo, con emoji"}},
    {"id":"n1","type":"tool_send_telegram","position":{"x":850,"y":200},"data":{"label":"Invia report","message":"📊 Report Settimanale\n\n{{summary}}"}},
    {"id":"b1","type":"output_brain_fact","position":{"x":1100,"y":200},"data":{"label":"Salva in memoria","entity_type":"general","fact":"Report settimana: {{summary}}"}}
  ]',
  '[
    {"id":"e1","source":"t1","target":"q1"},
    {"id":"e2","source":"t1","target":"q2"},
    {"id":"e3","source":"q1","target":"s1"},
    {"id":"e4","source":"q2","target":"s1"},
    {"id":"e5","source":"s1","target":"n1"},
    {"id":"e6","source":"n1","target":"b1"}
  ]'
);

-- 4. Preventivo Firmato → Progetto
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Preventivo Firmato → Progetto',
  'Quando un preventivo viene firmato, crea automaticamente il progetto e notifica',
  'draft',
  'event',
  '{"event_type": "preventivo_firmato"}',
  '[
    {"id":"t1","type":"trigger_event","position":{"x":50,"y":200},"data":{"label":"Preventivo firmato","event_type":"preventivo_firmato"}},
    {"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Dettagli preventivo","query":"SELECT q.*, c.contact_name, c.phone FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.id = ''{{quote_id}}''"}},
    {"id":"a1","type":"llm_chat","position":{"x":550,"y":200},"data":{"label":"Genera task breakdown","prompt":"Dato questo preventivo per {{contact_name}}: {{title}} — genera una lista di 5-8 task specifici per completare il progetto. Formato: un task per riga, conciso.","provider":"auto","task":"task_breakdown"}},
    {"id":"n1","type":"tool_send_telegram","position":{"x":800,"y":150},"data":{"label":"Notifica Telegram","message":"✅ Preventivo firmato!\n{{title}} — {{contact_name}}\n\nTask suggeriti:\n{{text}}"}},
    {"id":"w1","type":"tool_send_whatsapp","position":{"x":800,"y":300},"data":{"label":"Ringrazia cliente","phone":"{{phone}}","message":"Ciao {{contact_name}}! 👋 Grazie per aver firmato il preventivo. Inizieremo a lavorare al progetto nei prossimi giorni. Per qualsiasi domanda sono a disposizione! — Federico"}}
  ]',
  '[
    {"id":"e1","source":"t1","target":"q1"},
    {"id":"e2","source":"q1","target":"a1"},
    {"id":"e3","source":"a1","target":"n1"},
    {"id":"e4","source":"a1","target":"w1"}
  ]'
);

-- 5. Brain Daily Digest
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Brain Daily Digest',
  'Ogni mattina alle 8 invia un riepilogo della giornata su Telegram',
  'draft',
  'cron',
  '{"interval_hours": 24, "time": "08:00"}',
  '[
    {"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno ore 8"}},
    {"id":"q1","type":"tool_db_query","position":{"x":300,"y":100},"data":{"label":"Appuntamenti oggi","query":"SELECT COUNT(*) as count FROM cal_bookings WHERE DATE(start_time) = CURRENT_DATE AND status != ''cancelled''"}},
    {"id":"q2","type":"tool_db_query","position":{"x":300,"y":250},"data":{"label":"Task in scadenza","query":"SELECT COUNT(*) as count FROM project_tasks WHERE DATE(due_date) = CURRENT_DATE AND status != ''done''"}},
    {"id":"q3","type":"tool_db_query","position":{"x":300,"y":400},"data":{"label":"Lead nuovi","query":"SELECT COUNT(*) as count FROM leads WHERE DATE(created_at) = CURRENT_DATE"}},
    {"id":"s1","type":"llm_summarize","position":{"x":600,"y":200},"data":{"label":"Genera digest","max_length":200,"style":"conciso con emoji, come un briefing mattutino"}},
    {"id":"n1","type":"tool_send_telegram","position":{"x":850,"y":200},"data":{"label":"Invia digest","message":"☀️ Buongiorno Federico!\n\n{{summary}}"}}
  ]',
  '[
    {"id":"e1","source":"t1","target":"q1"},
    {"id":"e2","source":"t1","target":"q2"},
    {"id":"e3","source":"t1","target":"q3"},
    {"id":"e4","source":"q1","target":"s1"},
    {"id":"e5","source":"q2","target":"s1"},
    {"id":"e6","source":"q3","target":"s1"},
    {"id":"e7","source":"s1","target":"n1"}
  ]'
);
