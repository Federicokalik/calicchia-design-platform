import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { Copy, ShieldCheck, ShieldAlert, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';

type Mode = 'idle' | 'setup' | 'backup' | 'disable';

/**
 * SEC-06 — TOTP MFA enrollment for the admin account.
 * Enroll: setup (generate secret) → enter the first code → enable → backup codes.
 */
export function MfaSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [secret, setSecret] = useState('');
  const [otpauthUri, setOtpauthUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then((d) => setEnabled(Boolean(d?.user?.mfa_enabled)))
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : 'Impossibile leggere lo stato 2FA');
        setEnabled(null);
      });
  }, []);

  useEffect(() => {
    if (!otpauthUri) {
      setQrDataUrl('');
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(otpauthUri, { margin: 2, width: 192 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });

    return () => {
      cancelled = true;
    };
  }, [otpauthUri]);

  const copyText = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  };

  const startSetup = async () => {
    setBusy(true);
    try {
      const d = await apiFetch('/api/auth/mfa/setup', { method: 'POST', body: JSON.stringify({}) });
      setSecret(String(d.secret ?? ''));
      setOtpauthUri(String(d.otpauth_uri ?? ''));
      setQrDataUrl('');
      setCode('');
      setMode('setup');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Errore avvio configurazione');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async () => {
    setBusy(true);
    try {
      const d = await apiFetch('/api/auth/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setBackupCodes(Array.isArray(d.backup_codes) ? d.backup_codes : []);
      setEnabled(true);
      setCode('');
      setMode('backup');
      toast.success('Autenticazione a due fattori attivata');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Codice non valido');
    } finally {
      setBusy(false);
    }
  };

  const confirmDisable = async () => {
    setBusy(true);
    try {
      await apiFetch('/api/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setEnabled(false);
      setCode('');
      setMode('idle');
      toast.success('Autenticazione a due fattori disattivata');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Codice non valido');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Autenticazione a due fattori (2FA)</h2>
        {enabled === true && (
          <Badge variant="secondary" className="gap-1">
            <ShieldCheck className="h-3.5 w-3.5" /> Attiva
          </Badge>
        )}
        {enabled === false && (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5" /> Non attiva
          </Badge>
        )}
      </div>

      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {enabled === null && (
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
        </p>
      )}

      {/* ── Idle: status + primary action ── */}
      {enabled !== null && mode === 'idle' && (
        <>
          <p className="text-sm text-muted-foreground max-w-prose">
            Richiede un codice temporaneo da un'app di autenticazione (Google
            Authenticator, Authy, 1Password…) ad ogni accesso al pannello.
          </p>
          {enabled ? (
            <Button variant="outline" onClick={() => { setCode(''); setMode('disable'); }}>
              Disattiva 2FA
            </Button>
          ) : (
            <Button onClick={startSetup} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Attiva 2FA
            </Button>
          )}
        </>
      )}

      {/* ── Setup: show secret, collect first code ── */}
      {mode === 'setup' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground max-w-prose">
            Aggiungi questo account nell'app di autenticazione — scansiona il QR
            dall'URI sotto, oppure inserisci la chiave manualmente — poi digita il
            codice a 6 cifre per confermare.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex h-52 w-52 items-center justify-center rounded-lg border bg-white p-3">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="QR code per configurare la 2FA" className="h-48 w-48" />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label>Chiave manuale</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => copyText(secret, 'Chiave copiata')}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copia
                  </Button>
                </div>
                <code className="block rounded bg-muted px-3 py-2 text-sm font-mono break-all">{secret}</code>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label>URI otpauth</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => copyText(otpauthUri, 'URI copiato')}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copia
                  </Button>
                </div>
                <code className="block rounded bg-muted px-3 py-2 text-xs font-mono break-all">{otpauthUri}</code>
              </div>
            </div>
          </div>
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="mfa-enable-code">Codice di verifica</Label>
            <Input
              id="mfa-enable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={confirmEnable} disabled={busy || code.trim().length < 6}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Conferma e attiva
            </Button>
            <Button variant="ghost" onClick={() => { setMode('idle'); setCode(''); }} disabled={busy}>
              Annulla
            </Button>
          </div>
        </div>
      )}

      {/* ── Backup codes: shown once ── */}
      {mode === 'backup' && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
            Salva questi codici di recupero in un posto sicuro. Sono mostrati una
            sola volta e ognuno è utilizzabile una volta sola se perdi l'app.
          </p>
          <div className="grid grid-cols-2 gap-2 max-w-sm">
            {backupCodes.map((bc) => (
              <code key={bc} className="rounded bg-muted px-2 py-1 text-sm font-mono text-center">{bc}</code>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => copyText(backupCodes.join('\n'), 'Codici copiati')}>
              <Copy className="mr-2 h-4 w-4" /> Copia codici
            </Button>
            <Button onClick={() => setMode('idle')}>Ho salvato i codici</Button>
          </div>
        </div>
      )}

      {/* ── Disable: confirm with a current code ── */}
      {mode === 'disable' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Inserisci un codice corrente dell'app per disattivare la 2FA.
          </p>
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="mfa-disable-code">Codice di verifica</Label>
            <Input
              id="mfa-disable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="destructive" onClick={confirmDisable} disabled={busy || code.trim().length < 6}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Conferma disattivazione
            </Button>
            <Button variant="ghost" onClick={() => { setMode('idle'); setCode(''); }} disabled={busy}>
              Annulla
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
