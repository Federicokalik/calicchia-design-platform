import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, ArrowRight, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { API_BASE } from '@/lib/api';

const setupSchema = z.object({
  full_name: z.string().min(2, 'Inserisci il tuo nome'),
  email: z.string().email('Email non valida'),
  password: z.string().min(8, 'Minimo 8 caratteri'),
  password_confirm: z.string(),
}).refine((d) => d.password === d.password_confirm, {
  message: 'Le password non corrispondono',
  path: ['password_confirm'],
});

type SetupFormData = z.infer<typeof setupSchema>;

export default function SetupPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [setupBlocked, setSetupBlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/setup-status`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (!data.needs_setup) setSetupBlocked(true);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetupFormData>({
    resolver: zodResolver(setupSchema),
  });

  const onSubmit = async (data: SetupFormData) => {
    if (setupBlocked) return;
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.email,
          password: data.password,
          full_name: data.full_name,
        }),
        credentials: 'include',
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Errore durante la registrazione');

      toast.success('Account creato! Benvenuto.');
      navigate('/');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Errore');
    } finally {
      setIsLoading(false);
    }
  };

  if (checking) {
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
              "La semplicità è la sofisticatezza suprema."
            </blockquote>
            <footer className="text-white/50 text-sm">— Leonardo da Vinci</footer>
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

          {/* Header */}
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Configurazione iniziale</h1>
            <p className="text-muted-foreground text-sm">
              Crea il tuo account amministratore per iniziare
            </p>
          </div>

          {setupBlocked ? (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-4 rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center">
                <ShieldOff className="h-10 w-10 text-destructive/70" />
                <div className="space-y-1">
                  <p className="font-medium text-sm">Registrazione non disponibile</p>
                  <p className="text-xs text-muted-foreground">
                    Esiste già un account amministratore.<br />
                    Non è possibile crearne un altro.
                  </p>
                </div>
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link to="/login">
                  <ArrowRight className="mr-2 h-4 w-4" />
                  Vai al login
                </Link>
              </Button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="full_name">Nome completo</Label>
                  <Input
                    id="full_name"
                    placeholder="Mario Rossi"
                    autoComplete="name"
                    {...register('full_name')}
                  />
                  {errors.full_name && (
                    <p className="text-xs text-destructive">{errors.full_name.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="admin@tuodominio.it"
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
                    autoComplete="new-password"
                    {...register('password')}
                  />
                  {errors.password && (
                    <p className="text-xs text-destructive">{errors.password.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password_confirm">Conferma password</Label>
                  <Input
                    id="password_confirm"
                    type="password"
                    placeholder="••••••••"
                    autoComplete="new-password"
                    {...register('password_confirm')}
                  />
                  {errors.password_confirm && (
                    <p className="text-xs text-destructive">{errors.password_confirm.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="mr-2 h-4 w-4" />
                  )}
                  {isLoading ? 'Creazione account...' : 'Crea account e accedi'}
                </Button>
              </form>

              <p className="text-center text-xs text-muted-foreground">
                Questo passaggio è necessario solo la prima volta.
                <br />
                Dopo la configurazione accederai dal login standard.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
