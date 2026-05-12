import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  type Connection, type Edge, type Node, BackgroundVariant,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Plus, Trash2, Loader2, ArrowRight, ArrowDown, Circle, Sparkles, BrainCircuit } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTopbar } from '@/hooks/use-topbar';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import { LinkEntityPicker } from '@/components/shared/link-entity-picker';
import { layoutNodes, type LayoutDirection } from '@/lib/elk-layout';
import MindMapNode from '@/components/boards/mindmap-node';
import type { Board } from '@/types/notes';

const nodeTypes = { mindmapNode: MindMapNode };

let nodeIdCounter = 100;

function MindMapEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInitialized = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: ['board', id],
    queryFn: () => apiFetch(`/api/boards/${id}`),
    enabled: !!id,
  });

  const board: Board | undefined = data?.board;
  const boardData = board ? (typeof board.data === 'string' ? JSON.parse(board.data as string) : board.data) : null;

  const initialNodes: Node[] = boardData?.nodes || [
    { id: '1', type: 'mindmapNode', position: { x: 300, y: 250 }, data: { label: 'Idea centrale' } },
  ];
  const initialEdges: Edge[] = boardData?.edges || [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    if (board?.title && !titleInitialized.current) {
      setTitle(board.title);
      titleInitialized.current = true;
    }
  }, [board?.title]);

  const saveMutation = useMutation({
    mutationFn: (updates: Partial<Board>) =>
      apiFetch(`/api/boards/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
    onSuccess: () => { setSaving(false); queryClient.invalidateQueries({ queryKey: ['boards'] }); },
    onError: () => { setSaving(false); toast.error('Errore salvataggio'); },
  });

  const scheduleAutosave = useCallback((currentNodes: Node[], currentEdges: Edge[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setSaving(true);
      saveMutation.mutate({ data: { nodes: currentNodes, edges: currentEdges } } as any);
    }, 1500);
  }, [saveMutation]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) => {
      const newEdges = addEdge({
        ...connection,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'hsl(var(--primary))', strokeWidth: 2 },
      }, eds);
      scheduleAutosave(nodes, newEdges);
      return newEdges;
    });
  }, [setEdges, nodes, scheduleAutosave]);

  const handleNodesChange = useCallback((changes: any) => {
    onNodesChange(changes);
    // Schedule save after node move/edit
    setTimeout(() => {
      setNodes((currentNodes) => {
        setEdges((currentEdges) => {
          scheduleAutosave(currentNodes, currentEdges);
          return currentEdges;
        });
        return currentNodes;
      });
    }, 0);
  }, [onNodesChange, scheduleAutosave, setNodes, setEdges]);

  const addNodeFrom = useCallback((parentId?: string, asSibling = false) => {
    const newId = `node_${++nodeIdCounter}_${Date.now()}`;

    setNodes((nds) => {
      setEdges((eds) => {
        let connectFrom = parentId;
        let pos = { x: 200 + Math.random() * 300, y: 100 + Math.random() * 300 };

        if (parentId) {
          const parent = nds.find((n) => n.id === parentId);
          if (parent) {
            if (asSibling) {
              // Find parent's parent via edges
              const parentEdge = eds.find((e) => e.target === parentId);
              connectFrom = parentEdge?.source || undefined;
              pos = { x: parent.position.x, y: parent.position.y + 80 };
            } else {
              pos = { x: parent.position.x + 200, y: parent.position.y + (Math.random() - 0.5) * 100 };
            }
          }
        }

        const newEdges = connectFrom
          ? [...eds, { id: `e_${connectFrom}_${newId}`, source: connectFrom, target: newId, type: 'smoothstep', animated: true, style: { stroke: 'hsl(var(--primary))', strokeWidth: 2 } }]
          : eds;

        const newNode: Node = { id: newId, type: 'mindmapNode', position: pos, data: { label: 'Nuovo nodo' }, selected: true };
        const updated = [...nds.map((n) => ({ ...n, selected: false })), newNode];
        scheduleAutosave(updated, newEdges);
        return newEdges;
      });

      const newNode: Node = { id: newId, type: 'mindmapNode', position: { x: 0, y: 0 }, data: { label: 'Nuovo nodo' }, selected: true };
      return [...nds.map((n) => ({ ...n, selected: false })), newNode];
    });
  }, [setNodes, setEdges, scheduleAutosave]);

  const addNode = () => addNodeFrom();

  // Keyboard: Tab = add child, Enter = add sibling
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const selected = nodes.find((n) => n.selected);
      if (!selected) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        addNodeFrom(selected.id, false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        addNodeFrom(selected.id, true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [nodes, addNodeFrom]);

  const deleteSelected = () => {
    setNodes((nds) => {
      const remaining = nds.filter((n) => !n.selected);
      setEdges((eds) => {
        const selectedIds = new Set(nds.filter((n) => n.selected).map((n) => n.id));
        const remainingEdges = eds.filter((e) => !e.selected && !selectedIds.has(e.source) && !selectedIds.has(e.target));
        scheduleAutosave(remaining, remainingEdges);
        return remainingEdges;
      });
      return remaining;
    });
  };

  // Compute depth for color coding
  useEffect(() => {
    const targets = new Set(edges.map((e) => e.target));
    const roots = nodes.filter((n) => !targets.has(n.id));
    if (!roots.length) return;

    const childMap = new Map<string, string[]>();
    edges.forEach((e) => {
      const children = childMap.get(e.source) || [];
      children.push(e.target);
      childMap.set(e.source, children);
    });

    const depths = new Map<string, number>();
    const queue = roots.map((r) => ({ id: r.id, depth: 0 }));
    while (queue.length) {
      const { id: nodeId, depth } = queue.shift()!;
      if (depths.has(nodeId)) continue;
      depths.set(nodeId, depth);
      (childMap.get(nodeId) || []).forEach((childId) => queue.push({ id: childId, depth: depth + 1 }));
    }

    let changed = false;
    const updated = nodes.map((n) => {
      const d = depths.get(n.id) ?? 0;
      if ((n.data as any).depth !== d) {
        changed = true;
        return { ...n, data: { ...n.data, depth: d } };
      }
      return n;
    });
    if (changed) setNodes(updated);
  }, [edges.length, nodes.length]);

  const autoLayout = async (direction: LayoutDirection) => {
    const laid = await layoutNodes(nodes, edges, direction);
    setNodes(laid);
    scheduleAutosave(laid, edges);
    toast.success('Layout applicato');
  };

  const [aiGenerating, setAiGenerating] = useState(false);
  const [showAiInput, setShowAiInput] = useState(false);
  const [aiTopic, setAiTopic] = useState('');

  const aiGenerateMindmap = async () => {
    if (!aiTopic.trim()) return;
    setAiGenerating(true);
    try {
      const res = await apiFetch('/api/ai/knowledge/generate-mindmap', {
        method: 'POST', body: JSON.stringify({ topic: aiTopic }),
      });
      if (res.nodes && res.edges) {
        setNodes(res.nodes);
        setEdges(res.edges);
        scheduleAutosave(res.nodes, res.edges);
        setShowAiInput(false);
        setAiTopic('');
        toast.success('Mappa generata con AI');
      }
    } catch { toast.error('Errore generazione AI'); }
    setAiGenerating(false);
  };

  const aiBrainstorm = async () => {
    const selected = nodes.find((n) => n.selected);
    if (!selected) { toast.error('Seleziona un nodo'); return; }
    setAiGenerating(true);
    try {
      const siblings = edges
        .filter((e) => e.source === selected.id || edges.some((pe) => pe.target === selected.id && pe.source === e.source))
        .map((e) => nodes.find((n) => n.id === e.target)?.data?.label)
        .filter(Boolean) as string[];

      const res = await apiFetch('/api/ai/knowledge/brainstorm', {
        method: 'POST', body: JSON.stringify({ label: (selected.data as any).label, siblings }),
      });

      if (res.ideas?.length) {
        const newNodes: Node[] = [];
        const newEdges: Edge[] = [];
        res.ideas.forEach((idea: string, i: number) => {
          const newId = `ai_${++nodeIdCounter}_${Date.now()}`;
          newNodes.push({
            id: newId, type: 'mindmapNode',
            position: { x: selected.position.x + 200, y: selected.position.y + (i - 2) * 70 },
            data: { label: idea },
          });
          newEdges.push({
            id: `e_${selected.id}_${newId}`, source: selected.id, target: newId,
            type: 'smoothstep', animated: true,
            style: { stroke: 'hsl(var(--primary))', strokeWidth: 2 },
          });
        });
        setNodes((nds) => [...nds, ...newNodes]);
        setEdges((eds) => [...eds, ...newEdges]);
        scheduleAutosave([...nodes, ...newNodes], [...edges, ...newEdges]);
        toast.success(`${res.ideas.length} idee generate`);
      }
    } catch { toast.error('Errore brainstorm AI'); }
    setAiGenerating(false);
  };

  const handleTitleBlur = () => {
    if (board && title !== board.title) {
      saveMutation.mutate({ title } as any);
    }
  };

  useTopbar({ title: 'Mappa concettuale' });

  if (isLoading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!board) return <div className="text-center text-muted-foreground py-12">Board non trovata</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate('/boards/mindmap')}>
          <ArrowLeft className="h-4 w-4 mr-1.5" /> Mappe
        </Button>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Button size="sm" variant="outline" onClick={addNode}>
            <Plus className="h-4 w-4 mr-1" /> Nodo
          </Button>
          <Button size="sm" variant="outline" onClick={deleteSelected}>
            <Trash2 className="h-4 w-4 mr-1" /> Elimina
          </Button>
          <div className="w-px h-6 bg-border mx-1" />
          <Button size="sm" variant="outline" onClick={() => autoLayout('RIGHT')} title="Layout orizzontale">
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => autoLayout('DOWN')} title="Layout verticale">
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => autoLayout('radial')} title="Layout radiale">
            <Circle className="h-3.5 w-3.5" />
          </Button>
          <div className="w-px h-6 bg-border mx-1" />
          <Button size="sm" variant="outline" onClick={() => setShowAiInput(!showAiInput)} disabled={aiGenerating}>
            <Sparkles className="h-3.5 w-3.5 mr-1" /> AI Genera
          </Button>
          <Button size="sm" variant="outline" onClick={aiBrainstorm} disabled={aiGenerating} title="Genera idee dal nodo selezionato">
            {aiGenerating ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <BrainCircuit className="h-3.5 w-3.5 mr-1" />}
            Brainstorm
          </Button>
        </div>
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleBlur}
        placeholder="Nome mappa"
        className="w-full text-xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/40"
      />

      <LinkEntityPicker
        linkedType={board.linked_type}
        linkedId={board.linked_id}
        onChange={(type, id) => {
          saveMutation.mutate({ linked_type: type, linked_id: id } as any);
        }}
      />

      {showAiInput && (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-3">
          <Sparkles className="h-4 w-4 text-primary shrink-0" />
          <Input
            value={aiTopic}
            onChange={(e) => setAiTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') aiGenerateMindmap(); }}
            placeholder="Descrivi il topic per generare la mappa..."
            className="h-8 text-sm"
            autoFocus
          />
          <Button size="sm" onClick={aiGenerateMindmap} disabled={aiGenerating || !aiTopic.trim()}>
            {aiGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Genera'}
          </Button>
        </div>
      )}

      <div className="rounded-xl border overflow-hidden bg-card h-[calc(100vh-14rem)]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
          defaultEdgeOptions={{
            type: 'smoothstep',
            animated: true,
            style: { stroke: 'hsl(var(--primary))', strokeWidth: 2 },
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--muted-foreground) / 0.15)" />
          <Controls className="!bg-card !border-border !rounded-lg !shadow-lg" />
          <MiniMap
            className="!bg-card !border-border !rounded-lg"
            maskColor="hsl(var(--background) / 0.7)"
            nodeColor="hsl(var(--primary) / 0.3)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function MindMapEditorPage() {
  return (
    <ReactFlowProvider>
      <MindMapEditor />
    </ReactFlowProvider>
  );
}
