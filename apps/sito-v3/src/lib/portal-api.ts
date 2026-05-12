import { cookies } from 'next/headers';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const PORTAL_PREFIX = `${API_BASE}/api/portal`;

export class PortalUnauthorizedError extends Error {
  constructor(public path: string) {
    super('Portal session unauthorized');
    this.name = 'PortalUnauthorizedError';
  }
}

export interface PortalCustomer {
  id: string;
  email: string;
  contact_name: string | null;
  company_name: string | null;
  portal_logo: string | null;
}

export interface PortalDashboardStats {
  active_projects: number;
  total_pending: number;
  open_invoices: number;
}

export interface PortalTimelineEvent {
  id: string;
  type: string;
  title: string;
  description: string | null;
  action_required?: boolean;
  action_type?: string | null;
  action_target_id?: string | null;
  is_read?: boolean;
  actor_type?: string | null;
  created_at: string;
  project_id?: string | null;
  project_name?: string | null;
}

export interface PortalDashboard {
  stats: PortalDashboardStats;
  pending_actions: PortalTimelineEvent[];
  recent_activity: PortalTimelineEvent[];
}

export interface PortalMilestone {
  id: string;
  name: string;
  description: string | null;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number | null;
}

export interface PortalDeliverableVersion {
  id: string;
  file_url: string | null;
  file_name: string | null;
  preview_url: string | null;
  version_number: number;
  is_current: boolean;
  notes: string | null;
  uploaded_at: string | null;
}

export interface PortalDeliverable {
  id: string;
  title: string;
  description: string | null;
  deliverable_type: string | null;
  status: string;
  revision_count: number;
  revision_limit: number | null;
  due_date: string | null;
  delivered_at: string | null;
  approved_at: string | null;
  versions: PortalDeliverableVersion[];
}

export interface PortalProject {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  progress_percentage: number | null;
  client_notes: string | null;
  project_type: string | null;
  staging_url: string | null;
  production_url?: string | null;
  pipeline_steps: string[] | null;
  current_step: string | null;
  start_date: string | null;
  target_end_date: string | null;
  actual_end_date?: string | null;
  company_name: string | null;
  contact_name: string | null;
  pending_deliverables?: number;
  unread_messages?: number;
  milestones?: PortalMilestone[];
  deliverables?: PortalDeliverable[];
}

export interface PortalReport {
  id: string;
  title: string;
  month: number;
  year: number;
  summary: string | null;
  data?: PortalReportData | null;
  pdf_url: string | null;
  published_at: string | null;
  project_id: string | null;
  project_name: string | null;
}

export interface PortalReportMetric {
  label: string;
  value: string | number;
  previous?: string | number | null;
  delta?: string | number | null;
}

export interface PortalReportSection {
  title: string;
  body?: string;
  rows?: Array<Record<string, string | number | null>>;
}

export interface PortalReportData {
  metrics?: PortalReportMetric[];
  sections?: PortalReportSection[];
  rows?: Array<Record<string, string | number | null>>;
  [key: string]: unknown;
}

export interface PortalFile {
  id: string;
  key: string;
  original_name: string;
  content_type: string;
  size: number;
  status: string;
  project_id: string | null;
  uploaded_at: string;
  project_name: string | null;
}

export function getMediaUrl(key: string): string {
  return `${API_BASE}/media/${key}`;
}

export interface PortalInvoice {
  id: string;
  invoice_number: string;
  status: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  issue_date: string | null;
  due_date: string | null;
  paid_at?: string | null;
  payment_status: string | null;
  line_items: unknown;
  notes?: string | null;
  stripe_hosted_invoice_url: string | null;
  stripe_invoice_pdf: string | null;
}

export interface PortalInvoiceLineItem {
  description: string;
  quantity?: number;
  unit_price?: number;
  total?: number;
  [key: string]: unknown;
}

export type PortalPaymentProvider = 'stripe' | 'paypal' | 'revolut' | 'bank_transfer';

export interface PortalPaymentLink {
  id: string;
  provider: PortalPaymentProvider;
  checkout_url: string | null;
  status: 'pending' | 'active' | 'paid' | 'expired' | 'cancelled' | 'refunded' | 'partially_refunded';
  amount: number;
  currency: string;
}

export interface PortalPaymentSchedule {
  id: string;
  title: string;
  schedule_type: 'deposit' | 'milestone' | 'balance' | 'installment';
  amount: number;
  currency: string;
  due_date: string | null;
  status: 'pending' | 'due' | 'paid' | 'partial' | 'overdue' | 'cancelled';
  paid_amount: number;
  paid_at: string | null;
  project: { id: string | null; name: string | null } | null;
  quote: { id: string | null; quote_number: string | null; title: string | null } | null;
  payment_links: PortalPaymentLink[];
}

export interface PortalSubscription {
  id: string;
  provider: 'stripe' | 'paypal';
  name: string;
  amount: number;
  currency: string;
  billing_interval: 'month' | 'year' | string;
  status: string;
  start_date: string | null;
  current_period_end: string | null;
  next_billing_date: string | null;
  canceled_at: string | null;
  auto_renew: boolean;
}

export interface PortalInvoiceTotals {
  total_paid: number;
  total_pending: number;
}

export interface PortalRenewal {
  id: string;
  name: string;
  description: string | null;
  amount: number | null;
  currency: string | null;
  billing_interval: string;
  status: string;
  auto_renew: boolean;
  next_billing_date: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  renewal_type: 'subscription' | 'domain';
  ssl_status?: string | null;
  ssl_expiration?: string | null;
  registrar?: string | null;
}

export interface PortalMessage {
  id: string;
  project_id?: string;
  content: string;
  sender_name: string;
  sender_type: 'client' | 'admin';
  is_internal?: boolean;
  attachments?: unknown;
  created_at: string;
  updated_at?: string | null;
}

interface PortalListResponse<T, K extends string> {
  [key: string]: T[] | unknown;
}

async function authedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const headers = new Headers(init.headers);

  if (!headers.has('Content-Type') && init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (cookieHeader) headers.set('Cookie', cookieHeader);

  const res = await fetch(`${PORTAL_PREFIX}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (res.status === 401) throw new PortalUnauthorizedError(path);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Portal API ${path} returned ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function authedFetchNullable<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  try {
    return await authedFetch<T>(path, init);
  } catch (error) {
    if (error instanceof Error && error.message.includes(' returned 404:')) return null;
    throw error;
  }
}

export async function getCustomer(): Promise<PortalCustomer | null> {
  const data = await authedFetchNullable<{ customer: PortalCustomer }>('/me');
  return data?.customer ?? null;
}

export async function getDashboard(): Promise<PortalDashboard> {
  return authedFetch<PortalDashboard>('/dashboard');
}

export async function getProjects(): Promise<PortalProject[]> {
  const data = await authedFetch<PortalListResponse<PortalProject, 'projects'>>('/projects');
  return (data.projects as PortalProject[]) ?? [];
}

export async function getProject(id: string): Promise<PortalProject | null> {
  const data = await authedFetchNullable<{
    project: PortalProject;
    milestones: PortalMilestone[];
    deliverables: PortalDeliverable[];
  }>(`/projects/${encodeURIComponent(id)}`);
  if (!data) return null;
  return {
    ...data.project,
    milestones: data.milestones,
    deliverables: data.deliverables,
  };
}

export async function getReports(): Promise<PortalReport[]> {
  const data = await authedFetch<PortalListResponse<PortalReport, 'reports'>>('/reports');
  return (data.reports as PortalReport[]) ?? [];
}

export async function getReport(id: string): Promise<PortalReport | null> {
  const data = await authedFetchNullable<{ report: PortalReport }>(
    `/reports/${encodeURIComponent(id)}`
  );
  return data?.report ?? null;
}

export async function getFiles(): Promise<PortalFile[]> {
  const data = await authedFetch<PortalListResponse<PortalFile, 'files'>>('/files');
  return (data.files as PortalFile[]) ?? [];
}

export async function uploadFile(formData: FormData): Promise<{ id: string; key: string; url: string }> {
  const file = formData.get('file');
  const projectId = String(formData.get('projectId') ?? '').trim();

  if (!(file instanceof File)) {
    throw new Error('Seleziona un file da caricare.');
  }

  const init = await authedFetch<{
    uploadId: string;
    key: string;
    totalParts: number;
    chunkSize: number;
    dbId: string;
  }>('/upload/init', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type || 'application/octet-stream',
      projectId: projectId || undefined,
    }),
  });

  const parts: Array<{ PartNumber: number; ETag: string }> = [];

  try {
    for (let partNumber = 1; partNumber <= init.totalParts; partNumber += 1) {
      const start = (partNumber - 1) * init.chunkSize;
      const end = Math.min(start + init.chunkSize, file.size);
      const { url } = await authedFetch<{ url: string; partNumber: number; expiresIn: number }>(
        '/upload/url',
        {
          method: 'POST',
          body: JSON.stringify({
            uploadId: init.uploadId,
            key: init.key,
            partNumber,
          }),
        }
      );

      const uploadRes = await fetch(url, {
        method: 'PUT',
        body: file.slice(start, end),
        cache: 'no-store',
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload part ${partNumber} failed with ${uploadRes.status}`);
      }

      const etag = uploadRes.headers.get('ETag') ?? uploadRes.headers.get('etag');
      if (!etag) throw new Error(`Upload part ${partNumber} did not return an ETag`);
      parts.push({ PartNumber: partNumber, ETag: etag });
    }

    const done = await authedFetch<{ ok: true; id: string; key: string }>('/upload/done', {
      method: 'POST',
      body: JSON.stringify({
        uploadId: init.uploadId,
        key: init.key,
        parts,
      }),
    });

    return { id: done.id, key: done.key, url: getMediaUrl(done.key) };
  } catch (error) {
    await authedFetch('/upload/abort', {
      method: 'POST',
      body: JSON.stringify({ uploadId: init.uploadId, key: init.key }),
    }).catch(() => undefined);
    throw error;
  }
}

export async function getInvoices(): Promise<PortalInvoice[]> {
  const data = await authedFetch<{
    invoices: PortalInvoice[];
    totals: PortalInvoiceTotals;
  }>('/invoices');
  return data.invoices;
}

export async function getInvoiceTotals(): Promise<PortalInvoiceTotals> {
  const data = await authedFetch<{
    invoices: PortalInvoice[];
    totals: PortalInvoiceTotals;
  }>('/invoices');
  return data.totals;
}

export async function getInvoice(id: string): Promise<PortalInvoice | null> {
  const data = await authedFetchNullable<{ invoice: PortalInvoice }>(
    `/invoices/${encodeURIComponent(id)}`,
  );
  return data?.invoice ?? null;
}

export async function getPaymentSchedules(projectId?: string): Promise<PortalPaymentSchedule[]> {
  const path = projectId ? `/invoices/payments?project_id=${encodeURIComponent(projectId)}` : '/invoices/payments';
  const data = await authedFetch<{ schedules: PortalPaymentSchedule[] }>(path);
  return data.schedules ?? [];
}

export async function getSubscriptions(): Promise<PortalSubscription[]> {
  // Mounted under /invoices in apps/api/src/routes/portal/index.ts
  const data = await authedFetch<{ subscriptions: PortalSubscription[] }>('/invoices/subscriptions');
  return data.subscriptions ?? [];
}

/**
 * Create a payment link for the given schedule. Returns the checkout_url to redirect to.
 * The portal route handler validates that the schedule belongs to the current customer.
 */
export async function startPayment(
  scheduleId: string,
  provider: 'stripe' | 'paypal',
): Promise<{ checkout_url: string; link_id: string }> {
  const data = await authedFetch<{ checkout_url: string; link_id: string }>(
    '/invoices/pay',
    {
      method: 'POST',
      body: JSON.stringify({ schedule_id: scheduleId, provider }),
    },
  );
  return data;
}

/**
 * Capture PayPal order after the user returns from the approve URL.
 * Idempotent — safe to retry.
 */
export async function capturePaypalReturn(linkId: string): Promise<{
  captured: boolean;
  alreadyProcessed?: boolean;
}> {
  return authedFetch(`/invoices/paypal-capture/${encodeURIComponent(linkId)}`, {
    method: 'POST',
  });
}

export async function getRenewals(): Promise<PortalRenewal[]> {
  const data = await authedFetch<PortalListResponse<PortalRenewal, 'renewals'>>('/renewals');
  return (data.renewals as PortalRenewal[]) ?? [];
}

export async function getMessages(projectId: string): Promise<PortalMessage[]> {
  const data = await authedFetch<PortalListResponse<PortalMessage, 'messages'>>(
    `/projects/${encodeURIComponent(projectId)}/messages`
  );
  return (data.messages as PortalMessage[]) ?? [];
}

export async function postMessage(projectId: string, body: string): Promise<PortalMessage> {
  const data = await authedFetch<{ message: PortalMessage }>(
    `/projects/${encodeURIComponent(projectId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ content: body }),
    }
  );
  return { ...data.message, project_id: projectId };
}

export async function approveDeliverable(deliverableId: string): Promise<void> {
  await authedFetch(`/deliverables/${encodeURIComponent(deliverableId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ comment: '' }),
  });
}

export async function requestRevisions(deliverableId: string, notes: string): Promise<void> {
  await authedFetch(`/deliverables/${encodeURIComponent(deliverableId)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ comment: notes }),
  });
}
