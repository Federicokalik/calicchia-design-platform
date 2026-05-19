import { Hono } from 'hono';
import { authRoutes, type PortalEnv } from './auth';
import { dashboardRoutes } from './dashboard';
import { projectsRoutes } from './projects';
import { timelineRoutes } from './timeline';
import { deliverableRoutes } from './deliverables';
import { messagesRoutes } from './messages';
import { uploadRoutes } from './upload';
import { filesRoutes } from './files';
import { invoicesRoutes } from './invoices';
import { renewalsRoutes } from './renewals';
import { reportsRoutes } from './reports';
import { preferencesRoutes } from './preferences';

export const portal = new Hono<PortalEnv>();

// Auth routes (login, logout, me)
portal.route('/', authRoutes);

// Dashboard
portal.route('/dashboard', dashboardRoutes);

// Projects
portal.route('/projects', projectsRoutes);

// Timeline (mounted at root because paths include /projects/:id/timeline)
portal.route('/', timelineRoutes);

// Deliverables actions
portal.route('/', deliverableRoutes);

// Messages (mounted at root because paths include /projects/:id/messages)
portal.route('/', messagesRoutes);

// Upload
portal.route('/upload', uploadRoutes);

// Files
portal.route('/files', filesRoutes);

// Invoices & Payments
portal.route('/invoices', invoicesRoutes);

// Renewals
portal.route('/renewals', renewalsRoutes);

// Reports
portal.route('/reports', reportsRoutes);

// Communication preferences (opt-in/opt-out per canale e categoria)
portal.route('/preferences', preferencesRoutes);
