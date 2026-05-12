import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/hooks/use-theme';
import { I18nProvider } from '@/hooks/use-i18n';
import { bugsink } from '@/lib/bugsink';
import App from './App';
import './index.css';

// Initialize Bugsink error tracking
bugsink.init({
  dsn: import.meta.env.VITE_BUGSINK_DSN || import.meta.env.PUBLIC_BUGSINK_DSN || '',
  enabled: true,
  release: 'admin@1.0.0',
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Sentry.ErrorBoundary fallback={<div role="alert">Errore applicazione.</div>}>
              <App />
            </Sentry.ErrorBoundary>
            <Toaster richColors position="top-right" />
          </BrowserRouter>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>
);
