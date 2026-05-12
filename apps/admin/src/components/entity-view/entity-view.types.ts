import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type ViewKey = 'list' | 'board' | 'calendar' | 'gantt';

export interface EntityViewState {
  view: ViewKey;
  group: string | null;
  sort: string | null;
  sortDir: 'asc' | 'desc';
  search: string;
  assignees: string[];
  showClosed: boolean;
}

export interface EntityViewStateSetters {
  setView: (v: ViewKey) => void;
  setGroup: (key: string | null) => void;
  setSort: (key: string | null, dir?: 'asc' | 'desc') => void;
  setSearch: (q: string) => void;
  setAssignees: (ids: string[]) => void;
  setShowClosed: (v: boolean) => void;
  reset: () => void;
}

export interface ViewSpec<T> {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
  render: (ctx: ViewRenderContext<T>) => ReactNode;
}

export interface ViewRenderContext<T> {
  items: T[];
  groupedItems: Map<string, T[]> | null;
  state: EntityViewState;
  config: EntityViewConfig<T>;
}

export interface GroupByOption<T> {
  key: string;
  label: string;
  getValue: (item: T) => string | null;
  formatLabel?: (value: string) => string;
  sortOrder?: string[];
}

export interface SortOption<T> {
  key: string;
  label: string;
  compare: (a: T, b: T) => number;
}

export interface EntityViewConfig<T> {
  entityType: string;
  items: T[];
  getId: (item: T) => string;
  getTitle: (item: T) => string;
  getStatus?: (item: T) => string;
  isClosed?: (item: T) => boolean;
  getAssignee?: (item: T) => string | null;
  getAssigneeLabel?: (item: T) => string | null;
  searchKeys?: Array<keyof T | ((item: T) => string)>;
  groupByOptions?: GroupByOption<T>[];
  sortOptions?: SortOption<T>[];
  views: ViewSpec<T>[];
  availableViews?: ViewKey[];
  defaultView?: ViewKey;
  onItemClick?: (item: T) => void;
  onCreate?: (title: string, ctx: { status?: string }) => void;
  createPlaceholder?: string;
  emptyState?: ReactNode;
}
