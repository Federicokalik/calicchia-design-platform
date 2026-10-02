-- Pulizia dei "\n" letterali (backslash + n) nei testi CMS del sito.
--
-- Le hint dell'admin (FAQ, curiosità, servizi) suggerivano di scrivere `\n`
-- per andare a capo: il sito però renderizza il testo così com'è, quindi il
-- visitatore vedeva i due caratteri. Le hint ora dicono di premere Invio;
-- qui convertiamo gli eventuali `\n` già salvati in veri a capo.
--
-- Con standard_conforming_strings = on (default Postgres) '\n' è la stringa
-- di due caratteri backslash + n, E'\n' è il carattere newline.
-- Idempotente: tocca solo le righe che contengono ancora la sequenza.
-- Blog e progetti esclusi di proposito: possono contenere codice.

UPDATE public.site_faqs
SET question = replace(question, '\n', E'\n'),
    answer   = replace(answer, '\n', E'\n')
WHERE strpos(question, '\n') > 0 OR strpos(answer, '\n') > 0;

UPDATE public.site_curiosita
SET label = replace(label, '\n', E'\n'),
    body  = replace(body, '\n', E'\n')
WHERE strpos(label, '\n') > 0 OR strpos(body, '\n') > 0;

UPDATE public.site_approach
SET title       = replace(title, '\n', E'\n'),
    description = replace(description, '\n', E'\n')
WHERE strpos(title, '\n') > 0 OR strpos(description, '\n') > 0;

UPDATE public.site_team
SET role = replace(role, '\n', E'\n'),
    bio  = replace(bio, '\n', E'\n')
WHERE strpos(role, '\n') > 0 OR strpos(coalesce(bio, ''), '\n') > 0;

UPDATE public.site_glossario
SET what_it_is     = replace(what_it_is, '\n', E'\n'),
    why_you_care   = replace(why_you_care, '\n', E'\n'),
    what_to_demand = replace(what_to_demand, '\n', E'\n'),
    what_for       = replace(what_for, '\n', E'\n'),
    when_yes       = replace(when_yes, '\n', E'\n'),
    when_no        = replace(when_no, '\n', E'\n'),
    what_to_ask    = replace(what_to_ask, '\n', E'\n')
WHERE strpos(
  concat_ws(' ', what_it_is, why_you_care, what_to_demand, what_for, when_yes, when_no, what_to_ask),
  '\n'
) > 0;

-- site_services: `lead` è TEXT, `deliverables` è un array JSONB di stringhe.
-- Nel testo JSON un backslash digitato è serializzato come `\\`, quindi la
-- sequenza letterale è `\\n` (tre caratteri) e va ridotta all'escape JSON
-- del newline `\n` prima del cast di ritorno a jsonb.
UPDATE public.site_services
SET lead = replace(lead, '\n', E'\n')
WHERE strpos(lead, '\n') > 0;

UPDATE public.site_services
SET deliverables = replace(deliverables::text, '\\n', '\n')::jsonb
WHERE strpos(deliverables::text, '\\n') > 0;
