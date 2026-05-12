import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { EntityViewConfig, ViewKey } from './entity-view.types';

interface ViewSwitcherProps<T> {
  config: EntityViewConfig<T>;
  current: ViewKey;
  onChange: (view: ViewKey) => void;
}

export function ViewSwitcher<T>({ config, current, onChange }: ViewSwitcherProps<T>) {
  const available = config.availableViews ?? config.views.map((v) => v.key);
  const visible = config.views.filter((v) => available.includes(v.key));

  return (
    <div className="inline-flex items-center rounded-md border bg-background p-0.5">
      {visible.map((v) => {
        const Icon = v.icon;
        const active = current === v.key;
        return (
          <Tooltip key={v.key} delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(v.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-foreground/8 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
                )}
                aria-pressed={active}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{v.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {v.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
