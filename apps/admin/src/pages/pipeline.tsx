import { useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import type { Lead, LeadStatus } from '@/types/lead';
import { LEAD_STATUS_CONFIG, LEAD_COLUMN_ORDER } from '@/types/lead';
import { LeadCard } from '@/components/pipeline/lead-card';
import { LeadDetail } from '@/components/pipeline/lead-detail';
import { LeadForm } from '@/components/pipeline/lead-form';
import { useI18n } from '@/hooks/use-i18n';

// --- Pipeline Column ---
function PipelineColumn({
  status,
  leads,
  onLeadClick,
}: {
  status: LeadStatus;
  leads: Lead[];
  onLeadClick: (lead: Lead) => void;
}) {
  const { t } = useI18n();
  const config = LEAD_STATUS_CONFIG[status];
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-muted/30 max-h-[calc(100vh-220px)]',
        isOver && 'ring-2 ring-primary/30 bg-primary/5',
      )}
    >
      <div className={cn('flex items-center justify-between px-3 py-2.5 border-b rounded-t-lg', config.bgColor)}>
        <div className="flex items-center gap-2">
          <span className={cn('text-sm font-semibold', config.color)}>{t(config.labelKey)}</span>
          <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {leads.length}
          </span>
        </div>
      </div>

      <div ref={setNodeRef} className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin">
        <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} onClick={onLeadClick} />
          ))}
        </SortableContext>

        {leads.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {t('lead.dragHere')}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Main Page ---
export default function PipelinePage() {
  const { t, formatCurrency } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeLead, setActiveLead] = useState<Lead | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [localLeads, setLocalLeads] = useState<Lead[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  }, []);

  const scrollBy = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const columnWidth = el.scrollWidth / LEAD_COLUMN_ORDER.length;
    el.scrollBy({ left: direction === 'right' ? columnWidth * 2 : -columnWidth * 2, behavior: 'smooth' });
    setTimeout(updateScrollState, 350);
  }, [updateScrollState]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Fetch leads
  const { data: leads = [], isLoading } = useQuery({
    queryKey: ['leads'],
    queryFn: async () => {
      const res = await apiFetch('/api/leads');
      return res.leads as Lead[];
    },
  });

  // Sync local leads when query data changes
  if (leads.length > 0 && localLeads.length === 0 && !activeLead) {
    setLocalLeads(leads);
  }
  // Keep in sync when not dragging
  if (leads !== localLeads && !activeLead && leads.length > 0) {
    if (JSON.stringify(leads) !== JSON.stringify(localLeads)) {
      setLocalLeads(leads);
    }
  }

  const displayLeads = localLeads.length > 0 ? localLeads : leads;

  // Mutations
  const createMutation = useMutation({
    mutationFn: async (data: Partial<Lead>) => {
      return apiFetch('/api/leads', { method: 'POST', body: JSON.stringify(data) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast.success(t('lead.created'));
    },
    onError: () => toast.error(t('lead.createError')),
  });

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<Lead> & { id: string }) => {
      const { id, ...body } = data;
      return apiFetch(`/api/leads/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setSelectedLead(null);
      toast.success(t('lead.updated'));
    },
    onError: () => toast.error(t('lead.updateError')),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiFetch(`/api/leads/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setSelectedLead(null);
      toast.success(t('lead.deleted'));
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LeadStatus }) => {
      return apiFetch(`/api/leads/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  // Get leads for a column
  const getColumnLeads = useCallback(
    (status: LeadStatus) =>
      displayLeads.filter((l) => l.status === status),
    [displayLeads],
  );

  // DnD handlers
  const handleDragStart = (event: DragStartEvent) => {
    const lead = displayLeads.find((l) => l.id === event.active.id);
    if (lead) setActiveLead(lead);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    const activeLd = localLeads.find((l) => l.id === activeId);
    if (!activeLd) return;

    let targetStatus: LeadStatus;
    const overLead = localLeads.find((l) => l.id === overId);

    if (overLead) {
      targetStatus = overLead.status;
    } else if (LEAD_COLUMN_ORDER.includes(overId as LeadStatus)) {
      targetStatus = overId as LeadStatus;
    } else {
      return;
    }

    if (activeLd.status !== targetStatus) {
      setLocalLeads((prev) =>
        prev.map((l) => (l.id === activeId ? { ...l, status: targetStatus } : l)),
      );
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active } = event;
    const lead = localLeads.find((l) => l.id === active.id);
    setActiveLead(null);

    if (lead) {
      const originalLead = leads.find((l) => l.id === lead.id);
      if (originalLead && originalLead.status !== lead.status) {
        statusMutation.mutate({ id: lead.id, status: lead.status });
      }
    }
  };

  // Convert lead to customer + project (legacy fast path — skips quote)
  const convertMutation = useMutation({
    mutationFn: async ({ id, project_name }: { id: string; project_name?: string }) => {
      return apiFetch(`/api/leads/${id}/convert`, {
        method: 'POST',
        body: JSON.stringify({ project_name }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setSelectedLead(null);
      toast.success(t('lead.converted'));
    },
    onError: () => toast.error(t('lead.convertError')),
  });

  const handleConvert = (lead: Lead) => {
    const projectName = window.prompt(t('lead.projectNamePrompt'));
    convertMutation.mutate({ id: lead.id, project_name: projectName || undefined });
  };

  // Convert lead → quote draft (passa da preventivo, flusso commerciale standard)
  const convertToQuoteMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      return apiFetch(`/api/leads/${id}/convert-to-quote`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setSelectedLead(null);
      toast.success('Preventivo creato');
      if (res?.quote?.id) {
        navigate(`/preventivi/${res.quote.id}/edit`);
      }
    },
    onError: () => toast.error('Errore creazione preventivo'),
  });

  const handleCreateQuote = (lead: Lead) => {
    convertToQuoteMutation.mutate({ id: lead.id });
  };

  // Pipeline value
  const pipelineValue = displayLeads
    .filter((l) => l.status !== 'lost')
    .reduce((sum, l) => sum + (parseFloat(String(l.estimated_value)) || 0), 0);

  const topbarActions = useMemo(() => (
    <Button onClick={() => setShowForm(true)} size="sm">
      <Plus className="h-4 w-4 mr-1.5" />
      {t('lead.new')}
    </Button>
  ), [t]);

  useTopbar({
    title: t('nav.pipeline'),
    subtitle: t('lead.pipelineValue', { count: displayLeads.length, value: formatCurrency(pipelineValue) }),
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      {isLoading ? (
        <LoadingState />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="relative">
            {/* Scroll left button */}
            {canScrollLeft && (
              <button
                onClick={() => scrollBy('left')}
                className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-background border shadow-md hover:bg-muted transition-colors"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}

            {/* Scroll right button */}
            {canScrollRight && (
              <button
                onClick={() => scrollBy('right')}
                className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-background border shadow-md hover:bg-muted transition-colors"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}

            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth"
              style={{ scrollSnapType: 'x mandatory' }}
            >
              {LEAD_COLUMN_ORDER.map((status) => (
                <div key={status} className="min-w-[calc(25%-9px)] flex-shrink-0" style={{ scrollSnapAlign: 'start' }}>
                  <PipelineColumn
                    status={status}
                    leads={getColumnLeads(status)}
                    onLeadClick={setSelectedLead}
                  />
                </div>
              ))}
            </div>
          </div>

          <DragOverlay>
            {activeLead && (
              <div className="rotate-3 w-[280px]">
                <LeadCard lead={activeLead} onClick={() => {}} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* Lead detail panel */}
      <LeadDetail
        lead={selectedLead}
        open={!!selectedLead}
        onClose={() => setSelectedLead(null)}
        onSave={(data) => updateMutation.mutate(data)}
        onDelete={(id) => deleteMutation.mutate(id)}
        onConvert={handleConvert}
        onCreateQuote={handleCreateQuote}
      />

      {/* New lead form */}
      <LeadForm
        open={showForm}
        onClose={() => setShowForm(false)}
        onCreate={(data) => createMutation.mutate(data)}
      />
    </div>
  );
}
