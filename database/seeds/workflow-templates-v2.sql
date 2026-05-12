-- Workflow Templates v2 — 8 nuovi workflow

-- 6. Lead Scoring
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Lead Scoring Automatico',
  'Quando arriva un lead, AI assegna punteggio. Score > 7 = notifica prioritaria.',
  'draft', 'event', '{"event_type":"nuovo_lead"}',
  '[{"id":"t1","type":"trigger_event","position":{"x":50,"y":200},"data":{"label":"Nuovo lead","event_type":"nuovo_lead"}},{"id":"a1","type":"llm_classify","position":{"x":300,"y":200},"data":{"label":"Valuta lead","categories":["1","2","3","4","5","6","7","8","9","10"],"prompt":"Valuta questo lead da 1 a 10. Nome: {{name}}, Azienda: {{company}}. Rispondi SOLO col numero."}},{"id":"c1","type":"logic_condition","position":{"x":550,"y":200},"data":{"label":"Score > 7?","condition":"parseInt(input.category) > 7","subtype":"condition"}},{"id":"n1","type":"tool_send_telegram","position":{"x":800,"y":120},"data":{"label":"Alert prioritario","message":"🔥 Lead alto potenziale!\n{{name}} ({{company}})\nScore: {{category}}/10"}},{"id":"n2","type":"tool_send_telegram","position":{"x":800,"y":300},"data":{"label":"Log","message":"📋 Nuovo lead: {{name}} — Score: {{category}}/10"}}]',
  '[{"id":"e1","source":"t1","target":"a1"},{"id":"e2","source":"a1","target":"c1"},{"id":"e3","source":"c1","target":"n1","sourceHandle":"handle-true"},{"id":"e4","source":"c1","target":"n2","sourceHandle":"handle-false"}]'
);

-- 7. Preventivo non aperto
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Preventivo non aperto → Promemoria',
  'Preventivi inviati e non aperti dopo 3 giorni → promemoria WhatsApp.',
  'draft', 'cron', '{"interval_hours":24,"time":"10:00"}',
  '[{"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno ore 10"}},{"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Non aperti 3+gg","query":"SELECT q.title, q.total, c.contact_name, c.phone FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.status = ''sent'' AND q.sent_at < NOW() - INTERVAL ''3 days''"}},{"id":"l1","type":"logic_loop","position":{"x":500,"y":200},"data":{"label":"Per ognuno","array_field":"rows"}},{"id":"n1","type":"tool_send_telegram","position":{"x":700,"y":200},"data":{"label":"Notifica","message":"📄 Preventivo non aperto: {{title}} — {{contact_name}}"}}]',
  '[{"id":"e1","source":"t1","target":"q1"},{"id":"e2","source":"q1","target":"l1"},{"id":"e3","source":"l1","target":"n1"}]'
);

-- 8. Preventivo scaduto → follow-up
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Preventivo Scaduto → Follow-up',
  'Preventivi appena scaduti → AI genera email rinnovo.',
  'draft', 'cron', '{"interval_hours":24,"time":"09:00"}',
  '[{"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno"}},{"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Scaduti di recente","query":"SELECT q.title, q.total, c.contact_name FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.status = ''expired'' AND q.valid_until BETWEEN CURRENT_DATE - INTERVAL ''2 days'' AND CURRENT_DATE"}},{"id":"l1","type":"logic_loop","position":{"x":500,"y":200},"data":{"label":"Per ognuno","array_field":"rows"}},{"id":"a1","type":"llm_chat","position":{"x":700,"y":200},"data":{"label":"Email rinnovo","prompt":"Email breve a {{contact_name}}: il preventivo {{title}} è scaduto, possiamo rinnovarlo. Tono cordiale. Firma: Federico.","provider":"auto"}},{"id":"n1","type":"tool_send_telegram","position":{"x":950,"y":200},"data":{"label":"Notifica","message":"📄 Scaduto: {{title}} — bozza:\n{{text}}"}}]',
  '[{"id":"e1","source":"t1","target":"q1"},{"id":"e2","source":"q1","target":"l1"},{"id":"e3","source":"l1","target":"a1"},{"id":"e4","source":"a1","target":"n1"}]'
);

-- 9. Progetto in ritardo
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Progetto in Ritardo → Alert',
  'Progetti con deadline < 3gg e progress < 70% → alert Telegram.',
  'draft', 'cron', '{"interval_hours":24,"time":"08:30"}',
  '[{"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno 8:30"}},{"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Progetti a rischio","query":"SELECT name, progress_percentage, target_end_date FROM client_projects WHERE status = ''in_progress'' AND target_end_date < NOW() + INTERVAL ''3 days'' AND progress_percentage < 70"}},{"id":"c1","type":"logic_condition","position":{"x":550,"y":200},"data":{"label":"Risultati?","condition":"input.count > 0","subtype":"condition"}},{"id":"s1","type":"llm_summarize","position":{"x":750,"y":150},"data":{"label":"Genera alert","max_length":200}},{"id":"n1","type":"tool_send_telegram","position":{"x":1000,"y":150},"data":{"label":"Alert","message":"⚠️ Progetti a rischio:\n\n{{summary}}"}}]',
  '[{"id":"e1","source":"t1","target":"q1"},{"id":"e2","source":"q1","target":"c1"},{"id":"e3","source":"c1","target":"s1","sourceHandle":"handle-true"},{"id":"e4","source":"s1","target":"n1"}]'
);

-- 10. Progetto completato → feedback
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Progetto Completato → Feedback',
  'Dopo 3 giorni dal completamento, genera email richiesta recensione.',
  'draft', 'manual', '{}',
  '[{"id":"t1","type":"trigger_manual","position":{"x":50,"y":200},"data":{"label":"Avvia manualmente"}},{"id":"d1","type":"logic_delay","position":{"x":250,"y":200},"data":{"label":"Attendi 3gg","seconds":259200}},{"id":"a1","type":"llm_chat","position":{"x":500,"y":200},"data":{"label":"Email feedback","prompt":"Email per chiedere una recensione Google a un cliente il cui progetto web è stato completato. Tono caldo. Firma: Federico Calicchia.","provider":"auto"}},{"id":"n1","type":"tool_send_telegram","position":{"x":750,"y":200},"data":{"label":"Bozza","message":"⭐ Bozza email feedback:\n\n{{text}}"}}]',
  '[{"id":"e1","source":"t1","target":"d1"},{"id":"e2","source":"d1","target":"a1"},{"id":"e3","source":"a1","target":"n1"}]'
);

-- 11. Dominio scadenza urgente 7gg
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Dominio Scadenza Urgente (7gg)',
  'Domini con rinnovo manuale in scadenza entro 7 giorni.',
  'draft', 'cron', '{"interval_hours":24,"time":"08:00"}',
  '[{"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno ore 8"}},{"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Domini urgenti","query":"SELECT domain_name || ''.'' || tld as dominio, expiration_date FROM domains WHERE expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL ''7 days'' AND auto_renew = false"}},{"id":"c1","type":"logic_condition","position":{"x":550,"y":200},"data":{"label":"Risultati?","condition":"input.count > 0","subtype":"condition"}},{"id":"n1","type":"tool_send_telegram","position":{"x":800,"y":150},"data":{"label":"Alert urgente","message":"🚨 Domini in scadenza (rinnovo manuale)!\nRinnova subito."}}]',
  '[{"id":"e1","source":"t1","target":"q1"},{"id":"e2","source":"q1","target":"c1"},{"id":"e3","source":"c1","target":"n1","sourceHandle":"handle-true"}]'
);

-- 12. Fattura non pagata → sollecito
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Fattura non pagata → Sollecito',
  'Pagamenti emessi da 30+ giorni → genera sollecito AI.',
  'draft', 'cron', '{"interval_hours":24,"time":"09:00"}',
  '[{"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Ogni giorno"}},{"id":"q1","type":"tool_db_query","position":{"x":300,"y":200},"data":{"label":"Fatture scadute 30+gg","query":"SELECT pt.description, pt.amount, pt.due_date, c.contact_name FROM payment_tracker pt LEFT JOIN customers c ON c.id = pt.customer_id WHERE pt.status = ''emessa'' AND pt.due_date < CURRENT_DATE - INTERVAL ''30 days''"}},{"id":"l1","type":"logic_loop","position":{"x":500,"y":200},"data":{"label":"Per ognuna","array_field":"rows"}},{"id":"a1","type":"llm_chat","position":{"x":700,"y":200},"data":{"label":"Genera sollecito","prompt":"Email sollecito pagamento gentile a {{contact_name}} per {{description}} di €{{amount}}. Firma: Federico.","provider":"auto"}},{"id":"n1","type":"tool_send_telegram","position":{"x":950,"y":200},"data":{"label":"Notifica","message":"💰 Sollecito: {{contact_name}} — €{{amount}}\n\n{{text}}"}}]',
  '[{"id":"e1","source":"t1","target":"q1"},{"id":"e2","source":"q1","target":"l1"},{"id":"e3","source":"l1","target":"a1"},{"id":"e4","source":"a1","target":"n1"}]'
);

-- 13. Riepilogo Mensile
INSERT INTO workflows (name, description, status, trigger_type, trigger_config, nodes, edges) VALUES (
  'Riepilogo Mensile',
  'Fine mese: stats revenue, lead, preventivi → report AI + salva in memoria.',
  'draft', 'cron', '{"interval_hours":720,"time":"18:00"}',
  '[{"id":"t1","type":"trigger_cron","position":{"x":50,"y":200},"data":{"label":"Mensile"}},{"id":"q1","type":"tool_db_query","position":{"x":250,"y":100},"data":{"label":"Revenue","query":"SELECT COALESCE(SUM(amount),0) as revenue FROM payment_tracker WHERE status=''pagata'' AND DATE_TRUNC(''month'',paid_date)=DATE_TRUNC(''month'',CURRENT_DATE)"}},{"id":"q2","type":"tool_db_query","position":{"x":250,"y":200},"data":{"label":"Lead","query":"SELECT COUNT(*) as count FROM leads WHERE DATE_TRUNC(''month'',created_at)=DATE_TRUNC(''month'',CURRENT_DATE)"}},{"id":"q3","type":"tool_db_query","position":{"x":250,"y":300},"data":{"label":"Preventivi","query":"SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total FROM quotes_v2 WHERE status=''signed'' AND DATE_TRUNC(''month'',signed_at)=DATE_TRUNC(''month'',CURRENT_DATE)"}},{"id":"s1","type":"llm_summarize","position":{"x":550,"y":200},"data":{"label":"Report","max_length":400,"style":"report mensile con emoji"}},{"id":"n1","type":"tool_send_telegram","position":{"x":800,"y":150},"data":{"label":"Telegram","message":"📊 Report Mensile\n\n{{summary}}"}},{"id":"b1","type":"output_brain_fact","position":{"x":800,"y":300},"data":{"label":"Memoria","entity_type":"general","fact":"Report mensile: {{summary}}"}}]',
  '[{"id":"e1","source":"t1","target":"q1"},{"id":"e2","source":"t1","target":"q2"},{"id":"e3","source":"t1","target":"q3"},{"id":"e4","source":"q1","target":"s1"},{"id":"e5","source":"q2","target":"s1"},{"id":"e6","source":"q3","target":"s1"},{"id":"e7","source":"s1","target":"n1"},{"id":"e8","source":"s1","target":"b1"}]'
);
