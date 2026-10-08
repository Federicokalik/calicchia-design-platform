import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/hooks/use-theme';
import { I18nProvider } from '@/hooks/use-i18n';
import { ConfirmProvider } from '@/hooks/use-confirm';
import { bugsink } from '@/lib/bugsink';
import { refreshAllQueries } from '@/lib/query-refresh';
import App from './App';
import './index.css';
import './styles/whatsapp.css';

// Initialize Bugsink error tracking
bugsink.init({
  dsn: import.meta.env.VITE_BUGSINK_DSN || import.meta.env.PUBLIC_BUGSINK_DSN || '',
  enabled: true,
  release: 'admin@1.0.0',
});

const queryClient = new QueryClient({
  // Dopo ogni mutation riuscita tutte le query diventano stale e quelle a
  // schermo vengono rifatte. Le invalidazioni scritte a mano pagina per pagina
  // lasciavano indietro le viste collegate (dashboard, Oggi, calendario, pannelli
  // del dettaglio…) finché non si ricaricava la pagina. Le invalidazioni locali
  // restano valide ma non sono più l'unica rete di sicurezza.
  // Opt-out: `meta: { skipGlobalInvalidation: true }` sulle mutation di autosave
  // (tengono la propria cache allineata con setQueryData) e
  // `meta: { skipGlobalRefetch: true }` sulle query costose o con effetti esterni.
  mutationCache: new MutationCache({
    onSuccess: (_data, _variables, _context, mutation) => {
      if (mutation.meta?.skipGlobalInvalidation) return;
      void refreshAllQueries(queryClient);
    },
    // Molte mutation non hanno onError: un salvataggio fallito (409, 400, 500)
    // passava in silenzio e sembrava riuscito. Quelle con un proprio onError
    // mostrano già il loro messaggio.
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError) return;
      toast.error(error instanceof Error && error.message ? error.message : 'Operazione non riuscita');
    },
  }),
  defaultOptions: {
    queries: {
      // 30s: navigando o tornando sulla scheda i dati cambiati altrove (cron,
      // webhook, portale clienti, altri dispositivi) si aggiornano da soli.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <ConfirmProvider>
            <BrowserRouter>
              <Sentry.ErrorBoundary fallback={<div role="alert">Errore applicazione.</div>}>
                <App />
              </Sentry.ErrorBoundary>
              <Toaster richColors position="top-right" />
            </BrowserRouter>
          </ConfirmProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>
);
