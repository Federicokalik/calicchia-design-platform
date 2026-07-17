import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Trash2, Copy, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/hooks/use-i18n';

interface CalDavAppPassword {
  id: string;
  username: string;
  device_name: string;
  token_prefix: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  usage_count: number;
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Gestione app-password CalDAV (Radicale, tabella caldav_app_passwords).
 * Mirror di McpTokensSection: crea/lista/revoca; la password è mostrata in
 * chiaro UNA volta sola alla creazione (hash sha256 lato DB).
 */
export function CaldavTokensSection() {
  const { formatRelativeTime, formatDate, t } = useI18n();
  const queryClient = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [username, setUsername] = useState('federico');
  const [deviceName, setDeviceName] = useState('');
  const [showPassword, setShowPassword] = useState<{ password: string; device: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['caldav-tokens'],
    queryFn: () => apiFetch('/api/caldav-tokens'),
  });

  const passwords: CalDavAppPassword[] = data?.passwords ?? [];
  const active = passwords.filter((p) => p.is_active && !p.revoked_at);
  const revoked = passwords.filter((p) => !p.is_active || p.revoked_at);

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/caldav-tokens', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          device_name: deviceName.trim(),
        }),
      }),
    onSuccess: (resp: { password?: string; device_name?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['caldav-tokens'] });
      setOpenCreate(false);
      const device = resp?.device_name ?? deviceName;
      setDeviceName('');
      if (resp?.password) setShowPassword({ password: resp.password, device });
    },
    onError: (err: Error) => toast.error(err.message || 'Errore creazione app-password'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/caldav-tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['caldav-tokens'] });
      toast.success('App-password revocata: il device non sincronizzerà più');
    },
    onError: (err: Error) => toast.error(err.message || 'Errore revoca'),
  });

  const copyPassword = (password: string) => {
    navigator.clipboard.writeText(password);
    toast.success('Password copiata');
  };

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">App-password CalDAV</h2>
          <p className="text-sm text-muted-foreground">
            Credenziali per-dispositivo per sincronizzare i calendari via CalDAV
            (iPhone/macOS/DAVx5/Thunderbird su <code className="text-xs">dav.calicchia.design</code>).
            Ogni device usa la propria app-password, revocabile singolarmente.
          </p>
        </div>
        <Button onClick={() => setOpenCreate(true)}>+ Nuova app-password</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : active.length === 0 ? (
        <EmptyState
          title="Nessun device collegato"
          description="Crea un'app-password e usala come password CalDAV sul dispositivo (username = principal, di norma 'federico')."
          icon={CalendarClock}
        />
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {active.map((pw) => (
            <div key={pw.id} className="flex items-center gap-3 px-5 py-3.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{pw.device_name}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {pw.username} · {pw.token_prefix}…
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Ultimo uso: {pw.last_used_at ? formatRelativeTime(pw.last_used_at) : 'mai'}
                  {pw.last_used_ip && pw.last_used_ip !== 'unknown' ? ` · ${pw.last_used_ip}` : ''}
                  {' · '}{pw.usage_count} richieste
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revocare «{pw.device_name}»?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Il dispositivo smetterà di sincronizzare i calendari. Per ricollegarlo
                      servirà una nuova app-password.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => revokeMutation.mutate(pw.id)}>
                      Revoca
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </div>
      )}

      {revoked.length > 0 && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            {revoked.length} app-password revocate
          </summary>
          <div className="mt-2 rounded-xl border bg-muted/30 divide-y">
            {revoked.slice(0, 10).map((pw) => (
              <div key={pw.id} className="flex items-center gap-3 px-5 py-2 opacity-60">
                <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 text-xs truncate">{pw.device_name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {pw.revoked_at ? formatDate(pw.revoked_at) : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuova app-password CalDAV</DialogTitle>
            <DialogDescription>
              Una credenziale per un singolo dispositivo. La password viene mostrata
              una volta sola: salvala subito nel device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs font-medium">Username (principal CalDAV)</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="federico"
                className="text-sm h-9 font-mono"
                maxLength={64}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Nome dispositivo</Label>
              <Input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="iPhone Federico"
                className="text-sm h-9"
                maxLength={100}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpenCreate(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!username.trim() || !deviceName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creazione…' : 'Crea'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!showPassword} onOpenChange={(open) => !open && setShowPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>App-password per «{showPassword?.device || ''}»</DialogTitle>
            <DialogDescription className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <span>
                Salva la password ora — non sarà più visibile. Sul device usala come
                «password» dell&apos;account CalDAV (server{' '}
                <code className="text-xs bg-muted px-1 rounded">dav.calicchia.design</code>),
                NON la password admin.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
            {showPassword?.password}
          </div>
          <DialogFooter>
            <Button onClick={() => showPassword && copyPassword(showPassword.password)}>
              <Copy className="h-3.5 w-3.5 mr-2" /> {t('common.copy')}
            </Button>
            <Button variant="ghost" onClick={() => setShowPassword(null)}>
              Password salvata
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
