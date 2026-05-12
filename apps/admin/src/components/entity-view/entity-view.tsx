import { useMemo } from 'react';
import { Toolbar } from './toolbar';
import { useEntityViewState } from '@/hooks/use-entity-view-state';
import type { EntityViewConfig, ViewRenderContext } from './entity-view.types';

interface EntityViewProps<T> {
  config: EntityViewConfig<T>;
  /** Optional scope for URL params (e.g. 'tasks') to avoid conflicts on pages with multiple EntityView. */
  scope?: string;
  className?: string;
}

export function EntityView<T>({ config, scope, className }: EntityViewProps<T>) {
  const [state, setters] = useEntityViewState({
    defaultView: config.defaultView ?? 'list',
    scope,
  });

  const activeView = config.views.find((v) => v.key === state.view) ?? config.views[0];

  // Pipeline: filter → search → sort → group
  const filteredItems = useMemo(() => {
    let items = config.items;

    // Hide closed unless toggle is on
    if (config.isClosed && !state.showClosed) {
      items = items.filter((i) => !config.isClosed!(i));
    }

    // Assignee filter
    if (state.assignees.length > 0 && config.getAssignee) {
      items = items.filter((i) => {
        const a = config.getAssignee!(i);
        return a && state.assignees.includes(a);
      });
    }

    // Search
    if (state.search && config.searchKeys && config.searchKeys.length > 0) {
      const q = state.search.toLowerCase();
      items = items.filter((i) => {
        for (const k of config.searchKeys!) {
          const raw = typeof k === 'function' ? k(i) : (i as Record<string, unknown>)[k as string];
          if (typeof raw === 'string' && raw.toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }

    // Sort
    if (state.sort && config.sortOptions) {
      const opt = config.sortOptions.find((s) => s.key === state.sort);
      if (opt) {
        items = [...items].sort(opt.compare);
        if (state.sortDir === 'desc') items.reverse();
      }
    }

    return items;
  }, [config, state.search, state.showClosed, state.assignees, state.sort, state.sortDir]);

  // Group
  const groupedItems = useMemo(() => {
    if (!state.group || !config.groupByOptions) return null;
    const opt = config.groupByOptions.find((g) => g.key === state.group);
    if (!opt) return null;

    const map = new Map<string, T[]>();

    // Seed with sortOrder so empty groups still render in correct order
    if (opt.sortOrder) {
      for (const k of opt.sortOrder) map.set(k, []);
    }

    for (const item of filteredItems) {
      const key = opt.getValue(item) ?? '__ungrouped__';
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }

    return map;
  }, [filteredItems, state.group, config.groupByOptions]);

  const ctx: ViewRenderContext<T> = {
    items: filteredItems,
    groupedItems,
    state,
    config,
  };

  return (
    <div className={className}>
      <Toolbar config={config} state={state} setters={setters} />
      <div className="min-h-0 flex-1">
        {filteredItems.length === 0 && config.emptyState
          ? config.emptyState
          : activeView.render(ctx)}
      </div>
    </div>
  );
}
