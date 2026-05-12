import { useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  type Connection,
  type NodeTypes,
  type Node,
  type Edge as FlowEdge,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTopbar } from '@/hooks/use-topbar';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

// Custom nodes
import { TriggerNode } from '@/components/workflow/nodes/trigger-node';
import { LlmNode } from '@/components/workflow/nodes/llm-node';
import { ToolNode } from '@/components/workflow/nodes/tool-node';
import { LogicNode } from '@/components/workflow/nodes/logic-node';
import { OutputNode } from '@/components/workflow/nodes/output-node';

// Panels
import { NodePalette } from '@/components/workflow/node-palette';
import { NodeInspector } from '@/components/workflow/node-inspector';
import { ExecutionPanel } from '@/components/workflow/execution-panel';

const nodeTypes: NodeTypes = {
  trigger_cron: TriggerNode,
  trigger_event: TriggerNode,
  trigger_manual: TriggerNode,
  trigger_webhook: TriggerNode,
  trigger_telegram: TriggerNode,
  llm_chat: LlmNode,
  llm_summarize: LlmNode,
  llm_classify: LlmNode,
  tool_db_query: ToolNode,
  tool_send_email: ToolNode,
  tool_send_whatsapp: ToolNode,
  tool_send_telegram: ToolNode,
  tool_http_request: ToolNode,
  logic_condition: LogicNode,
  logic_delay: LogicNode,
  logic_loop: LogicNode,
  output_log: OutputNode,
  output_brain_fact: OutputNode,
};

let nodeIdCounter = 0;

function WorkflowEditorInner() {
  const { t, formatStatus } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [name, setName] = useState('');
  const [executionSteps, setExecutionSteps] = useState<any[]>([]);
  const [executionStatus, setExecutionStatus] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Fetch workflow
  const { data } = useQuery({
    queryKey: ['workflow-detail', id],
    queryFn: () => apiFetch(`/api/workflows/${id}`),
    enabled: !!id,
  });

  // Load data into React Flow
  if (data?.workflow && !loaded) {
    const wf = data.workflow;
    setName(wf.name || '');
    // Parse nodes/edges — could be JSON string or array
    const rawNodes = typeof wf.nodes === 'string' ? JSON.parse(wf.nodes || '[]') : (wf.nodes || []);
    const rawEdges = typeof wf.edges === 'string' ? JSON.parse(wf.edges || '[]') : (wf.edges || []);
    // Ensure every node has a valid position
    const validNodes = rawNodes.filter((n: any) => n.position?.x !== undefined && n.position?.y !== undefined);
    setNodes(validNodes);
    setEdges(rawEdges);
    setLoaded(true);
  }

  // Save
  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, nodes, edges }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflow.saved'));
    },
    onError: () => toast.error(t('workflow.saveError')),
  });

  // Execute
  const executeMutation = useMutation({
    mutationFn: async () => {
      // Save first
      await apiFetch(`/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify({ name, nodes, edges }) });
      return apiFetch(`/api/workflows/${id}/execute`, { method: 'POST', body: '{}' });
    },
    onSuccess: (res: any) => {
      toast.success(t('workflow.execution', { status: formatStatus('workflow', res.status) }));
      // Start polling for steps
      if (res.executionId) pollExecution(res.executionId);
    },
    onError: () => toast.error(t('workflow.executionError')),
  });

  // Poll execution steps
  const pollExecution = useCallback(async (eid: string) => {
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/workflows/${id}/executions/${eid}/live`);
        setExecutionSteps(res.steps || []);
        setExecutionStatus(res.execution_status);
        if (res.execution_status === 'running') {
          setTimeout(poll, 1000);
        }
      } catch {}
    };
    poll();
  }, [id]);

  // Connect nodes
  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({ ...params, animated: true }, eds));
  }, [setEdges]);

  // Drop new node from palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/reactflow');
    if (!type || !reactFlowInstance) return;

    const position = reactFlowInstance.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });

    const newNode: Node = {
      id: `node_${++nodeIdCounter}_${Date.now()}`,
      type,
      position,
      data: { label: type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) },
    };

    setNodes((nds) => [...nds, newNode]);
  }, [reactFlowInstance, setNodes]);

  // Select node
  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Update node data from inspector
  const onNodeDataChange = useCallback((nodeId: string, newData: any) => {
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...newData } } : n))
    );
    if (selectedNode?.id === nodeId) {
      setSelectedNode((prev) => prev ? { ...prev, data: { ...prev.data, ...newData } } : null);
    }
  }, [setNodes, selectedNode]);

  const topbarActions = useMemo(() => (
    <>
      <Button variant="outline" size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
        <Save className="h-3.5 w-3.5 mr-1.5" /> {t('common.save')}
      </Button>
      <Button size="sm" onClick={() => executeMutation.mutate()} disabled={executeMutation.isPending}>
        <Play className="h-3.5 w-3.5 mr-1.5" /> {t('common.run')}
      </Button>
    </>
  ), [executeMutation.isPending, saveMutation.isPending, t]);

  useTopbar({
    title: name || t('workflow.editorTitle'),
    subtitle: t('workflow.connections', { nodes: nodes.length, edges: edges.length }),
    actions: topbarActions,
  });

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 7rem)' }}>
      {/* Top: name input */}
      <div className="flex items-center gap-3 mb-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/workflows')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-xs h-8 text-sm font-medium"
          placeholder={t('workflow.namePlaceholder')}
        />
      </div>

      {/* Main: palette + canvas + inspector */}
      <div className="flex flex-1 gap-0 rounded-xl border bg-card overflow-hidden">
        {/* Left: Node Palette */}
        <NodePalette />

        {/* Center: React Flow Canvas */}
        <div ref={reactFlowWrapper} className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode="Delete"
            defaultEdgeOptions={{ animated: true, style: { stroke: 'hsl(var(--primary))', strokeWidth: 2 } }}
            style={{ background: 'hsl(var(--muted) / 0.3)' }}
          >
            <Controls
              style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
            />
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border) / 0.5)" />
          </ReactFlow>
        </div>

        {/* Right: Inspector */}
        <NodeInspector node={selectedNode} onChange={onNodeDataChange} />
      </div>

      {/* Bottom: Execution panel */}
      {executionSteps.length > 0 && (
        <div className="mt-3">
          <ExecutionPanel steps={executionSteps} executionStatus={executionStatus} />
        </div>
      )}
    </div>
  );
}

export default function WorkflowEditorPage() {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner />
    </ReactFlowProvider>
  );
}
