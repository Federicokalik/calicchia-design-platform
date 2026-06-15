// Mirrors the marketing_campaigns / campaign_assets / campaign_reports schema
// (database/migrations/033 + 132). UI language is Italian; identifiers English.

export type CampaignType =
  | 'brand_identity' | 'social_media' | 'email_marketing' | 'seo_sem'
  | 'content_marketing' | 'video' | 'print' | 'event' | 'other';

export type CampaignChannel =
  | 'instagram' | 'facebook' | 'linkedin' | 'tiktok' | 'google'
  | 'email' | 'youtube' | 'print' | 'multi' | 'other';

export type CampaignStatus =
  | 'brief' | 'planning' | 'creative' | 'review' | 'approved'
  | 'active' | 'paused' | 'completed' | 'cancelled';

export type AssetType = 'image' | 'video' | 'copy' | 'graphic' | 'document' | 'audio' | 'other';
export type AssetStatus = 'draft' | 'in_progress' | 'review' | 'approved' | 'rejected' | 'published';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revision_requested';
export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'final';

export interface Campaign {
  id: string;
  project_id: string | null;
  customer_id: string | null;
  quote_id: string | null;
  campaign_name: string;
  campaign_type: CampaignType;
  channel: CampaignChannel;
  status: CampaignStatus;
  budget_planned: number | string | null;
  budget_actual: number | string | null;
  currency: string;
  kpi_target: Record<string, number | string>;
  kpi_actual: Record<string, number | string>;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  objective: string | null;
  target_audience: string | null;
  created_at: string;
  updated_at: string;
  // joined fields
  project_name?: string | null;
  resolved_customer_id?: string | null;
  customer_name?: string | null;
  customer_company?: string | null;
  asset_count?: number;
  pending_approval_count?: number;
  assets?: CampaignAsset[] | null;
  last_report?: { report_date: string; metrics_json: Record<string, unknown>; summary: string | null } | null;
}

export interface CampaignAsset {
  id: string;
  campaign_id: string;
  asset_type: AssetType;
  asset_name: string;
  file_url: string | null;
  status: AssetStatus;
  approval_status: ApprovalStatus;
  version: number;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignReport {
  id: string;
  campaign_id: string;
  report_date: string;
  report_period: ReportPeriod;
  metrics_json: Record<string, number | string>;
  summary: string | null;
  created_at: string;
}

export interface CampaignAssetFeedback {
  id: string;
  asset_id: string;
  author_type: 'client' | 'freelancer';
  author_name: string | null;
  feedback_text: string;
  feedback_type: 'revision' | 'approval' | 'comment';
  is_resolved: boolean;
  created_at: string;
}

export const CAMPAIGN_TYPE_LABELS: Record<CampaignType, string> = {
  brand_identity: 'Brand Identity',
  social_media: 'Social Media',
  email_marketing: 'Email Marketing',
  seo_sem: 'SEO / SEM',
  content_marketing: 'Content Marketing',
  video: 'Video',
  print: 'Print',
  event: 'Evento',
  other: 'Altro',
};

export const CAMPAIGN_CHANNEL_LABELS: Record<CampaignChannel, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  google: 'Google',
  email: 'Email',
  youtube: 'YouTube',
  print: 'Print',
  multi: 'Multi-canale',
  other: 'Altro',
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  brief: 'Brief',
  planning: 'Pianificazione',
  creative: 'Creatività',
  review: 'Revisione',
  approved: 'Approvata',
  active: 'Attiva',
  paused: 'In pausa',
  completed: 'Completata',
  cancelled: 'Annullata',
};

// Ordered list of statuses for the kanban columns.
export const CAMPAIGN_STATUS_ORDER: CampaignStatus[] = [
  'brief', 'planning', 'creative', 'review', 'approved', 'active', 'paused', 'completed', 'cancelled',
];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  image: 'Immagine',
  video: 'Video',
  copy: 'Copy',
  graphic: 'Grafica',
  document: 'Documento',
  audio: 'Audio',
  other: 'Altro',
};

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  draft: 'Bozza',
  in_progress: 'In lavorazione',
  review: 'In revisione',
  approved: 'Approvato',
  rejected: 'Rifiutato',
  published: 'Pubblicato',
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'In attesa',
  approved: 'Approvato',
  rejected: 'Rifiutato',
  revision_requested: 'Revisione richiesta',
};
