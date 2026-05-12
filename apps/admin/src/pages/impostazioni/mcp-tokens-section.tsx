import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Trash2, Copy, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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

interface McpToken {
  id: string;
  label: string;
  scope: 'read' | 'write' | 'admin';
  token_prefix: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  usage_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const SCOPE_BADGE: Record<McpToken['scope'], { labelKey: string; className: string }> = {
  read: { labelKey: 'settings.mcp.scope.read', className: 'bg-blue-100 text-blue-700 border-blue-200' },
  write: { labelKey: 'settings.mcp.scope.write', className: 'bg-amber-100 text-amber-700 border-amber-200' },
  admin: { labelKey: 'settings.mcp.scope.admin', className: 'bg-rose-100 text-rose-700 border-rose-200' },
};

export function McpTokensSection() {
  const { t, formatRelativeTime, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newScope, setNewScope] = useState<'read' | 'write' | 'admin'>('write');
  const [newExpiry, setNewExpiry] = useState('');
  const [showToken, setShowToken] = useState<{ token: string; label: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => apiFetch('/api/mcp-tokens'),
  });

  const active: McpToken[] = data?.active ?? [];
  const revoked: McpToken[] = data?.revoked ?? [];

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch('/api/mcp-tokens', {
        method: 'POST',
        body: JSON.stringify({
          label: newLabel.trim(),
          scope: newScope,
          expires_at: newExpiry || undefined,
        }),
      }),
    onSuccess: (resp: { token?: string; label?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['mcp-tokens'] });
      setOpenCreate(false);
      const lbl = resp?.label ?? newLabel;
      setNewLabel('');
      setNewExpiry('');
      if (resp?.token) setShowToken({ token: resp.token, label: lbl });
    },
    onError: (err: Error) => toast.error(err.message || t('settings.mcp.createError')),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mcp-tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-tokens'] });
      toast.success(t('settings.mcp.revoked'));
    },
    onError: (err: Error) => toast.error(err.message || t('settings.mcp.revokeError')),
  });

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    toast.success(t('settings.mcp.copied'));
  };

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('settings.mcp.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('settings.mcp.description')}
          </p>
        </div>
        <Button onClick={() => setOpenCreate(true)}>+ {t('settings.mcp.new')}</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : active.length === 0 ? (
        <EmptyState
          title={t('settings.mcp.emptyTitle')}
          description={t('settings.mcp.emptyDescription')}
          icon={KeyRound}
        />
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {active.map((token) => {
            const badge = SCOPE_BADGE[token.scope] ?? SCOPE_BADGE.write;
            const expiresIn = token.expires_at
              ? Math.max(0, Math.floor((new Date(token.expires_at).getTime() - Date.now()) / 86_400_000))
              : null;
            return (
              <div key={token.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{token.label}</p>
                    <Badge variant="outline" className={`${badge.className} text-[10px]`}>
                      {t(badge.labelKey)}
                    </Badge>
                    {expiresIn !== null && expiresIn < 7 && (
                      <Badge variant="outline" className="bg-orange-100 text-orange-700 border-orange-200 text-[10px]">
                        {t('settings.mcp.expiresIn', { days: expiresIn })}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{token.token_prefix}…</p>
                  <p className="text-[10px] text-muted-foreground">
                    {t('settings.mcp.lastUse')}: {token.last_used_at ? formatRelativeTime(token.last_used_at) : t('common.never')}
                    {token.last_used_ip && token.last_used_ip !== 'unknown' ? ` · ${token.last_used_ip}` : ''}
                    {' · '}
                    {t('settings.mcp.calls', { count: token.usage_count })}
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
                      <AlertDialogTitle>{t('settings.mcp.revokeTitle', { label: token.label })}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('settings.mcp.revokeDescription')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => revokeMutation.mutate(token.id)}>
                        {t('settings.mcp.revoke')}
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
            {t('settings.mcp.revokedTokens', { count: revoked.length })}
          </summary>
          <div className="mt-2 rounded-xl border bg-muted/30 divide-y">
            {revoked.slice(0, 10).map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-5 py-2 opacity-60">
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 text-xs truncate">{t.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t.revoked_at ? formatDate(t.revoked_at) : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.newTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.mcp.newDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs font-medium">{t('settings.mcp.label')}</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t('settings.mcp.labelPlaceholder')}
                className="text-sm h-9"
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">{t('settings.mcp.scope')}</Label>
              <select
                value={newScope}
                onChange={(e) => setNewScope(e.target.value as 'read' | 'write' | 'admin')}
                className="w-full text-sm h-9 rounded-md border border-input bg-background px-3"
              >
                <option value="read">{t('settings.mcp.scope.readOption')}</option>
                <option value="write">{t('settings.mcp.scope.writeOption')}</option>
                <option value="admin">{t('settings.mcp.scope.adminOption')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">{t('settings.mcp.expiry')}</Label>
              <Input
                type="date"
                value={newExpiry}
                onChange={(e) => setNewExpiry(e.target.value)}
                className="text-sm h-9"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpenCreate(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!newLabel.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? t('settings.mcp.generating') : t('settings.mcp.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!showToken} onOpenChange={(open) => !open && setShowToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.createdTitle', { label: showToken?.label || '' })}</DialogTitle>
            <DialogDescription className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <span>
                {t('settings.mcp.createdDescription')}{' '}
                <code className="text-xs bg-muted px-1 rounded">MCP_SERVICE_TOKEN</code> nel client
                (Claude Desktop / Claude Code).
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
            {showToken?.token}
          </div>
          <DialogFooter>
            <Button onClick={() => showToken && copyToken(showToken.token)}>
              <Copy className="h-3.5 w-3.5 mr-2" /> {t('common.copy')}
            </Button>
            <Button variant="ghost" onClick={() => setShowToken(null)}>
              {t('settings.mcp.savedToken')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
