import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link2, X, FolderKanban, Users, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface LinkEntityPickerProps {
  linkedType: string | null;
  linkedId: string | null;
  onChange: (type: string | null, id: string | null, label: string | null) => void;
}

export function LinkEntityPicker({ linkedType, linkedId, onChange }: LinkEntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'project' | 'customer'>('project');
  const [search, setSearch] = useState('');

  const { data: projects } = useQuery({
    queryKey: ['link-projects', search],
    queryFn: () => apiFetch(`/api/client-projects?search=${search}&limit=8`),
    enabled: open && tab === 'project',
  });

  const { data: customers } = useQuery({
    queryKey: ['link-customers', search],
    queryFn: () => apiFetch(`/api/customers?search=${search}&limit=8`),
    enabled: open && tab === 'customer',
  });

  // Fetch linked entity label
  const { data: linkedData } = useQuery({
    queryKey: ['linked-entity', linkedType, linkedId],
    queryFn: async () => {
      if (linkedType === 'project') {
        const res = await apiFetch(`/api/client-projects/${linkedId}`);
        return { label: res.project?.name || 'Progetto', type: 'project' };
      }
      if (linkedType === 'customer') {
        const res = await apiFetch(`/api/customers/${linkedId}`);
        return { label: res.customer?.contact_name || res.customer?.company_name || 'Cliente', type: 'customer' };
      }
      return null;
    },
    enabled: !!linkedType && !!linkedId,
  });

  const items = tab === 'project'
    ? (projects?.projects || []).map((p: any) => ({ id: p.id, label: p.name || p.title, sub: p.customer_name }))
    : (customers?.customers || []).map((c: any) => ({ id: c.id, label: c.contact_name, sub: c.company_name }));

  if (linkedType && linkedId && linkedData) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-xs gap-1.5 pr-1">
          {linkedType === 'project' ? <FolderKanban className="h-3 w-3" /> : <Users className="h-3 w-3" />}
          {linkedData.label}
          <button onClick={() => onChange(null, null, null)} className="hover:text-destructive ml-1">
            <X className="h-3 w-3" />
          </button>
        </Badge>
      </div>
    );
  }

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1.5" onClick={() => setOpen(!open)}>
        <Link2 className="h-3.5 w-3.5" /> Collega a progetto o cliente
      </Button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-72 rounded-xl border bg-popover shadow-lg">
          {/* Tabs */}
          <div className="flex border-b">
            <button
              onClick={() => { setTab('project'); setSearch(''); }}
              className={cn('flex-1 px-3 py-2 text-xs font-medium transition-colors', tab === 'project' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground')}
            >
              <FolderKanban className="h-3 w-3 inline mr-1" /> Progetti
            </button>
            <button
              onClick={() => { setTab('customer'); setSearch(''); }}
              className={cn('flex-1 px-3 py-2 text-xs font-medium transition-colors', tab === 'customer' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground')}
            >
              <Users className="h-3 w-3 inline mr-1" /> Clienti
            </button>
          </div>

          {/* Search */}
          <div className="p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Cerca ${tab === 'project' ? 'progetto' : 'cliente'}...`}
                className="pl-8 h-8 text-xs"
                autoFocus
              />
            </div>
          </div>

          {/* Results */}
          <div className="max-h-48 overflow-y-auto p-1">
            {items.length === 0 ? (
              <p className="text-[10px] text-muted-foreground text-center py-4">Nessun risultato</p>
            ) : (
              items.map((item: any) => (
                <button
                  key={item.id}
                  onClick={() => {
                    onChange(tab, item.id, item.label);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-left hover:bg-muted transition-colors"
                >
                  {tab === 'project' ? <FolderKanban className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{item.label}</p>
                    {item.sub && <p className="text-[10px] text-muted-foreground truncate">{item.sub}</p>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
