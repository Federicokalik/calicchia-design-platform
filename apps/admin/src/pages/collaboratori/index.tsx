import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, Search, Users, Building2, Mail, Phone, MoreHorizontal,
  Pencil, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useTopbar } from '@/hooks/use-topbar';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingState } from '@/components/shared/loading-state';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  partner: { label: 'Partner', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  subcontractor: { label: 'Sub-fornitore', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' },
};

export default function CollaboratoriPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', company: '', email: '', phone: '', type: 'partner', specialization: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['collaborators-v2', search],
    queryFn: () => apiFetch(`/api/collaborators-v2${search ? `?search=${search}` : ''}`),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => apiFetch('/api/collaborators-v2', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['collaborators-v2'] });
      setShowNew(false);
      setNewForm({ name: '', company: '', email: '', phone: '', type: 'partner', specialization: '' });
      toast.success('Collaboratore aggiunto');
      if (res?.collaborator?.id) navigate(`/collaboratori/${res.collaborator.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/collaborators-v2/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['collaborators-v2'] }); toast.success('Eliminato'); },
  });

  const collabs = data?.collaborators || [];

  const topbarActions = useMemo(() => (
    <Button size="sm" onClick={() => setShowNew(true)}>
      <Plus className="h-4 w-4 mr-1.5" /> Nuovo Collaboratore
    </Button>
  ), []);

  useTopbar({
    title: 'Collaboratori',
    subtitle: `${collabs.length} collaboratori`,
    actions: topbarActions,
  });

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Cerca collaboratore..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      {isLoading ? <LoadingState /> : collabs.length === 0 ? (
        <EmptyState title="Nessun collaboratore" description="Aggiungi il primo collaboratore o partner" icon={Users}>
          <Button size="sm" onClick={() => setShowNew(true)}>Aggiungi</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collabs.map((c: any) => {
            const typeCfg = TYPE_CONFIG[c.type] || TYPE_CONFIG.partner;
            return (
              <div key={c.id} className="rounded-xl border bg-card p-4 space-y-3 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 cursor-pointer" onClick={() => navigate(`/collaboratori/${c.id}`)}>
                    <h3 className="text-sm font-semibold truncate">{c.name}</h3>
                    {c.company && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <Building2 className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground truncate">{c.company}</span>
                      </div>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => navigate(`/collaboratori/${c.id}`)}>
                        <Pencil className="h-3.5 w-3.5 mr-2" /> Dettaglio
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm('Eliminare?')) deleteMutation.mutate(c.id); }}>
                        <Trash2 className="h-3.5 w-3.5 mr-2" /> Elimina
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn('text-[10px]', typeCfg.color)}>{typeCfg.label}</Badge>
                  {c.specialization && <Badge variant="outline" className="text-[10px]">{c.specialization}</Badge>}
                </div>

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {c.email && <div className="flex items-center gap-1"><Mail className="h-3 w-3" /> {c.email}</div>}
                  {c.phone && <div className="flex items-center gap-1"><Phone className="h-3 w-3" /> {c.phone}</div>}
                </div>

                <div className="flex items-center justify-between pt-1 border-t text-[10px] text-muted-foreground">
                  <span>{c.total_projects || 0} progetti</span>
                  <span>€{parseFloat(c.total_revenue || '0').toLocaleString('it-IT')}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New collaborator dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Nuovo Collaboratore</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (newForm.name) createMutation.mutate(newForm); }} className="space-y-3">
            <div className="space-y-1.5"><Label className="text-xs">Nome *</Label><Input value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} autoFocus /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Azienda</Label><Input value={newForm.company} onChange={(e) => setNewForm({ ...newForm, company: e.target.value })} /></div>
              <div className="space-y-1.5"><Label className="text-xs">Tipo</Label>
                <Select value={newForm.type} onValueChange={(v) => setNewForm({ ...newForm, type: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="partner">Partner</SelectItem>
                    <SelectItem value="subcontractor">Sub-fornitore</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Email</Label><Input value={newForm.email} onChange={(e) => setNewForm({ ...newForm, email: e.target.value })} /></div>
              <div className="space-y-1.5"><Label className="text-xs">Telefono</Label><Input value={newForm.phone} onChange={(e) => setNewForm({ ...newForm, phone: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Specializzazione</Label><Input value={newForm.specialization} onChange={(e) => setNewForm({ ...newForm, specialization: e.target.value })} placeholder="Web dev, Copywriting, Fotografia..." /></div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNew(false)}>Annulla</Button>
              <Button type="submit" disabled={!newForm.name}>Crea</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
