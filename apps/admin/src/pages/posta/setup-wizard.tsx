import { useState } from 'react';
import { Mail, Loader2, CheckCircle2, XCircle, Server } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';

interface Preset {
  id: string;
  name: string;
  hint?: string;
  buildHosts: (email: string) => {
    imap_host: string;
    imap_port: number;
    imap_secure: boolean;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
  };
}

const PRESETS: Preset[] = [
  {
    id: 'custom',
    name: 'Personalizzato',
    hint: 'Inserisci host/porte a mano',
    buildHosts: () => ({ imap_host: '', imap_port: 993, imap_secure: true, smtp_host: '', smtp_port: 465, smtp_secure: true }),
  },
  {
    id: 'aruba',
    name: 'Aruba',
    buildHosts: () => ({ imap_host: 'imaps.aruba.it', imap_port: 993, imap_secure: true, smtp_host: 'smtps.aruba.it', smtp_port: 465, smtp_secure: true }),
  },
  {
    id: 'libero',
    name: 'Libero',
    buildHosts: () => ({ imap_host: 'imapmail.libero.it', imap_port: 993, imap_secure: true, smtp_host: 'smtp.libero.it', smtp_port: 465, smtp_secure: true }),
  },
  {
    id: 'gmail',
    name: 'Gmail',
    hint: 'App-password se 2FA',
    buildHosts: () => ({ imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: true, smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true }),
  },
  {
    id: 'outlook',
    name: 'Outlook / M365',
    hint: 'App-password richiesta',
    buildHosts: () => ({ imap_host: 'outlook.office365.com', imap_port: 993, imap_secure: true, smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: false }),
  },
];

interface SetupWizardProps {
  onSaved: () => void;
}

export function SetupWizard({ onSaved }: SetupWizardProps) {
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<null | { imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } }>(null);

  const applyPreset = (p: Preset, currentEmail: string) => {
    setPreset(p);
    const hosts = p.buildHosts(currentEmail);
    setImapHost(hosts.imap_host);
    setImapPort(hosts.imap_port);
    setImapSecure(hosts.imap_secure);
    setSmtpHost(hosts.smtp_host);
    setSmtpPort(hosts.smtp_port);
    setSmtpSecure(hosts.smtp_secure);
  };

  const handleEmailChange = (v: string) => {
    setEmail(v);
    if (!username) setUsername(v);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/mail/accounts/test', {
        method: 'POST',
        body: JSON.stringify({
          imap_host: imapHost, imap_port: imapPort, imap_secure: imapSecure,
          smtp_host: smtpHost, smtp_port: smtpPort, smtp_secure: smtpSecure,
          username, password,
        }),
      });
      setTestResult(res);
      if (res.ok) toast.success('Connessione verificata');
      else toast.error('Controlla i campi — almeno uno fra IMAP/SMTP non risponde');
    } catch (err) {
      toast.error(`Errore test: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/mail/accounts', {
        method: 'POST',
        body: JSON.stringify({
          email,
          display_name: displayName || null,
          imap_host: imapHost, imap_port: imapPort, imap_secure: imapSecure,
          smtp_host: smtpHost, smtp_port: smtpPort, smtp_secure: smtpSecure,
          username, password,
        }),
      });
      toast.success('Account salvato');
      onSaved();
    } catch (err) {
      toast.error(`Errore salvataggio: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const canTest = email && username && password && imapHost && smtpHost;
  const canSave = canTest && testResult?.imap.ok && testResult?.smtp.ok;

  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="text-center mb-8">
        <div className="inline-flex h-12 w-12 rounded-full bg-primary/10 items-center justify-center mb-3">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-xl font-semibold">Collega la tua casella email</h2>
        <p className="text-sm text-muted-foreground mt-1">IMAP per ricezione + SMTP per invio. Le credenziali sono cifrate a riposo.</p>
      </div>

      {/* Preset chips */}
      <div className="rounded-lg border bg-card p-4 mb-4">
        <Label className="text-xs text-muted-foreground">Provider</Label>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mt-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p, email)}
              className={cn(
                'flex flex-col items-center justify-center rounded-md border px-3 py-2 text-xs transition-colors text-center w-full',
                preset.id === p.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
              )}
            >
              <span className="font-medium truncate w-full">{p.name}</span>
              {p.hint && <span className="text-[10px] text-muted-foreground mt-0.5 truncate w-full">{p.hint}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="tu@dominio.it"
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="display_name">Nome visualizzato</Label>
            <Input
              id="display_name"
              placeholder="Es. Federico Calicchia"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="username">Username (di solito = email)</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="App-password consigliata se 2FA"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 border-t">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Server className="h-4 w-4 text-muted-foreground" /> IMAP (ricezione)
            </div>
            <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="mail.dominio.it" />
            <div className="flex gap-2">
              <Input
                type="number" value={imapPort}
                onChange={(e) => setImapPort(parseInt(e.target.value, 10) || 993)}
                className="w-24"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={imapSecure} onCheckedChange={setImapSecure} />
                SSL
              </label>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Server className="h-4 w-4 text-muted-foreground" /> SMTP (invio)
            </div>
            <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="mail.dominio.it" />
            <div className="flex gap-2">
              <Input
                type="number" value={smtpPort}
                onChange={(e) => setSmtpPort(parseInt(e.target.value, 10) || 465)}
                className="w-24"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={smtpSecure} onCheckedChange={setSmtpSecure} />
                SSL
              </label>
            </div>
          </div>
        </div>

        {testResult && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-sm">
              {testResult.imap.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
              <span className="font-medium">IMAP</span>
              {testResult.imap.error && <span className="text-xs text-muted-foreground truncate">{testResult.imap.error}</span>}
            </div>
            <div className="flex items-center gap-2 text-sm">
              {testResult.smtp.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
              <span className="font-medium">SMTP</span>
              {testResult.smtp.error && <span className="text-xs text-muted-foreground truncate">{testResult.smtp.error}</span>}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" disabled={!canTest || testing} onClick={handleTest}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Prova connessione
          </Button>
          <Button disabled={!canSave || saving} onClick={handleSave}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Salva account
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground text-center mt-4">
        La password non viene mai mostrata al client una volta salvata. È cifrata AES-256-GCM nel DB usando <code>MAIL_ENC_KEY</code>.
      </p>
    </div>
  );
}
