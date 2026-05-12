import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { EntityViewState, EntityViewStateSetters, ViewKey } from '@/components/entity-view/entity-view.types';

const VALID_VIEWS: ViewKey[] = ['list', 'board', 'calendar', 'gantt'];

interface UseEntityViewStateOptions {
  defaultView?: ViewKey;
  scope?: string;
}

function parseView(raw: string | null, fallback: ViewKey): ViewKey {
  return raw && (VALID_VIEWS as string[]).includes(raw) ? (raw as ViewKey) : fallback;
}

export function useEntityViewState(options: UseEntityViewStateOptions = {}): [EntityViewState, EntityViewStateSetters] {
  const { defaultView = 'list', scope = '' } = options;
  const [params, setParams] = useSearchParams();
  const k = (name: string) => (scope ? `${scope}.${name}` : name);

  const state: EntityViewState = useMemo(() => ({
    view: parseView(params.get(k('view')), defaultView),
    group: params.get(k('group')),
    sort: params.get(k('sort')),
    sortDir: params.get(k('sortDir')) === 'desc' ? 'desc' : 'asc',
    search: params.get(k('search')) || '',
    assignees: (params.get(k('assignees')) || '').split(',').filter(Boolean),
    showClosed: params.get(k('showClosed')) === '1',
  }), [params, defaultView, scope]);

  const merge = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, val] of Object.entries(patch)) {
        const full = scope ? `${scope}.${key}` : key;
        if (val === null || val === '') next.delete(full);
        else next.set(full, val);
      }
      return next;
    }, { replace: true });
  }, [setParams, scope]);

  const setters: EntityViewStateSetters = useMemo(() => ({
    setView: (v) => merge({ view: v === defaultView ? null : v }),
    setGroup: (key) => merge({ group: key }),
    setSort: (key, dir = 'asc') => merge({ sort: key, sortDir: dir === 'desc' ? 'desc' : null }),
    setSearch: (q) => merge({ search: q || null }),
    setAssignees: (ids) => merge({ assignees: ids.length ? ids.join(',') : null }),
    setShowClosed: (v) => merge({ showClosed: v ? '1' : null }),
    reset: () => setParams((prev) => {
      const next = new URLSearchParams(prev);
      ['view', 'group', 'sort', 'sortDir', 'search', 'assignees', 'showClosed'].forEach((name) => {
        next.delete(scope ? `${scope}.${name}` : name);
      });
      return next;
    }, { replace: true }),
  }), [merge, defaultView, setParams, scope]);

  return [state, setters];
}
