import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { GitBranch } from 'lucide-react';

export function LogicNode({ data, selected }: NodeProps) {
  const { label, subtype } = data as Record<string, any>;
  const isCondition = subtype === 'condition';

  return (
    <div className={cn(
      'relative min-w-[160px] rounded-xl border bg-card shadow-sm border-l-[3px] border-l-amber-500',
      selected && 'ring-2 ring-amber-400/40 shadow-md'
    )}>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-500">
          <GitBranch className="h-3.5 w-3.5" />
        </div>
        <p className="text-xs font-medium truncate">{label || 'Logic'}</p>
      </div>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-amber-500 !bg-card" />
      {isCondition ? (
        <>
          <Handle type="source" position={Position.Right} id="handle-true" className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-emerald-500 !bg-card" style={{ top: '35%' }} />
          <Handle type="source" position={Position.Right} id="handle-false" className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-red-500 !bg-card" style={{ top: '65%' }} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-amber-500 !bg-card" />
      )}
    </div>
  );
}
