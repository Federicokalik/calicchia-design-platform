import ELK from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

const elk = new ELK();

export type LayoutDirection = 'RIGHT' | 'DOWN' | 'radial';

export async function layoutNodes(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'RIGHT'
): Promise<Node[]> {
  const isRadial = direction === 'radial';

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': isRadial ? 'radial' : 'layered',
      ...(isRadial ? {} : { 'elk.direction': direction }),
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: 160,
      height: 50,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layouted = await elk.layout(graph);

  return nodes.map((node) => {
    const elkNode = layouted.children?.find((n) => n.id === node.id);
    if (elkNode) {
      return {
        ...node,
        position: { x: elkNode.x ?? node.position.x, y: elkNode.y ?? node.position.y },
      };
    }
    return node;
  });
}
