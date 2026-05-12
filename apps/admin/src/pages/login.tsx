import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { API_BASE } from '@/lib/api';

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
    setIsLoading(true);
    try {
      await signIn(data.email, data.password);
      toast.success('Login effettuato');
      navigate(next && next.startsWith('/') ? next : '/');
    } catch (error) {
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

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isLoading ? 'Accesso in corso...' : 'Accedi'}
            </Button>
          </form>

          <div className="space-y-3 text-center">
            <p className="text-xs text-muted-foreground">
              Pannello amministrativo riservato
            </p>
            <a
              href="/clienti/login"
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
