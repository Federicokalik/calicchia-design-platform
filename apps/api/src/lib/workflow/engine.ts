/**
 * Workflow Execution Engine
 * Executes a workflow graph: trigger → nodes → edges → output
 */

import { sql } from '../../db';
import { NODE_TYPES } from './nodes';

interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, any>;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface ExecutionContext {
  executionId: string;
  workflowId: string;
  variables: Record<string, any>;
}

export async function executeWorkflow(
  workflowId: string,
  triggerData: any = {}
): Promise<{ executionId: string; status: string; result: any }> {
  // Load workflow
  const [workflow] = await sql`SELECT * FROM workflows WHERE id = ${workflowId}`;
  if (!workflow) throw new Error('Workflow non trovato');

  const rawNodes = typeof workflow.nodes === 'string' ? JSON.parse(workflow.nodes || '[]') : (workflow.nodes || []);
  const rawEdges = typeof workflow.edges === 'string' ? JSON.parse(workflow.edges || '[]') : (workflow.edges || []);
  const nodes: WorkflowNode[] = rawNodes;
  const edges: WorkflowEdge[] = rawEdges;

  // Create execution record
  const [execution] = await sql`
    INSERT INTO workflow_executions (workflow_id, trigger_data)
    VALUES (${workflowId}, ${JSON.stringify(triggerData)})
    RETURNING id
  `;
  const executionId = execution.id;

  const context: ExecutionContext = {
    executionId,
    workflowId,
    variables: { ...(workflow.variables || {}), ...triggerData },
  };

  try {
    // Find trigger node (entry point)
    const triggerNode = nodes.find((n) => n.type.startsWith('trigger_'));
    if (!triggerNode) throw new Error('Nessun nodo trigger trovato');

    // Execute starting from trigger
    const result = await executeFromNode(triggerNode, nodes, edges, triggerData, context);

    // Mark execution complete
    const duration = Date.now() - new Date(execution.started_at || Date.now()).getTime();
    await sql`
      UPDATE workflow_executions SET
        status = 'completed', result = ${JSON.stringify(result)},
        completed_at = now(), duration_ms = ${duration}
      WHERE id = ${executionId}
    `;

    // Update workflow stats
    await sql`
      UPDATE workflows SET
        execution_count = execution_count + 1,
        last_executed_at = now(), last_error = NULL, updated_at = now()
      WHERE id = ${workflowId}
    `;

    return { executionId, status: 'completed', result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Errore sconosciuto';
    await sql`
      UPDATE workflow_executions SET
        status = 'failed', error = ${errorMsg}, completed_at = now()
      WHERE id = ${executionId}
    `;
    await sql`
      UPDATE workflows SET last_error = ${errorMsg}, updated_at = now()
      WHERE id = ${workflowId}
    `;
    return { executionId, status: 'failed', result: { error: errorMsg } };
  }
}

async function executeFromNode(
  node: WorkflowNode,
  allNodes: WorkflowNode[],
  allEdges: WorkflowEdge[],
  input: any,
  context: ExecutionContext
): Promise<any> {
  // Log step start
  const startTime = Date.now();
  await sql`
    INSERT INTO workflow_step_logs (execution_id, node_id, node_type, status, input)
    VALUES (${context.executionId}, ${node.id}, ${node.type}, 'running', ${JSON.stringify(input)})
  `;

  // Execute node
  const nodeDef = NODE_TYPES[node.type];
  if (!nodeDef) {
    await logStepError(context.executionId, node, startTime, `Tipo nodo sconosciuto: ${node.type}`);
    throw new Error(`Tipo nodo sconosciuto: ${node.type}`);
  }

  let output: any;
  try {
    output = await nodeDef.execute(node.data || {}, input);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Errore esecuzione nodo';
    await logStepError(context.executionId, node, startTime, errorMsg);
    throw err;
  }

  // Log step complete
  const duration = Date.now() - startTime;
  await sql`
    UPDATE workflow_step_logs SET
      status = 'completed', output = ${JSON.stringify(output)},
      duration_ms = ${duration}, completed_at = now()
    WHERE execution_id = ${context.executionId} AND node_id = ${node.id} AND status = 'running'
  `;

  // Store output in context variables
  context.variables[`node_${node.id}`] = output;

  // Find next nodes via edges
  const outgoingEdges = allEdges.filter((e) => e.source === node.id);

  if (outgoingEdges.length === 0) {
    // End of workflow
    return output;
  }

  // Handle branching (condition node)
  if (output?._branch && outgoingEdges.length > 1) {
    // Find edge matching the branch
    const branchEdge = outgoingEdges.find((e) =>
      e.sourceHandle === output._branch || e.sourceHandle === `handle-${output._branch}`
    ) || outgoingEdges[0];

    const nextNode = allNodes.find((n) => n.id === branchEdge.target);
    if (nextNode) {
      return executeFromNode(nextNode, allNodes, allEdges, output, context);
    }
    return output;
  }

  // Handle loop node
  if (output?._loop && output.items) {
    const results: any[] = [];
    for (const item of output.items) {
      // For each item, continue down the first edge
      const nextNode = allNodes.find((n) => n.id === outgoingEdges[0].target);
      if (nextNode) {
        const itemResult = await executeFromNode(nextNode, allNodes, allEdges, item, context);
        results.push(itemResult);
      }
    }
    return { loop_results: results, count: results.length };
  }

  // Normal flow: execute all outgoing edges (parallel for multiple)
  let lastResult = output;
  for (const edge of outgoingEdges) {
    const nextNode = allNodes.find((n) => n.id === edge.target);
    if (nextNode) {
      lastResult = await executeFromNode(nextNode, allNodes, allEdges, output, context);
    }
  }

  return lastResult;
}

async function logStepError(executionId: string, node: WorkflowNode, startTime: number, error: string) {
  const duration = Date.now() - startTime;
  await sql`
    UPDATE workflow_step_logs SET
      status = 'failed', error = ${error},
      duration_ms = ${duration}, completed_at = now()
    WHERE execution_id = ${executionId} AND node_id = ${node.id} AND status = 'running'
  `;
}
