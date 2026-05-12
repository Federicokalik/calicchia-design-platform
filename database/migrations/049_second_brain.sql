-- 049: Second Brain — Memoria persistente per l'agente AI

CREATE TABLE IF NOT EXISTS brain_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  context TEXT,
  messages JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS brain_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  fact TEXT NOT NULL,
  source TEXT,
  source_id TEXT,
  confidence FLOAT DEFAULT 1.0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  rule TEXT NOT NULL,
  priority INT DEFAULT 5,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brain_facts_entity ON brain_facts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_brain_facts_search ON brain_facts USING gin(to_tsvector('italian', fact));
CREATE INDEX IF NOT EXISTS idx_brain_conversations_tags ON brain_conversations USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_brain_conversations_created ON brain_conversations(created_at DESC);
