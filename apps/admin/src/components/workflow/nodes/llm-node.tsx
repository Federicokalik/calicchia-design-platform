import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';

export function LlmNode({ data, selected }: NodeProps) {
  const { label, provider } = data as Record<string, any>;
  return (
    <div className={cn(
      'relative min-w-[160px] rounded-xl border bg-card shadow-sm border-l-[3px] border-l-violet-500',
      selected && 'ring-2 ring-violet-400/40 shadow-md'
    )}>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium truncate">{label || 'LLM'}</p>
          {provider && <p className="text-[9px] text-muted-foreground">{provider}</p>}
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-violet-500 !bg-card" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-violet-500 !bg-card" />
    </div>
  );
}
