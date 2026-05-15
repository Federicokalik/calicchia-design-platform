export type LeadStatus = 'new' | 'contacted' | 'proposal' | 'negotiation' | 'won' | 'lost';
export type LeadSource = 'manual' | 'website_form' | 'calcom' | 'referral';

export interface Lead {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: LeadSource;
  source_id: string | null;
  status: LeadStatus;
  estimated_value: number | null;
  notes: string | null;
  tags: string[];
  lost_reason: string | null;
  converted_customer_id: string | null;
  converted_project_id: string | null;
  created_at: string;
  updated_at: string;
}

export const LEAD_STATUS_CONFIG: Record<LeadStatus, { label: string; labelKey: string; color: string; bgColor: string }> = {
  new: { label: 'Nuovo', labelKey: 'lead.status.new', color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  contacted: { label: 'Contattato', labelKey: 'lead.status.contacted', color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  proposal: { label: 'Proposta', labelKey: 'lead.status.proposal', color: 'text-amber-600', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
  negotiation: { label: 'Negoziazione', labelKey: 'lead.status.negotiation', color: 'text-purple-600', bgColor: 'bg-purple-100 dark:bg-purple-900/30' },
  won: { label: 'Vinto', labelKey: 'lead.status.won', color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  lost: { label: 'Perso', labelKey: 'lead.status.lost', color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-900/30' },
};

export interface LeadSourceConfig { label: string; labelKey: string; color: string }

export const LEAD_SOURCE_CONFIG: Record<LeadSource, LeadSourceConfig> = {
  manual: { label: 'Manuale', labelKey: 'lead.source.manual', color: 'text-slate-500' },
  website_form: { label: 'Form Sito', labelKey: 'lead.source.website_form', color: 'text-blue-500' },
  calcom: { label: 'Cal.com', labelKey: 'lead.source.calcom', color: 'text-violet-500' },
  referral: { label: 'Referral', labelKey: 'lead.source.referral', color: 'text-emerald-500' },
};

// The DB schema stores `source` as free-text (no CHECK constraint), and several
// API routes write values not in LEAD_SOURCE_CONFIG: 'booking_<slug>' from
// calendar/public, 'embed_form' from public-leads. Bucket those into the
// closest known config; fall back to a neutral chip for anything else.
export function getLeadSourceConfig(source: string | null | undefined): LeadSourceConfig {
  if (source && source in LEAD_SOURCE_CONFIG) {
    return LEAD_SOURCE_CONFIG[source as LeadSource];
  }
  if (typeof source === 'string') {
    if (source.startsWith('booking_')) return LEAD_SOURCE_CONFIG.calcom;
    if (source === 'embed_form') return LEAD_SOURCE_CONFIG.website_form;
  }
  return LEAD_SOURCE_CONFIG.manual;
}

export const LEAD_COLUMN_ORDER: LeadStatus[] = ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'];
