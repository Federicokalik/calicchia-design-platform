import { useState, useCallback } from 'react';

export interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  titleKey: string;
  w: 1 | 2 | 3 | 4; // grid columns (out of 4)
  h: 1 | 2 | 3;      // grid rows
  visible: boolean;
}

const STORAGE_KEY = 'admin-dashboard-layout';

const DEFAULT_LAYOUT: WidgetConfig[] = [
  { id: 'kpi', type: 'kpi', title: 'KPI', titleKey: 'dashboard.widgets.kpi.title', w: 4, h: 1, visible: true },
  { id: 'agenda', type: 'agenda', title: 'Agenda Oggi', titleKey: 'dashboard.widgets.agenda.title', w: 2, h: 2, visible: true },
  { id: 'projects', type: 'projects', title: 'Progetti Attivi', titleKey: 'dashboard.widgets.projects.title', w: 2, h: 2, visible: true },
  { id: 'pipeline', type: 'pipeline', title: 'Pipeline', titleKey: 'dashboard.widgets.pipeline.title', w: 1, h: 1, visible: true },
  { id: 'deadlines', type: 'deadlines', title: 'Scadenze', titleKey: 'dashboard.widgets.deadlines.title', w: 1, h: 1, visible: true },
  { id: 'revenue', type: 'revenue', title: 'Revenue', titleKey: 'dashboard.widgets.revenue.title', w: 2, h: 2, visible: true },
  { id: 'tasse', type: 'tasse', title: 'Tasse stimate', titleKey: 'dashboard.widgets.tasse.title', w: 2, h: 1, visible: true },
  { id: 'capacity', type: 'capacity', title: 'Capacità settimanale', titleKey: 'dashboard.widgets.capacity.title', w: 2, h: 1, visible: true },
  { id: 'feed', type: 'feed', title: 'Attività Recente', titleKey: 'dashboard.widgets.feed.title', w: 2, h: 2, visible: true },
  { id: 'knowledge', type: 'knowledge', title: 'Knowledge Base', titleKey: 'dashboard.widgets.knowledge.title', w: 2, h: 2, visible: true },
];

const TITLE_KEYS_BY_TYPE = new Map(DEFAULT_LAYOUT.map((widget) => [widget.type, widget.titleKey]));

function migrateLayout(widgets: Partial<WidgetConfig>[]): WidgetConfig[] {
  return widgets.map((widget) => {
    const fallback = DEFAULT_LAYOUT.find((item) => item.id === widget.id) || DEFAULT_LAYOUT[0];
    return {
      ...fallback,
      ...widget,
      titleKey: widget.titleKey || TITLE_KEYS_BY_TYPE.get(widget.type || '') || fallback.titleKey,
      title: widget.title || fallback.title,
    } as WidgetConfig;
  });
}

function loadLayout(): WidgetConfig[] {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return migrateLayout(JSON.parse(stored));
  } catch {
    // localStorage unavailable or stored JSON malformed — fall through to defaults
  }
  return DEFAULT_LAYOUT;
}

export function useWidgetLayout() {
  const [widgets, setWidgets] = useState<WidgetConfig[]>(loadLayout);

  const saveLayout = useCallback((newWidgets: WidgetConfig[]) => {
    setWidgets(newWidgets);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newWidgets));
  }, []);

  const reorder = useCallback((fromId: string, toId: string) => {
    setWidgets((prev) => {
      const fromIdx = prev.findIndex((w) => w.id === fromId);
      const toIdx = prev.findIndex((w) => w.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleWidget = useCallback((id: string) => {
    setWidgets((prev) => {
      const next = prev.map((w) =>
        w.id === id ? { ...w, visible: !w.visible } : w
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetLayout = useCallback(() => {
    saveLayout(DEFAULT_LAYOUT);
  }, [saveLayout]);

  return {
    widgets,
    visibleWidgets: widgets.filter((w) => w.visible),
    reorder,
    toggleWidget,
    resetLayout,
    saveLayout,
  };
}
