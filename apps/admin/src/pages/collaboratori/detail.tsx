import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Building2, Mail, Phone, Briefcase, FolderKanban,
  FolderPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';

export default function CollaboratoreDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: '', project_type: 'website', customer_id: '', notes: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['collaborator', id],
    queryFn: () => apiFetch(`/api/collaborators-v2/${id}`),
    enabled: !!id,
  });

  const { data: projectsData } = useQuery({
    queryKey: ['collaborator-projects', id],
    queryFn: () => apiFetch(`/api/collaborators-v2/${id}/projects`),
    enabled: !!id,
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers-select'],
    queryFn: () => apiFetch('/api/customers?limit=100'),
  });

  const collab = data?.collaborator;
  const projects = projectsData?.projects || [];
  const customers = customersData?.customers || [];

  useTopbar({
    title: collab?.name || 'Collaboratore',
    subtitle: collab?.company || '',
  });

  const updateMutation = useMutation({
    mutationFn: (body: any) => apiFetch(`/api/collaborators-v2/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['collaborator', id] }); toast.success('Aggiornato'); },
  });

  const createProjectMutation = useMutation({
    mutationFn: async () => {
      return apiFetch('/api/client-projects', {
        method: 'POST',
        body: JSON.stringify({
          name: projectForm.name,
          project_type: projectForm.project_type,
          customer_id: projectForm.customer_id || null,
          collaborator_id: id,
          referred_by: collab?.name || '',
          status: 'draft',
          priority: 5,
          description: projectForm.notes || null,
        }),
      });
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['collaborator-projects', id] });
      setShowNewProject(false);
      setProjectForm({ name: '', project_type: 'website', customer_id: '', notes: '' });
      toast.success('Progetto creato');
      if (res?.project?.id) navigate(`/progetti/${res.project.id}`);
    },
    onError: () => toast.error('Errore creazione'),
  });

  if (isLoading) return <LoadingState />;
  if (!collab) return <EmptyState title="Collaboratore non trovato" />;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/collaboratori')} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold truncate">{collab.name}</h1>
            <Badge variant="outline" className="text-xs">{collab.type === 'partner' ? 'Partner' : 'Sub-fornitore'}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-muted-foreground">
            {collab.company && <span className="flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> {collab.company}</span>}
            {collab.email && <span className="flex items-center gap-1"><Mail className="h-3.5 w-3.5" /> {collab.email}</span>}
            {collab.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {collab.phone}</span>}
            {collab.specialization && <span className="flex items-center gap-1"><Briefcase className="h-3.5 w-3.5" /> {collab.specialization}</span>}
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="projects" className="gap-1.5">
            <FolderKanban className="h-3.5 w-3.5" /> Progetti
            {projects.length > 0 && <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{projects.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="rounded-xl border bg-card p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Nome</Label>
                <Input defaultValue={collab.name} onBlur={(e) => { if (e.target.value !== collab.name) updateMutation.mutate({ name: e.target.value }); }} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Azienda</Label>
                <Input defaultValue={collab.company || ''} onBlur={(e) => updateMutation.mutate({ company: e.target.value || null })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input defaultValue={collab.email || ''} onBlur={(e) => updateMutation.mutate({ email: e.target.value || null })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Telefono</Label>
                <Input defaultValue={collab.phone || ''} onBlur={(e) => updateMutation.mutate({ phone: e.target.value || null })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Tipo</Label>
                <Select defaultValue={collab.type} onValueChange={(v) => updateMutation.mutate({ type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="partner">Partner</SelectItem>
                    <SelectItem value="subcontractor">Sub-fornitore</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Specializzazione</Label>
                <Input defaultValue={collab.specialization || ''} onBlur={(e) => updateMutation.mutate({ specialization: e.target.value || null })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Note</Label>
              <Textarea defaultValue={collab.notes || ''} rows={3} onBlur={(e) => updateMutation.mutate({ notes: e.target.value || null })} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="projects">
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => setShowNewProject(true)}>
              <FolderPlus className="h-4 w-4 mr-1.5" /> Nuovo Progetto
            </Button>
          </div>
          {projects.length === 0 ? (
            <EmptyState title="Nessun progetto" description="Crea il primo progetto da questo collaboratore" icon={FolderKanban}>
              <Button size="sm" onClick={() => setShowNewProject(true)}>Crea progetto</Button>
            </EmptyState>
          ) : (
            <div className="rounded-xl border bg-card divide-y">
              {projects.map((p: any) => (
                <div key={p.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 cursor-pointer" onClick={() => navigate(`/progetti/${p.id}`)}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.project_type} · {p.status}{p.customer_name ? ` · ${p.customer_name}` : ''}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">→</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* New project dialog */}
      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Nuovo Progetto da {collab.name}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (projectForm.name) createProjectMutation.mutate(); }} className="space-y-3">
            <div className="space-y-1.5"><Label className="text-xs">Nome progetto *</Label><Input value={projectForm.name} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} autoFocus /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Tipo</Label>
                <Select value={projectForm.project_type} onValueChange={(v) => setProjectForm({ ...projectForm, project_type: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="website">Sito Web</SelectItem>
                    <SelectItem value="landing_page">Landing Page</SelectItem>
                    <SelectItem value="ecommerce">E-Commerce</SelectItem>
                    <SelectItem value="maintenance">Manutenzione</SelectItem>
                    <SelectItem value="consulting">Consulenza</SelectItem>
                    <SelectItem value="other">Altro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label className="text-xs">Cliente finale</Label>
                <Select value={projectForm.customer_id} onValueChange={(v) => setProjectForm({ ...projectForm, customer_id: v })}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Opzionale..." /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.contact_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Brief / Note</Label><Textarea value={projectForm.notes} onChange={(e) => setProjectForm({ ...projectForm, notes: e.target.value })} rows={2} placeholder="Cosa serve..." /></div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewProject(false)}>Annulla</Button>
              <Button type="submit" disabled={!projectForm.name}>Crea Progetto</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
