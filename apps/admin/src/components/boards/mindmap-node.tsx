import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';

interface MindMapNodeData {
  label: string;
  color?: string;
  [key: string]: unknown;
}

const COLORS = [
  'bg-blue-500/10 border-blue-500/30',
  'bg-emerald-500/10 border-emerald-500/30',
  'bg-violet-500/10 border-violet-500/30',
  'bg-amber-500/10 border-amber-500/30',
  'bg-rose-500/10 border-rose-500/30',
  'bg-cyan-500/10 border-cyan-500/30',
  'bg-primary/10 border-primary/30',
];

function MindMapNode({ data, selected }: NodeProps) {
  const nodeData = data as MindMapNodeData;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(nodeData.label || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const finishEditing = useCallback(() => {
    setEditing(false);
    if (label.trim() !== nodeData.label) {
      nodeData.label = label.trim() || 'Nodo';
    }
  }, [label, nodeData]);

  const depth = typeof nodeData.depth === 'number' ? nodeData.depth : 0;
  const colorIdx = depth % COLORS.length;

  return (
    <div
      onDoubleClick={() => setEditing(true)}
      className={cn(
        'px-4 py-2.5 rounded-xl border-2 min-w-[120px] max-w-[240px] text-center transition-shadow cursor-pointer',
        COLORS[colorIdx],
        selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background shadow-lg'
      )}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-muted-foreground/40 !border-none" />

      {editing ? (
        <input
          ref={inputRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={finishEditing}
          onKeyDown={(e) => { if (e.key === 'Enter') finishEditing(); if (e.key === 'Escape') { setLabel(nodeData.label); setEditing(false); } }}
          className="w-full bg-transparent text-center text-sm font-medium outline-none border-b border-dashed border-current"
        />
      ) : (
        <span className="text-sm font-medium select-none">{nodeData.label || 'Nodo'}</span>
      )}

      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-muted-foreground/40 !border-none" />
    </div>
  );
}

export default memo(MindMapNode);
