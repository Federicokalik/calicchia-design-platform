import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { useTurnstile } from '@/hooks/use-turnstile';
import { API_BASE } from '@/lib/api';

const TURNSTILE_SITE_KEY = import.meta.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const PORTAL_URL = import.meta.env.VITE_PORTAL_URL || 'http://localhost:3000';

const loginSchema = z.object({
  email: z.string().email('Email non valida'),
  password: z.string().min(6, 'Password troppo corta'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next');
  const { signIn } = useAuth();
  const turnstile = useTurnstile(TURNSTILE_SITE_KEY, 'admin_login');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [rememberMe, setRememberMe] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/setup-status`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (data.needs_setup) navigate('/setup', { replace: true });
        else setCheckingSetup(false);
      })
      .catch(() => setCheckingSetup(false));
  }, [navigate]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormData) => {
    if (TURNSTILE_SITE_KEY && !turnstile.token) {
      toast.error(turnstile.error ?? 'Verifica anti-bot in corso. Attendi un istante e riprova.');
      return;
    }
    if (mfaRequired && !mfaCode.trim()) {
      toast.error('Inserisci il codice di autenticazione');
      return;
    }
    setIsLoading(true);
    try {
      const result = await signIn(
        data.email,
        data.password,
        turnstile.token,
        mfaRequired ? mfaCode.trim() : undefined,
        mfaRequired ? rememberMe : false,
      );
      if (result.mfaRequired) {
        // SEC-06 step 2: ask for the TOTP/backup code. The Turnstile token was
        // consumed by step 1 — reset to get a fresh one for the resubmit.
        setMfaRequired(true);
        turnstile.reset();
        toast.info("Inserisci il codice dell'app di autenticazione");
        setIsLoading(false);
        return;
      }
      toast.success('Login effettuato');
      // Audit D-009: harden against protocol-relative URLs ('//evil.com',
      // '/\\evil.com') which startsWith('/') alone would let through. Only
      // accept paths that start with a single '/' followed by anything other
      // than another '/' or a backslash.
      const safeNext = next && /^\/(?![/\\])/.test(next) ? next : '/';
      navigate(safeNext);
    } catch (error) {
      turnstile.reset();
      if (mfaRequired) setMfaCode('');
      toast.error(error instanceof Error ? error.message : 'Errore durante il login');
    } finally {
      setIsLoading(false);
    }
  };

  if (checkingSetup) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left — cover */}
      <div className="relative hidden lg:block">
        <img
          src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&auto=format&fit=crop&q=80"
          alt="Cover"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/40 to-black/20" />
        <div className="absolute inset-0 flex flex-col justify-between p-12">
          <div>
            <img
              src="/img/logo-white.png"
              alt="Calicchia Design"
              className="h-12 w-auto drop-shadow-lg"
            />
          </div>
          <div className="space-y-4">
            <blockquote className="text-white/90 text-lg leading-relaxed max-w-sm font-light">
              "Il design non è solo come appare. Il design è come funziona."
            </blockquote>
            <footer className="text-white/50 text-sm">— Steve Jobs</footer>
          </div>
        </div>
      </div>

      {/* Right — form */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-8">
          {/* Mobile logo */}
          <div className="lg:hidden flex justify-center">
            <img
              src="/img/logo.png"
              alt="Calicchia Design"
              className="h-10 w-auto"
            />
          </div>

          {/* Title */}
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Accedi</h1>
            <p className="text-muted-foreground text-sm">
              Inserisci le credenziali per accedere al pannello
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@example.com"
                autoComplete="email"
                {...register('email')}
              />
              {errors.email && (
                <p className="text-xs text-destructive">{errors.email.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                {...register('password')}
              />
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>

            {mfaRequired && (
              <div className="space-y-2">
                <Label htmlFor="mfa-code">Codice di autenticazione</Label>
                <Input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  autoFocus
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Codice a 6 cifre dell'app di autenticazione, oppure un codice di recupero.
                </p>
              </div>
            )}

            {mfaRequired && (
              <div className="flex items-start gap-3 rounded-md border border-border p-3">
                <Checkbox
                  id="remember-me"
                  checked={rememberMe}
                  onCheckedChange={(checked) => setRememberMe(checked === true)}
                />
                <div className="space-y-1 leading-none">
                  <Label htmlFor="remember-me" className="text-sm font-medium">
                    Ricordami su questo dispositivo
                  </Label>
                  <p className="text-xs text-muted-foreground">Mantiene l'accesso dopo la verifica 2FA.</p>
                </div>
              </div>
            )}

            {/* Cloudflare Turnstile — visible widget (appearance: always sul hook). */}
            <div ref={turnstile.containerRef} style={{ minWidth: 300 }} />
            {turnstile.error && (
              <p className="text-xs text-destructive">{turnstile.error}</p>
            )}

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isLoading ? 'Accesso in corso...' : mfaRequired ? 'Verifica codice' : 'Accedi'}
            </Button>
          </form>

          <div className="space-y-3 text-center">
            <p className="text-xs text-muted-foreground">
              Pannello amministrativo riservato
            </p>
            <a
              href={`${PORTAL_URL}/clienti/login`}
              className="inline-block text-xs text-primary hover:underline"
            >
              Accedi all'area clienti &rarr;
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
