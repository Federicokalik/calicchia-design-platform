import { useWidgetLayout, type WidgetConfig } from '@/hooks/use-widget-layout';
import { useTopbar } from '@/hooks/use-topbar';
import { WidgetGrid } from '@/components/dashboard/widget-grid';
import { WidgetKpi } from '@/components/dashboard/widget-kpi';
import { WidgetAgenda } from '@/components/dashboard/widget-agenda';
import { WidgetProjects } from '@/components/dashboard/widget-projects';
import { WidgetPipeline } from '@/components/dashboard/widget-pipeline';
import { WidgetDeadlines } from '@/components/dashboard/widget-deadlines';
import { WidgetRevenue } from '@/components/dashboard/widget-revenue';
import { WidgetFeed } from '@/components/dashboard/widget-feed';
import { WidgetKnowledge } from '@/components/dashboard/widget-knowledge';
import { WidgetTasse } from '@/components/dashboard/widget-tasse';
import { WidgetCapacity } from '@/components/dashboard/widget-capacity';
import { useI18n } from '@/hooks/use-i18n';

const widgetComponents: Record<string, React.ComponentType> = {
  kpi: WidgetKpi,
  agenda: WidgetAgenda,
  projects: WidgetProjects,
  pipeline: WidgetPipeline,
  deadlines: WidgetDeadlines,
  revenue: WidgetRevenue,
  feed: WidgetFeed,
  knowledge: WidgetKnowledge,
  tasse: WidgetTasse,
  capacity: WidgetCapacity,
};

function renderWidget(widget: WidgetConfig) {
  const Component = widgetComponents[widget.type];
  if (!Component) return null;
  return <Component />;
}

export default function DashboardPage() {
  const { t } = useI18n();
  const { widgets, visibleWidgets, reorder, toggleWidget, resetLayout } =
    useWidgetLayout();

  useTopbar({ title: t('dashboard.title'), subtitle: t('dashboard.subtitle') });

  return (
    <div className="space-y-4">

      <WidgetGrid
        widgets={widgets}
        visibleWidgets={visibleWidgets}
        onReorder={reorder}
        onToggle={toggleWidget}
        onReset={resetLayout}
        renderWidget={renderWidget}
      />
    </div>
  );
}
