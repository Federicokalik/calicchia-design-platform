import { Hono } from 'hono';
import { sql } from '../db';
import { generateText } from '../lib/agent/llm-router';

export const aiKnowledge = new Hono();

// POST /api/ai/knowledge/summarize — Summarize a note
aiKnowledge.post('/summarize', async (c) => {
  const { content, title } = await c.req.json();
  if (!content) return c.json({ error: 'Contenuto richiesto' }, 400);

  const summary = await generateText('chat', [
    { role: 'system', content: 'Sei un assistente che riassume note in modo conciso. Rispondi in italiano. Max 3-4 frasi.' },
    { role: 'user', content: `Riassumi questa nota intitolata "${title || 'Senza titolo'}":\n\n${content.slice(0, 3000)}` },
  ], { temperature: 0.3, max_tokens: 500 });

  return c.json({ summary });
});

// POST /api/ai/knowledge/rewrite — Rewrite/expand/simplify selected text
aiKnowledge.post('/rewrite', async (c) => {
  const { text, action } = await c.req.json();
  if (!text) return c.json({ error: 'Testo richiesto' }, 400);

  const prompts: Record<string, string> = {
    expand: 'Espandi e approfondisci il seguente testo, mantenendo lo stesso tono. Aggiungi dettagli utili.',
    simplify: 'Riscrivi il seguente testo in modo più semplice e chiaro, mantenendo il significato.',
    rewrite: 'Riscrivi il seguente testo migliorando stile e chiarezza.',
    translate_en: 'Traduci il seguente testo in inglese professionale.',
    professional: 'Riscrivi il seguente testo con un tono più professionale e formale.',
  };

  const result = await generateText('chat', [
    { role: 'system', content: `${prompts[action] || prompts.rewrite} Rispondi SOLO con il testo riscritto, nessuna premessa.` },
    { role: 'user', content: text.slice(0, 2000) },
  ], { temperature: 0.5, max_tokens: 1500 });

  return c.json({ result });
});

// POST /api/ai/knowledge/generate-mindmap — Generate mind map nodes from text
aiKnowledge.post('/generate-mindmap', async (c) => {
  const { topic, text } = await c.req.json();
  if (!topic && !text) return c.json({ error: 'Topic o testo richiesto' }, 400);

  const input = text ? `Analizza questo testo e crea una mappa concettuale:\n\n${text.slice(0, 2000)}` :
    `Crea una mappa concettuale per il topic: "${topic}"`;

  const result = await generateText('chat', [
    { role: 'system', content: `Genera una mappa concettuale come JSON. Rispondi SOLO con JSON valido, nessun testo.
Formato: {"central": "Idea centrale", "branches": [{"label": "Ramo 1", "children": ["Sotto-ramo 1.1", "Sotto-ramo 1.2"]}, ...]}
- Max 5-7 rami principali
- Max 3-4 sotto-rami per ramo
- Etichette brevi (2-5 parole)` },
    { role: 'user', content: input },
  ], { temperature: 0.6, max_tokens: 1500 });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const mindmap = JSON.parse(jsonMatch[0]);

    // Convert to React Flow nodes/edges
    const nodes: any[] = [];
    const edges: any[] = [];
    let nodeId = 1;

    // Central node
    const centralId = `n${nodeId++}`;
    nodes.push({ id: centralId, type: 'mindmapNode', position: { x: 400, y: 300 }, data: { label: mindmap.central, depth: 0 } });

    // Branches
    (mindmap.branches || []).forEach((branch: any, bi: number) => {
      const branchId = `n${nodeId++}`;
      const angle = (bi / (mindmap.branches?.length || 1)) * Math.PI * 2 - Math.PI / 2;
      nodes.push({
        id: branchId, type: 'mindmapNode',
        position: { x: 400 + Math.cos(angle) * 250, y: 300 + Math.sin(angle) * 200 },
        data: { label: branch.label, depth: 1 },
      });
      edges.push({ id: `e${centralId}_${branchId}`, source: centralId, target: branchId, type: 'smoothstep', animated: true });

      // Children
      (branch.children || []).forEach((child: string, ci: number) => {
        const childId = `n${nodeId++}`;
        const childAngle = angle + ((ci - (branch.children.length - 1) / 2) * 0.3);
        nodes.push({
          id: childId, type: 'mindmapNode',
          position: { x: 400 + Math.cos(childAngle) * 450, y: 300 + Math.sin(childAngle) * 350 },
          data: { label: child, depth: 2 },
        });
        edges.push({ id: `e${branchId}_${childId}`, source: branchId, target: childId, type: 'smoothstep', animated: true });
      });
    });

    return c.json({ nodes, edges, raw: mindmap });
  } catch (err) {
    return c.json({ error: 'Errore parsing risposta AI', raw: result }, 500);
  }
});

// POST /api/ai/knowledge/brainstorm — Generate child ideas for a node
aiKnowledge.post('/brainstorm', async (c) => {
  const { label, siblings, context } = await c.req.json();
  if (!label) return c.json({ error: 'Label richiesta' }, 400);

  const siblingsList = (siblings || []).length > 0 ? `\nNodi fratelli esistenti: ${siblings.join(', ')}` : '';

  const result = await generateText('chat', [
    { role: 'system', content: `Genera 4-5 idee figlie per un nodo di mappa concettuale. Rispondi SOLO con un JSON array di stringhe. Ogni idea: 2-5 parole.${siblingsList ? ' Non ripetere i nodi fratelli.' : ''}` },
    { role: 'user', content: `Nodo padre: "${label}"${siblingsList}${context ? `\nContesto: ${context}` : ''}` },
  ], { temperature: 0.7, max_tokens: 300 });

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');
    const ideas: string[] = JSON.parse(jsonMatch[0]);
    return c.json({ ideas });
  } catch {
    return c.json({ ideas: ['Idea 1', 'Idea 2', 'Idea 3'] });
  }
});
