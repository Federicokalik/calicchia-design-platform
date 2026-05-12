import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Zap } from 'lucide-react';

export function TriggerNode({ data, selected }: NodeProps) {
  const { label } = data as Record<string, any>;
  return (
    <div className={cn(
      'relative min-w-[160px] rounded-xl border bg-card shadow-sm border-l-[3px] border-l-emerald-500',
      selected && 'ring-2 ring-emerald-400/40 shadow-md'
    )}>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-500">
          <Zap className="h-3.5 w-3.5" />
        </div>
        <p className="text-xs font-medium truncate">{label || 'Trigger'}</p>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-emerald-500 !bg-card" />
    </div>
  );
}
