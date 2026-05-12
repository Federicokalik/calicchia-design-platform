import { Inbox } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  children?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  children,
}: EmptyStateProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="h-12 w-12 text-muted-foreground/30 mb-4" />
      <h3 className="text-sm font-medium">{title || t('common.noResults')}</h3>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">{description}</p>
      )}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
