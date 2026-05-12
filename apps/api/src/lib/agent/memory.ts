/**
 * Second Brain — Memory Manager
 * 3 levels: episodic (conversations), semantic (facts), procedural (preferences)
 */

import { sql } from '../../db';
import { generateText } from './llm-router';

// === EPISODIC: Conversations ===

export async function saveConversation(
  channel: string,
  messages: Array<{ role: string; content: string }>,
  context?: string
): Promise<string> {
  // Generate summary + extract facts via LLM
  const convoText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  let summary = '';
  let tags: string[] = [];
  let extractedFacts: string[] = [];

  try {
    const result = await generateText('chat', [
      { role: 'system', content: 'Analizza questa conversazione ed estrai: 1) Un riassunto in 1 frase 2) Tag (nomi persone, aziende, progetti menzionati) 3) Fatti importanti da ricordare. Rispondi SOLO in JSON: {"summary":"...","tags":["..."],"facts":["..."]}' },
      { role: 'user', content: convoText },
    ], { temperature: 0.3, max_tokens: 500 });

    try {
      const parsed = JSON.parse(result);
      summary = parsed.summary || '';
      tags = parsed.tags || [];
      extractedFacts = parsed.facts || [];
    } catch { summary = result.slice(0, 200); }
  } catch { summary = `Conversazione ${channel}: ${messages.length} messaggi`; }

  // Save conversation
  const rows = await sql`
    INSERT INTO brain_conversations (channel, context, messages, summary, tags, ended_at)
    VALUES (${channel}, ${context || null}, ${JSON.stringify(messages)}, ${summary}, ${tags}, now())
    RETURNING id
  `;
  const convoId = rows[0].id;

  // Save extracted facts
  for (const fact of extractedFacts) {
    if (fact.trim()) {
      await sql`
        INSERT INTO brain_facts (entity_type, fact, source, source_id)
        VALUES ('general', ${fact.trim()}, 'conversation', ${convoId})
      `;
    }
  }

  return convoId;
}

// === SEMANTIC: Facts ===

export async function addFact(
  entityType: string,
  entityId: string | null,
  fact: string,
  source = 'manual'
): Promise<void> {
  // Check if similar fact exists to avoid duplicates
  const existing = entityId
    ? await sql`SELECT id FROM brain_facts WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND fact ILIKE ${'%' + fact.slice(0, 50) + '%'} LIMIT 1`
    : await sql`SELECT id FROM brain_facts WHERE entity_type = ${entityType} AND entity_id IS NULL AND fact ILIKE ${'%' + fact.slice(0, 50) + '%'} LIMIT 1`;

  if (existing.length) {
    await sql`UPDATE brain_facts SET fact = ${fact}, updated_at = now() WHERE id = ${existing[0].id}`;
  } else {
    await sql`
      INSERT INTO brain_facts (entity_type, entity_id, fact, source)
      VALUES (${entityType}, ${entityId}, ${fact}, ${source})
    `;
  }
}

export async function searchFacts(query: string, limit = 10): Promise<any[]> {
  // Full-text search + recency
  const rows = await sql`
    SELECT *, ts_rank(to_tsvector('italian', fact), plainto_tsquery('italian', ${query})) AS rank
    FROM brain_facts
    WHERE (expires_at IS NULL OR expires_at > now())
      AND (to_tsvector('italian', fact) @@ plainto_tsquery('italian', ${query})
           OR fact ILIKE ${'%' + query + '%'})
    ORDER BY rank DESC, updated_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function getFactsForEntity(entityType: string, entityId: string, limit = 10): Promise<any[]> {
  return sql`
    SELECT * FROM brain_facts
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY updated_at DESC LIMIT ${limit}
  `;
}

// === PROCEDURAL: Preferences ===

export async function getActivePreferences(): Promise<any[]> {
  return sql`SELECT * FROM brain_preferences WHERE active = true ORDER BY priority DESC`;
}

export async function addPreference(category: string, rule: string, priority = 5): Promise<void> {
  await sql`INSERT INTO brain_preferences (category, rule, priority) VALUES (${category}, ${rule}, ${priority})`;
}

// === RECALL: Combined memory for agent prompt ===

export async function recallMemory(context?: string, query?: string): Promise<{
  preferences: string[];
  facts: string[];
  recentConversations: string[];
}> {
  // 1. All active preferences
  const prefs = await getActivePreferences();
  const preferences = prefs.map((p) => `[${p.category}] ${p.rule}`);

  // 2. Relevant facts (by context or query)
  let facts: string[] = [];
  if (query) {
    const found = await searchFacts(query, 8);
    facts = found.map((f) => `[${f.entity_type}${f.entity_id ? ':' + f.entity_id : ''}] ${f.fact}`);
  }

  // Also get recent general facts
  const recentFacts = await sql`
    SELECT * FROM brain_facts
    WHERE (expires_at IS NULL OR expires_at > now())
    ORDER BY updated_at DESC LIMIT 5
  `;
  for (const f of recentFacts) {
    const line = `[${f.entity_type}${f.entity_id ? ':' + f.entity_id : ''}] ${f.fact}`;
    if (!facts.includes(line)) facts.push(line);
  }

  // 3. Recent relevant conversations
  let conversations: any[];
  if (context) {
    conversations = await sql`
      SELECT summary, tags, created_at FROM brain_conversations
      WHERE context = ${context} AND summary IS NOT NULL
      ORDER BY created_at DESC LIMIT 3
    `;
  } else {
    conversations = await sql`
      SELECT summary, tags, created_at FROM brain_conversations
      WHERE summary IS NOT NULL
      ORDER BY created_at DESC LIMIT 3
    `;
  }
  const recentConversations = conversations.map((c) => {
    const date = new Date(c.created_at).toLocaleDateString('it-IT');
    return `[${date}] ${c.summary}`;
  });

  return { preferences, facts: facts.slice(0, 12), recentConversations };
}
