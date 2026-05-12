import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  label: string;
  color: string;
  bgColor: string;
}

export function StatusBadge({ label, color, bgColor }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={cn('text-xs px-1.5 py-0', bgColor, color)}>
      {label}
    </Badge>
  );
}
