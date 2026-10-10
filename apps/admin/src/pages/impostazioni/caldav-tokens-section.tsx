import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Trash2, Copy, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

type CalendarBackendMode = 'postgres' | 'cutover' | 'radicale' | 'rollback' | 'finalized';

interface CaldavTokensResponse {
  passwords: CalDavAppPassword[];
  /** Principal canonico (RADICALE_PRINCIPAL): lo username di ogni app-password nuova. */
  principal: string | null;
  /** Stato del backend calendario, solo per i messaggi (null se non leggibile). */
  calendar_backend: { mode: CalendarBackendMode; initialized: boolean } | null;
}

/** Host pubblico di Radicale (vhost CloudPanel): l'unico indirizzo da dare ai dispositivi. */
const DAV_HOST = 'dav.calicchia.design';
const DAV_URL = `https://${DAV_HOST}/`;
/** Principal canonico se l'API non lo indica (stesso default di RADICALE_PRINCIPAL). */
const DEFAULT_PRINCIPAL = 'federico';

/**
 * Gestione app-password CalDAV (Radicale, tabella caldav_app_passwords).
 * Mirror di McpTokensSection: crea/lista/revoca; la password è mostrata in
 * chiaro UNA volta sola alla creazione (hash sha256 lato DB).
 *
 * Dal passaggio a Radicale ogni app-password autentica come il principal
 * canonico (`federico`): lo username non si sceglie più. Le app-password
 * storiche create con un altro username (es. `iphone`) continuano a
 * funzionare e vedono gli stessi calendari. La revoca è immediata anche per
 * le credenziali tenute in cache da Radicale.
 */
export function CaldavTokensSection() {
  const { formatRelativeTime, formatDate, t } = useI18n();
  const queryClient = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [created, setCreated] = useState<{ password: string; device: string; username: string } | null>(null);

  const { data, isLoading } = useQuery<CaldavTokensResponse>({
    queryKey: ['caldav-tokens'],
    queryFn: () => apiFetch('/api/caldav-tokens'),
  });

  const principal = data?.principal || DEFAULT_PRINCIPAL;
  const passwords: CalDavAppPassword[] = data?.passwords ?? [];
  const active = passwords.filter((p) => p.is_active && !p.revoked_at);
  const revoked = passwords.filter((p) => !p.is_active || p.revoked_at);

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/caldav-tokens', {
        method: 'POST',
        body: JSON.stringify({
          // Esplicito anche se l'API userebbe comunque il principal canonico:
          // funziona anche con un'API non ancora aggiornata.
          username: principal,
          device_name: deviceName.trim(),
        }),
      }),
    onSuccess: (resp: { password?: string; device_name?: string; username?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['caldav-tokens'] });
      setOpenCreate(false);
      const device = resp?.device_name ?? deviceName;
      setDeviceName('');
      if (resp?.password) setCreated({ password: resp.password, device, username: resp.username ?? principal });
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

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value);
    toast.success(`${label} copiato`);
  };

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">App-password CalDAV</h2>
          <p className="text-sm text-muted-foreground">
            Credenziali per-dispositivo per sincronizzare i calendari via CalDAV
            (iPhone, Mac, Android con DAVx⁵, Thunderbird) su{' '}
            <code className="text-xs">{DAV_HOST}</code>. Ogni device usa la propria
            app-password, revocabile singolarmente; lo username è sempre{' '}
            <code className="text-xs">{principal}</code>.
          </p>
        </div>
        <Button onClick={() => setOpenCreate(true)}>+ Nuova app-password</Button>
      </div>

      <BackendNotice backend={data?.calendar_backend ?? null} />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : active.length === 0 ? (
        <EmptyState
          title="Nessun device collegato"
          description={`Crea un'app-password e usala come password CalDAV sul dispositivo, con username '${principal}'.`}
          icon={CalendarClock}
        />
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {active.map((pw) => {
            const isExpired = !!pw.expires_at && new Date(pw.expires_at).getTime() <= Date.now();
            const legacyUsername = pw.username !== principal;
            return (
              <div key={pw.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{pw.device_name}</p>
                    {legacyUsername && (
                      <Badge
                        variant="outline"
                        className="bg-muted text-muted-foreground text-[10px]"
                        title={`Creata con lo username «${pw.username}»: funziona comunque e accede ai calendari di «${principal}».`}
                      >
                        username storico
                      </Badge>
                    )}
                    {isExpired && (
                      <Badge variant="outline" className="bg-red-100 text-red-700 border-red-200 text-[10px]">
                        scaduta
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">
                    {pw.username} · {pw.token_prefix}…
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Ultimo uso: {pw.last_used_at ? formatRelativeTime(pw.last_used_at) : 'mai'}
                    {pw.last_used_ip && pw.last_used_ip !== 'unknown' ? ` · ${pw.last_used_ip}` : ''}
                    {' · '}{pw.usage_count} verifiche
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Revoca ${pw.device_name}`}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revocare «{pw.device_name}»?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Il dispositivo smetterà subito di sincronizzare i calendari. Per ricollegarlo
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
            );
          })}
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

      <details className="mt-2 rounded-xl border bg-card px-5 py-3">
        <summary className="text-sm font-medium cursor-pointer">Come collegare un dispositivo</summary>
        <div className="mt-3">
          <SetupInstructions principal={principal} />
        </div>
      </details>

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
              <Label className="text-xs font-medium">Username</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm">
                {principal}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Fisso per tutti i dispositivi: identifica il calendario, non il device.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="caldav-device-name" className="text-xs font-medium">Nome dispositivo</Label>
              <Input
                id="caldav-device-name"
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
              disabled={!deviceName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creazione…' : 'Crea'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!created} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>App-password per «{created?.device || ''}»</DialogTitle>
            <DialogDescription className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <span>
                Salva la password ora — non sarà più visibile. Sul device usala come
                «password» dell&apos;account CalDAV, NON la password admin.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <CredentialRow label="Server" value={DAV_HOST} onCopy={() => copy(DAV_HOST, 'Server')} />
            <CredentialRow
              label="Username"
              value={created?.username ?? principal}
              onCopy={() => copy(created?.username ?? principal, 'Username')}
            />
            <CredentialRow
              label="Password"
              value={created?.password ?? ''}
              onCopy={() => created && copy(created.password, 'Password')}
              breakAll
            />
          </div>
          <details className="rounded-md border px-3 py-2">
            <summary className="text-xs font-medium cursor-pointer">Istruzioni per iPhone, Mac e Android</summary>
            <div className="mt-2">
              <SetupInstructions principal={created?.username ?? principal} />
            </div>
          </details>
          <DialogFooter>
            <Button onClick={() => created && copy(created.password, 'Password')}>
              <Copy className="h-3.5 w-3.5 mr-2" /> {t('common.copy')}
            </Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              Password salvata
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Riga credenziale (etichetta, valore monospazio, copia). */
function CredentialRow({ label, value, onCopy, breakAll = false }: {
  label: string;
  value: string;
  onCopy: () => void;
  breakAll?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className={`flex-1 font-mono text-xs ${breakAll ? 'break-all' : 'truncate'}`}>{value}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onCopy} aria-label={`Copia ${label}`}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * Avviso sullo stato della migrazione a Radicale. È un'indicazione derivata da
 * calendar_backend_state, non la modalità effettiva di Radicale (che dipende
 * anche da heartbeat e identità del volume).
 */
function BackendNotice({ backend }: { backend: CaldavTokensResponse['calendar_backend'] }) {
  if (!backend) return null;
  let tone: 'info' | 'warn' = 'info';
  let text: string | null = null;
  if (!backend.initialized) {
    tone = 'warn';
    text =
      'Il calendario su Radicale non è ancora inizializzato: i dispositivi accedono con ' +
      "l'app-password ma non vedono ancora i calendari finché la migrazione non lo inizializza.";
  } else if (backend.mode === 'postgres') {
    text =
      'Migrazione del calendario in corso: sui dispositivi i calendari sono in sola lettura. ' +
      "Crea e modifica gli eventi dall'admin.";
  } else if (backend.mode === 'cutover' || backend.mode === 'rollback') {
    tone = 'warn';
    text = 'Cambio di backend del calendario in corso: sui dispositivi i calendari sono temporaneamente in sola lettura.';
  }
  if (!text) return null;
  const classes = tone === 'warn'
    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200'
    : 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200';
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${classes}`}>
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/** Passi per iPhone/iPad, Mac, Android (DAVx⁵) e Thunderbird con dav.calicchia.design. */
function SetupInstructions({ principal }: { principal: string }) {
  const accountUrl = `${DAV_URL}${principal}/`;
  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      <div>
        <p className="font-medium text-foreground">iPhone e iPad</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>
            Impostazioni → App → Calendario → Account calendario → Aggiungi account → Altro →
            Aggiungi account CalDAV (fino a iOS 17: Impostazioni → Calendario → Account).
          </li>
          <li>
            Server <code>{DAV_HOST}</code>, Nome utente <code>{principal}</code>, Password: l&apos;app-password,
            Descrizione a piacere. Poi Avanti e Salva.
          </li>
          <li>
            Se la verifica non trova l&apos;account: Impostazioni avanzate → URL account{' '}
            <code className="break-all">{accountUrl}</code>.
          </li>
        </ol>
      </div>
      <div>
        <p className="font-medium text-foreground">Mac</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>Calendario → Impostazioni → Account → + → Altro account CalDAV…</li>
          <li>
            Tipo di account Manuale, Nome utente <code>{principal}</code>, Password: l&apos;app-password,
            Indirizzo server <code>{DAV_HOST}</code>. Poi Accedi.
          </li>
        </ol>
      </div>
      <div>
        <p className="font-medium text-foreground">Android (DAVx⁵)</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>Installa DAVx⁵, poi + → Accedi con URL e nome utente.</li>
          <li>
            URL di base <code>{DAV_URL}</code>, Nome utente <code>{principal}</code>, Password: l&apos;app-password.
          </li>
          <li>Accedi, scegli i calendari da sincronizzare e aprili con l&apos;app Calendario.</li>
        </ol>
      </div>
      <div>
        <p className="font-medium text-foreground">Thunderbird</p>
        <p className="mt-1">
          Calendario → Nuovo calendario → In rete: Nome utente <code>{principal}</code>, Indirizzo{' '}
          <code className="break-all">{accountUrl}</code>, poi Trova calendari.
        </p>
      </div>
      <p>
        Prenotazioni, Festività e Scadenze sono sempre in sola lettura sui dispositivi: si gestiscono
        dall&apos;admin.
      </p>
    </div>
  );
}
