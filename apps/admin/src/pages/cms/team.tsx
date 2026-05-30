import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Save, X, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useTopbar } from '@/hooks/use-topbar';
import { useConfirm } from '@/hooks/use-confirm';
import { LoadingState } from '@/components/shared/loading-state';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { siteAsset } from '@/lib/public-urls';
import { ImageUpload } from '@/components/ui/image-upload';

interface TeamRow {
  id: string;
  locale: 'it' | 'en';
  name: string;
  role: string;
  bio: string | null;
  avatar_url: string | null;
  email: string | null;
  socials: Array<{ label: string; url: string; icon?: string }>;
  sort_order: number | null;
  is_published: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string | null;
  locale: 'it' | 'en';
  name: string;
  role: string;
  bio: string;
  avatar_url: string;
  email: string;
  socialsJson: string;
  sort_order: string;
  is_published: boolean;
}

const EMPTY_DRAFT: DraftRow = {
  id: null,
  locale: 'it',
  name: '',
  role: '',
  bio: '',
  avatar_url: '',
  email: '',
  socialsJson: '[]',
  sort_order: '',
  is_published: true,
};

export default function TeamCmsPage() {
  useTopbar({ title: 'CMS — Team', subtitle: 'Membri del team mostrati nelle pagine /perche-scegliere-me e simili.' });

  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [localeFilter, setLocaleFilter] = useState<'all' | 'it' | 'en'>('all');
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data, isLoading } = useQuery<{ rows: TeamRow[] }>({
    queryKey: ['cms-team', localeFilter],
    queryFn: () => apiFetch(`/api/cms/team${localeFilter !== 'all' ? `?locale=${localeFilter}` : ''}`),
  });
  const rows = data?.rows ?? [];

  const byLocale = useMemo(() => {
    const groups = new Map<string, TeamRow[]>();
    for (const row of rows) {
      const list = groups.get(row.locale) ?? [];
      list.push(row);
      groups.set(row.locale, list);
    }
    return groups;
  }, [rows]);

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRow) => {
      let socials: unknown = [];
      try { socials = JSON.parse(d.socialsJson || '[]'); }
      catch { throw new Error('JSON social non valido'); }
      const body = {
        locale: d.locale,
        name: d.name.trim(),
        role: d.role.trim(),
        bio: d.bio.trim() || null,
        avatar_url: d.avatar_url.trim() || null,
        email: d.email.trim() || null,
        socials,
        sort_order: d.sort_order.trim() === '' ? null : Number(d.sort_order),
        is_published: d.is_published,
      };
      if (d.id) return apiFetch(`/api/cms/team/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      return apiFetch('/api/cms/team', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-team'] });
      toast.success('Salvato');
      setDraft(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Errore'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cms/team/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-team'] });
      toast.success('Eliminato');
    },
  });

  const editRow = (row: TeamRow) => setDraft({
    id: row.id,
    locale: row.locale,
    name: row.name,
    role: row.role,
    bio: row.bio ?? '',
    avatar_url: row.avatar_url ?? '',
    email: row.email ?? '',
    socialsJson: JSON.stringify(row.socials ?? [], null, 2),
    sort_order: row.sort_order?.toString() ?? '',
    is_published: row.is_published,
  });

  const togglePublish = (row: TeamRow) => {
    saveMutation.mutate({
      ...EMPTY_DRAFT,
      id: row.id,
      locale: row.locale,
      name: row.name,
      role: row.role,
      bio: row.bio ?? '',
      avatar_url: row.avatar_url ?? '',
      email: row.email ?? '',
      socialsJson: JSON.stringify(row.socials ?? [], null, 2),
      sort_order: row.sort_order?.toString() ?? '',
      is_published: !row.is_published,
    });
  };

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <Select value={localeFilter} onValueChange={(v) => setLocaleFilter(v as typeof localeFilter)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutte le lingue</SelectItem>
            <SelectItem value="it">Italiano</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT, locale: localeFilter === 'en' ? 'en' : 'it' })}>
          <Plus className="h-4 w-4 mr-2" /> Nuovo membro
        </Button>
      </div>

      {draft && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{draft.id ? 'Modifica membro' : 'Nuovo membro'}</h3>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Lingua</Label>
              <Select value={draft.locale} onValueChange={(v) => setDraft({ ...draft, locale: v as 'it' | 'en' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="it">Italiano</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ordine</Label>
              <Input type="number" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nome</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ruolo</Label>
              <Input value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} placeholder="Graphic Design & Comunicazione" />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Avatar</Label>
              <ImageUpload
                value={draft.avatar_url}
                onChange={(url) => setDraft({ ...draft, avatar_url: url })}
                folder="team"
                aspectRatio="square"
                placeholder="Carica avatar (600x600)"
              />
              <p className="text-[10px] text-muted-foreground">Caricamento via /api/media/upload. Quadrato 600x600, webp/jpg/png. URL salvato nel campo avatar_url.</p>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Bio (opzionale)</Label>
              <Textarea value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} rows={3} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email (opzionale)</Label>
              <Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Pubblicato</Label>
              <Button variant={draft.is_published ? 'default' : 'outline'} onClick={() => setDraft({ ...draft, is_published: !draft.is_published })} className="w-full">
                {draft.is_published ? 'Visibile' : 'Nascosto'}
              </Button>
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Social (JSON array)</Label>
              <Textarea
                value={draft.socialsJson}
                onChange={(e) => setDraft({ ...draft, socialsJson: e.target.value })}
                rows={5}
                className="font-mono text-xs"
                placeholder='[{"label":"Instagram","url":"https://instagram.com/..."}]'
              />
            </div>
          </div>
          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending || !draft.name.trim() || !draft.role.trim()}>
            <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Salvataggio...' : 'Salva'}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nessun membro"
          description="Aggiungi il primo membro. Finché la tabella è vuota, il sito usa il team hardcoded di apps/sito-v3/src/data/team.ts."
        />
      ) : (
        <div className="space-y-6">
          {Array.from(byLocale.entries()).map(([locale, list]) => (
            <div key={locale} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide">{locale === 'it' ? 'Italiano' : 'English'}</h2>
                <Badge variant="outline">{list.length}</Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {list.map((row) => (
                  <div key={row.id} className="rounded-lg border bg-card p-4 flex gap-4 items-start">
                    {row.avatar_url && (
                      <img src={siteAsset(row.avatar_url)} alt={row.name} className="h-14 w-14 rounded-md object-cover bg-muted" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{row.name}</p>
                      <p className="text-xs text-muted-foreground">{row.role}</p>
                      {row.socials?.length > 0 && (
                        <p className="text-[10px] text-muted-foreground mt-1">{row.socials.length} link social</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {row.sort_order !== null && (
                        <Badge variant="outline" className="font-mono text-[10px]">#{row.sort_order}</Badge>
                      )}
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => togglePublish(row)}>
                          {row.is_published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => editRow(row)}>Modifica</Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            if (await confirm({ title: `Eliminare ${row.name}?`, variant: 'destructive' })) deleteMutation.mutate(row.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
