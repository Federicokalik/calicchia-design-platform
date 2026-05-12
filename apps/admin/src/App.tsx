import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { AppLayout } from '@/components/layout/app-layout';
import { useI18n } from '@/hooks/use-i18n';
import { localizeAdminPath } from '@/lib/admin-routes';

// Auth pages
import LoginPage from '@/pages/login';
import SetupPage from '@/pages/setup';
import QuoteSignPage from '@/pages/preventivi/sign';

// Main pages
import DashboardPage from '@/pages/dashboard';
import OggiPage from '@/pages/oggi';
import PostaPage from '@/pages/posta';
import PipelinePage from '@/pages/pipeline';
import ClientiPage from '@/pages/clienti';
import ClienteDetailPage from '@/pages/clienti/detail';
import ProgettiPage from '@/pages/progetti';
import ProgettoDetailPage from '@/pages/progetti/detail';
import CalendarioPage from '@/pages/calendario';
import EventTypesPage from '@/pages/calendario/event-types';
import EventTypeEditPage from '@/pages/calendario/event-type-edit';
import DisponibilitaPage from '@/pages/calendario/disponibilita';
import PrenotazioniPage from '@/pages/calendario/prenotazioni';
import CalendariPage from '@/pages/calendario/calendari';

// Content pages
import BlogPage from '@/pages/blog';
import BlogEditPage from '@/pages/blog/edit';
import BlogAIGeneratorPage from '@/pages/blog/ai-generator';
import PortfolioPage from '@/pages/portfolio';
import PortfolioEditorPage from '@/pages/portfolio/edit';

// Collaboratori
import CollaboratoriPage from '@/pages/collaboratori';
import CollaboratoreDetailPage from '@/pages/collaboratori/detail';

// Preventivi
import PreventiviPage from '@/pages/preventivi';
import PreventivoEditorPage from '@/pages/preventivi/edit';
import PreventivoDetailPage from '@/pages/preventivi/detail';

// Workflows
import WorkflowsPage from '@/pages/workflows';
import WorkflowEditorPage from '@/pages/workflows/editor';

// Second Brain & Knowledge
import BrainPage from '@/pages/brain';
import NotesPage from '@/pages/notes';
import NoteEditorPage from '@/pages/notes/edit';
import BoardListPage from '@/pages/boards/list';
import SketchEditorPage from '@/pages/boards/sketch';
import MindMapEditorPage from '@/pages/boards/mindmap';

// Tool pages
import DominiPage from '@/pages/domini';
import FatturazionePage from '@/pages/fatturazione';
import ServiziPage from '@/pages/servizi';
import AnalyticsPage from '@/pages/analytics';
import ImpostazioniPage from '@/pages/impostazioni';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function LocalizedRouteSync() {
  const { locale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const current = `${location.pathname}${location.search}${location.hash}`;
    const next = localizeAdminPath(current, locale);
    if (next !== current) navigate(next, { replace: true });
  }, [locale, location.hash, location.pathname, location.search, navigate]);

  return null;
}

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/firma/:token" element={<QuoteSignPage />} />

      {/* Protected — AppLayout with sidebar */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <LocalizedRouteSync />
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="oggi" element={<OggiPage />} />
        <Route path="today" element={<OggiPage />} />
        <Route path="posta" element={<PostaPage />} />
        <Route path="mail" element={<PostaPage />} />

        {/* CRM */}
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="clienti" element={<ClientiPage />} />
        <Route path="clienti/:id" element={<ClienteDetailPage />} />
        <Route path="clients" element={<ClientiPage />} />
        <Route path="clients/:id" element={<ClienteDetailPage />} />

        {/* Collaboratori */}
        <Route path="collaboratori" element={<CollaboratoriPage />} />
        <Route path="collaboratori/:id" element={<CollaboratoreDetailPage />} />
        <Route path="collaborators" element={<CollaboratoriPage />} />
        <Route path="collaborators/:id" element={<CollaboratoreDetailPage />} />

        {/* Preventivi */}
        <Route path="preventivi" element={<PreventiviPage />} />
        <Route path="preventivi/new" element={<PreventivoEditorPage />} />
        <Route path="preventivi/:id" element={<PreventivoDetailPage />} />
        <Route path="preventivi/:id/edit" element={<PreventivoEditorPage />} />
        <Route path="quotes" element={<PreventiviPage />} />
        <Route path="quotes/new" element={<PreventivoEditorPage />} />
        <Route path="quotes/:id" element={<PreventivoDetailPage />} />
        <Route path="quotes/:id/edit" element={<PreventivoEditorPage />} />

        {/* Projects */}
        <Route path="progetti" element={<ProgettiPage />} />
        <Route path="progetti/:id" element={<ProgettoDetailPage />} />
        <Route path="projects" element={<ProgettiPage />} />
        <Route path="projects/:id" element={<ProgettoDetailPage />} />

        {/* Calendar */}
        <Route path="calendario" element={<CalendarioPage />} />
        <Route path="calendario/calendari" element={<CalendariPage />} />
        <Route path="calendario/prenotazioni" element={<PrenotazioniPage />} />
        <Route path="calendario/event-types" element={<EventTypesPage />} />
        <Route path="calendario/event-types/:id" element={<EventTypeEditPage />} />
        <Route path="calendario/disponibilita" element={<DisponibilitaPage />} />
        <Route path="calendar" element={<CalendarioPage />} />
        <Route path="calendar/calendars" element={<CalendariPage />} />
        <Route path="calendar/bookings" element={<PrenotazioniPage />} />
        <Route path="calendar/event-types" element={<EventTypesPage />} />
        <Route path="calendar/event-types/:id" element={<EventTypeEditPage />} />
        <Route path="calendar/availability" element={<DisponibilitaPage />} />

        {/* Content */}
        <Route path="blog" element={<BlogPage />} />
        <Route path="blog/new" element={<BlogEditPage />} />
        <Route path="blog/:id" element={<BlogEditPage />} />
        <Route path="blog/ai" element={<BlogAIGeneratorPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="portfolio/new" element={<PortfolioEditorPage />} />
        <Route path="portfolio/:id" element={<PortfolioEditorPage />} />

        {/* Second Brain & Knowledge */}
        <Route path="brain" element={<BrainPage />} />
        <Route path="second-brain" element={<BrainPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="notes/:id" element={<NoteEditorPage />} />
        <Route path="boards/sketch" element={<BoardListPage type="sketch" />} />
        <Route path="boards/sketch/:id" element={<SketchEditorPage />} />
        <Route path="boards/mindmap" element={<BoardListPage type="mindmap" />} />
        <Route path="boards/mindmap/:id" element={<MindMapEditorPage />} />
        <Route path="boards/mind-maps" element={<BoardListPage type="mindmap" />} />
        <Route path="boards/mind-maps/:id" element={<MindMapEditorPage />} />

        {/* Workflows */}
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="workflows/:id" element={<WorkflowEditorPage />} />

        {/* Tools */}
        <Route path="domini" element={<DominiPage />} />
        <Route path="fatturazione" element={<FatturazionePage />} />
        <Route path="servizi" element={<ServiziPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="impostazioni" element={<ImpostazioniPage />} />
        <Route path="domains" element={<DominiPage />} />
        <Route path="billing" element={<FatturazionePage />} />
        <Route path="services" element={<ServiziPage />} />
        <Route path="settings" element={<ImpostazioniPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
