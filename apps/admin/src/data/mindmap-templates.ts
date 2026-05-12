import type { Node, Edge } from '@xyflow/react';

export interface MindMapTemplate {
  id: string;
  title: string;
  description: string;
  icon: string;
  nodes: Node[];
  edges: Edge[];
}

const edge = (source: string, target: string): Edge => ({
  id: `e_${source}_${target}`, source, target,
  type: 'smoothstep', animated: true,
  style: { stroke: 'hsl(var(--primary))', strokeWidth: 2 },
});

export const MINDMAP_TEMPLATES: MindMapTemplate[] = [
  {
    id: 'swot',
    title: 'Analisi SWOT',
    description: 'Strengths, Weaknesses, Opportunities, Threats',
    icon: '📊',
    nodes: [
      { id: 'c', type: 'mindmapNode', position: { x: 350, y: 250 }, data: { label: 'Analisi SWOT', depth: 0 } },
      { id: 's', type: 'mindmapNode', position: { x: 100, y: 100 }, data: { label: 'Punti di Forza', depth: 1 } },
      { id: 'w', type: 'mindmapNode', position: { x: 600, y: 100 }, data: { label: 'Punti Deboli', depth: 1 } },
      { id: 'o', type: 'mindmapNode', position: { x: 100, y: 400 }, data: { label: 'Opportunità', depth: 1 } },
      { id: 't', type: 'mindmapNode', position: { x: 600, y: 400 }, data: { label: 'Minacce', depth: 1 } },
    ],
    edges: [edge('c', 's'), edge('c', 'w'), edge('c', 'o'), edge('c', 't')],
  },
  {
    id: 'project-plan',
    title: 'Piano Progetto',
    description: 'Struttura progetto con fasi e task',
    icon: '📋',
    nodes: [
      { id: 'c', type: 'mindmapNode', position: { x: 100, y: 250 }, data: { label: 'Progetto', depth: 0 } },
      { id: 'p1', type: 'mindmapNode', position: { x: 350, y: 80 }, data: { label: 'Fase 1: Discovery', depth: 1 } },
      { id: 'p2', type: 'mindmapNode', position: { x: 350, y: 200 }, data: { label: 'Fase 2: Design', depth: 1 } },
      { id: 'p3', type: 'mindmapNode', position: { x: 350, y: 320 }, data: { label: 'Fase 3: Sviluppo', depth: 1 } },
      { id: 'p4', type: 'mindmapNode', position: { x: 350, y: 440 }, data: { label: 'Fase 4: Testing', depth: 1 } },
      { id: 't1', type: 'mindmapNode', position: { x: 600, y: 50 }, data: { label: 'Ricerca utenti', depth: 2 } },
      { id: 't2', type: 'mindmapNode', position: { x: 600, y: 110 }, data: { label: 'Analisi competitor', depth: 2 } },
      { id: 't3', type: 'mindmapNode', position: { x: 600, y: 170 }, data: { label: 'Wireframe', depth: 2 } },
      { id: 't4', type: 'mindmapNode', position: { x: 600, y: 230 }, data: { label: 'UI Design', depth: 2 } },
    ],
    edges: [edge('c', 'p1'), edge('c', 'p2'), edge('c', 'p3'), edge('c', 'p4'), edge('p1', 't1'), edge('p1', 't2'), edge('p2', 't3'), edge('p2', 't4')],
  },
  {
    id: 'feature-brainstorm',
    title: 'Feature Brainstorm',
    description: 'Brainstorming funzionalità prodotto',
    icon: '💡',
    nodes: [
      { id: 'c', type: 'mindmapNode', position: { x: 350, y: 250 }, data: { label: 'Prodotto', depth: 0 } },
      { id: 'ux', type: 'mindmapNode', position: { x: 100, y: 100 }, data: { label: 'UX / UI', depth: 1 } },
      { id: 'feat', type: 'mindmapNode', position: { x: 600, y: 100 }, data: { label: 'Feature Core', depth: 1 } },
      { id: 'int', type: 'mindmapNode', position: { x: 100, y: 400 }, data: { label: 'Integrazioni', depth: 1 } },
      { id: 'perf', type: 'mindmapNode', position: { x: 600, y: 400 }, data: { label: 'Performance', depth: 1 } },
    ],
    edges: [edge('c', 'ux'), edge('c', 'feat'), edge('c', 'int'), edge('c', 'perf')],
  },
  {
    id: 'client-discovery',
    title: 'Client Discovery',
    description: 'Scoperta bisogni cliente',
    icon: '🔍',
    nodes: [
      { id: 'c', type: 'mindmapNode', position: { x: 350, y: 250 }, data: { label: 'Cliente', depth: 0 } },
      { id: 'b', type: 'mindmapNode', position: { x: 100, y: 100 }, data: { label: 'Business', depth: 1 } },
      { id: 'g', type: 'mindmapNode', position: { x: 600, y: 100 }, data: { label: 'Goal', depth: 1 } },
      { id: 'p', type: 'mindmapNode', position: { x: 100, y: 400 }, data: { label: 'Pain Points', depth: 1 } },
      { id: 'bud', type: 'mindmapNode', position: { x: 600, y: 400 }, data: { label: 'Budget & Timeline', depth: 1 } },
    ],
    edges: [edge('c', 'b'), edge('c', 'g'), edge('c', 'p'), edge('c', 'bud')],
  },
];
