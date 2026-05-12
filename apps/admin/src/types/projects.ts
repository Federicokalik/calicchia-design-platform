// Types for Client Project Management (Kanban)
// Based on database/migrations/009_client_projects.sql

export type ProjectType = 'website' | 'landing_page' | 'ecommerce' | 'maintenance' | 'website_template' | 'consulting' | 'other';
export type ProjectCategory = 'grafica' | 'web' | 'ecommerce' | 'webapp' | 'marketing' | 'consulenza';
export type ProjectStatus = 'draft' | 'proposal' | 'approved' | 'in_progress' | 'review' | 'completed' | 'on_hold' | 'cancelled';
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface ClientProject {
  id: string;
  customer_id: string;
  collaborator_id: string | null;
  assigned_to: string | null;
  subscription_id: string | null;
  name: string;
  description: string | null;
  project_type: ProjectType;
  project_category: ProjectCategory | null;
  status: ProjectStatus;
  priority: number;
  start_date: string | null;
  target_end_date: string | null;
  actual_end_date: string | null;
  budget_amount: number | null;
  estimated_hours: number | null;
  actual_hours: number;
  hourly_rate: number | null;
  currency: string;
  staging_url: string | null;
  production_url: string | null;
  repo_url: string | null;
  figma_url: string | null;
  progress_percentage: number;
  visible_to_client: boolean;
  client_notes: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// View with computed stats
export interface ClientProjectView extends ClientProject {
  customer_name: string | null;
  customer_company: string | null;
  customer_email: string | null;
  assignee_email: string | null;
  collaborator_name: string | null;
  collaborator_company: string | null;
  collaborator_email: string | null;
  total_tasks: number;
  completed_tasks: number;
  total_milestones: number;
  completed_milestones: number;
  is_overdue: boolean;
}

export interface ProjectTask {
  id: string;
  project_id: string;
  milestone_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  assigned_to: string | null;
  due_date: string | null;
  estimated_hours: number | null;
  actual_hours: number;
  checklist: ChecklistItem[];
  visible_to_client: boolean;
  sort_order: number;
  tags: string[];
  source: 'admin' | 'client';
  request_category: 'bug' | 'feature' | 'change' | 'support' | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields (optional, from API)
  assignee_email?: string;
  milestone_name?: string;
  project_name?: string;
  customer_name?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ProjectMilestone {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  due_date: string | null;
  completed_at: string | null;
  status: MilestoneStatus;
  sort_order: number;
  visible_to_client: boolean;
  deliverables: MilestoneDeliverable[];
  created_at: string;
  updated_at: string;
}

export interface MilestoneDeliverable {
  id: string;
  name: string;
  done: boolean;
}

export interface TimeEntry {
  id: string;
  project_id: string;
  task_id: string | null;
  user_id: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  description: string | null;
  is_billable: boolean;
  is_billed: boolean;
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  project_name?: string;
  task_title?: string;
  user_email?: string;
  customer_name?: string;
}

export interface ProjectComment {
  id: string;
  project_id: string;
  task_id: string | null;
  user_id: string;
  content: string;
  is_internal: boolean;
  attachments: CommentAttachment[];
  created_at: string;
  updated_at: string;
  // Joined
  user_email?: string;
}

export interface CommentAttachment {
  url: string;
  name: string;
  type: string;
  size: number;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  task_id: string | null;
  uploaded_by: string | null;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  category: 'general' | 'design' | 'document' | 'asset' | 'deliverable';
  visible_to_client: boolean;
  created_at: string;
}

// API response types
export interface ClientProjectsResponse {
  projects: ClientProjectView[];
  count: number;
  stats: {
    total: number;
    in_progress: number;
    completed: number;
    overdue: number;
  };
}

export interface ProjectDetailResponse {
  project: ClientProjectView;
  tasks: ProjectTask[];
  milestones: ProjectMilestone[];
}

// Kanban board types
export interface KanbanColumn {
  id: TaskStatus;
  title: string;
  color: string;
  tasks: ProjectTask[];
}

export const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bgColor: string }> = {
  todo: { label: 'Da fare', color: 'text-slate-600', bgColor: 'bg-slate-100 dark:bg-slate-800' },
  in_progress: { label: 'In corso', color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  review: { label: 'In revisione', color: 'text-amber-600', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
  done: { label: 'Completato', color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/30' },
  blocked: { label: 'Bloccato', color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-900/30' },
};

export const PROJECT_STATUS_CONFIG: Record<ProjectStatus, { label: string; color: string }> = {
  draft: { label: 'Bozza', color: 'bg-slate-100 text-slate-700' },
  proposal: { label: 'Proposta', color: 'bg-purple-100 text-purple-700' },
  approved: { label: 'Approvato', color: 'bg-blue-100 text-blue-700' },
  in_progress: { label: 'In corso', color: 'bg-amber-100 text-amber-700' },
  review: { label: 'In revisione', color: 'bg-orange-100 text-orange-700' },
  completed: { label: 'Completato', color: 'bg-green-100 text-green-700' },
  on_hold: { label: 'In pausa', color: 'bg-gray-100 text-gray-700' },
  cancelled: { label: 'Annullato', color: 'bg-red-100 text-red-700' },
};

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  website: 'Sito Web',
  landing_page: 'Landing Page',
  ecommerce: 'E-Commerce',
  maintenance: 'Manutenzione',
  website_template: 'Template sito',
  consulting: 'Consulenza',
  other: 'Altro',
};

export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  grafica: 'Grafica & Design',
  web: 'Siti Web',
  ecommerce: 'E-Commerce',
  webapp: 'Web App',
  marketing: 'Marketing & Campagne',
  consulenza: 'Consulenza & Strategia',
};

export const PROJECT_CATEGORY_COLORS: Record<ProjectCategory, string> = {
  grafica: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
  web: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  ecommerce: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  webapp: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  marketing: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  consulenza: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
};

export type RequestCategory = 'bug' | 'feature' | 'change' | 'support';
export type TaskSource = 'admin' | 'client';

export const REQUEST_CATEGORY_CONFIG: Record<RequestCategory, { label: string; color: string; bgColor: string }> = {
  bug: { label: 'Bug', color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-900/30' },
  feature: { label: 'Funzionalità', color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  change: { label: 'Modifica', color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  support: { label: 'Supporto', color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-900/30' },
};

export const SOURCE_CONFIG: Record<TaskSource, { label: string; color: string; bgColor: string }> = {
  admin: { label: 'Admin', color: 'text-slate-600', bgColor: 'bg-slate-100 dark:bg-slate-800' },
  client: { label: 'Cliente', color: 'text-amber-600', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
};
