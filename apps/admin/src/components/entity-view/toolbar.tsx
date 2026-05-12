import { useState } from 'react';
import { Search, Layers, ArrowUpDown, Eye, EyeOff, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { ViewSwitcher } from './view-switcher';
import type { EntityViewConfig, EntityViewState, EntityViewStateSetters } from './entity-view.types';

interface ToolbarProps<T> {
  config: EntityViewConfig<T>;
  state: EntityViewState;
  setters: EntityViewStateSetters;
}

export function Toolbar<T>({ config, state, setters }: ToolbarProps<T>) {
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const groupOption = config.groupByOptions?.find((g) => g.key === state.group);
  const sortOption = config.sortOptions?.find((s) => s.key === state.sort);

  const submitCreate = () => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    config.onCreate?.(trimmed, {});
    setNewTitle('');
    setComposing(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {/* View switcher */}
      <ViewSwitcher config={config} current={state.view} onChange={setters.setView} />

      <div className="h-5 w-px bg-border mx-1" />

      {/* Group by */}
      {config.groupByOptions && config.groupByOptions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs">
              <Layers className="h-3.5 w-3.5" />
              {groupOption ? groupOption.label : 'Raggruppa'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Raggruppa per</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setters.setGroup(null)}>
              Nessuno
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {config.groupByOptions.map((g) => (
              <DropdownMenuItem key={g.key} onClick={() => setters.setGroup(g.key)}>
                {g.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Sort */}
      {config.sortOptions && config.sortOptions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {sortOption ? `${sortOption.label}${state.sortDir === 'desc' ? ' ↓' : ' ↑'}` : 'Ordina'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Ordina per</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setters.setSort(null)}>
              Nessuno
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {config.sortOptions.map((s) => (
              <div key={s.key} className="flex">
                <DropdownMenuItem className="flex-1" onClick={() => setters.setSort(s.key, 'asc')}>
                  {s.label} ↑
                </DropdownMenuItem>
                <DropdownMenuItem className="flex-1" onClick={() => setters.setSort(s.key, 'desc')}>
                  {s.label} ↓
                </DropdownMenuItem>
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Show closed toggle */}
      {config.isClosed && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => setters.setShowClosed(!state.showClosed)}
        >
          {state.showClosed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {state.showClosed ? 'Chiusi visibili' : 'Chiusi nascosti'}
        </Button>
      )}

      <div className="flex-1" />

      {/* Search */}
      {config.searchKeys && config.searchKeys.length > 0 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Cerca…"
            value={state.search}
            onChange={(e) => setters.setSearch(e.target.value)}
            className="h-8 w-40 pl-8 text-xs"
          />
        </div>
      )}

      {/* Create */}
      {config.onCreate && (
        composing ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              placeholder={config.createPlaceholder || 'Nuovo titolo…'}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') { setComposing(false); setNewTitle(''); }
              }}
              onBlur={() => { if (!newTitle.trim()) setComposing(false); }}
              className="h-8 w-48 text-xs"
            />
            <Button size="sm" className="h-8" onClick={submitCreate}>
              Crea
            </Button>
          </div>
        ) : (
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setComposing(true)}>
            <Plus className="h-3.5 w-3.5" />
            Nuovo
          </Button>
        )
      )}
    </div>
  );
}
