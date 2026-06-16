import { z } from 'zod';

// =====================================================
// Email/WhatsApp marketing platform — shared contracts
//
// Single source of truth for the enums + DTOs used by the api
// (apps/api/src/routes/email-marketing.ts) and the admin UI
// (apps/admin/src/pages/email-marketing/*). The `mkt_*` tables
// (migrations 133+) are the persistence layer behind these.
// =====================================================

// ── Enums (mirror the SQL CHECK constraints) ──────────
export const EMAIL_CONSENT = ['unconfirmed', 'confirmed', 'unsubscribed', 'bounced', 'complained'] as const;
export type EmailConsent = (typeof EMAIL_CONSENT)[number];

export const EMAIL_LEGAL_BASIS = ['consent', 'legitimate_interest_b2b', 'soft_optin'] as const;
export type EmailLegalBasis = (typeof EMAIL_LEGAL_BASIS)[number];

export const WA_CONSENT = ['none', 'opted_in', 'opted_out'] as const;
export type WaConsent = (typeof WA_CONSENT)[number];

export const AUDIENCE_TYPE = ['warm', 'cold'] as const;
export type AudienceType = (typeof AUDIENCE_TYPE)[number];

export const CAMPAIGN_CHANNEL = ['email', 'whatsapp'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNEL)[number];

export const CONTENT_MODE = ['blocks', 'html', 'ai'] as const;
export type ContentMode = (typeof CONTENT_MODE)[number];

export const CAMPAIGN_STATUS = [
  'draft', 'scheduled', 'queued', 'sending', 'sent', 'paused', 'failed', 'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];

export const MESSAGE_STATUS = [
  'queued', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'skipped', 'opened', 'clicked',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[number];

// ── Contact DTO ───────────────────────────────────────
export interface MktContact {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  role: string | null;
  website: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
  email_consent: EmailConsent;
  email_legal_basis: EmailLegalBasis;
  wa_consent: WaConsent;
  audience_type: AudienceType;
  consent_source: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  status: 'active' | 'archived';
  subscriber_id: string | null;
  lead_id: string | null;
  customer_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Validators ────────────────────────────────────────
const emailField = z.string().trim().toLowerCase().email('Email non valida').max(255);
const phoneField = z.string().trim().max(30).optional().or(z.literal('')).transform((v) => v || undefined);

const mktContactBase = z.object({
  email: emailField.optional(),
  phone: phoneField,
  first_name: z.string().trim().max(120).optional(),
  last_name: z.string().trim().max(120).optional(),
  company: z.string().trim().max(200).optional(),
  role: z.string().trim().max(120).optional(),
  website: z.string().trim().max(255).optional(),
  industry: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
  email_legal_basis: z.enum(EMAIL_LEGAL_BASIS).default('consent'),
  audience_type: z.enum(AUDIENCE_TYPE).default('warm'),
  consent_source: z.string().trim().max(160).optional(),
  tags: z.array(z.string().trim().max(60)).max(50).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const mktContactCreateSchema = mktContactBase.refine(
  (v) => v.email || v.phone, { message: 'Email o telefono richiesto' },
);
export type MktContactCreate = z.infer<typeof mktContactCreateSchema>;

export const mktContactUpdateSchema = mktContactBase.partial().extend({
  email_consent: z.enum(EMAIL_CONSENT).optional(),
  wa_consent: z.enum(WA_CONSENT).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

// ── Import (Apify CSV standard) ───────────────────────
// Canonical row our importer maps incoming CSV columns onto. Extra columns are
// preserved verbatim into `metadata` so no scraped data is lost.
export const importRowSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255).optional().or(z.literal('')).transform((v) => v || undefined),
  phone: z.string().trim().max(30).optional().or(z.literal('')).transform((v) => v || undefined),
  first_name: z.string().trim().max(120).optional(),
  last_name: z.string().trim().max(120).optional(),
  company: z.string().trim().max(200).optional(),
  role: z.string().trim().max(120).optional(),
  website: z.string().trim().max(255).optional(),
  industry: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

// Header-name aliases → canonical field. Apify/Maps exports vary wildly.
export const IMPORT_FIELD_ALIASES: Record<string, keyof ImportRow> = {
  email: 'email', 'e-mail': 'email', mail: 'email', emailaddress: 'email', 'email address': 'email',
  phone: 'phone', telephone: 'phone', tel: 'phone', telefono: 'phone', 'phone number': 'phone', mobile: 'phone', whatsapp: 'phone',
  first_name: 'first_name', firstname: 'first_name', 'first name': 'first_name', nome: 'first_name', name: 'first_name',
  last_name: 'last_name', lastname: 'last_name', 'last name': 'last_name', cognome: 'last_name', surname: 'last_name',
  company: 'company', companyname: 'company', 'company name': 'company', azienda: 'company', business: 'company', 'business name': 'company',
  role: 'role', title: 'role', jobtitle: 'role', 'job title': 'role', ruolo: 'role', position: 'role',
  website: 'website', site: 'website', url: 'website', web: 'website', sito: 'website', domain: 'website',
  industry: 'industry', settore: 'industry', category: 'industry', categoria: 'industry', sector: 'industry',
  city: 'city', citta: 'city', città: 'city', town: 'city', comune: 'city',
  country: 'country', paese: 'country', nazione: 'country', state: 'country',
};

export const importCommitSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(50000),
  list_id: z.string().uuid().optional(),
  new_list_name: z.string().trim().min(1).max(160).optional(),
  audience_type: z.enum(AUDIENCE_TYPE).default('cold'),
  email_legal_basis: z.enum(EMAIL_LEGAL_BASIS).default('legitimate_interest_b2b'),
  consent_source: z.string().trim().max(160).default('import'),
  tags: z.array(z.string().trim().max(60)).max(50).optional(),
  on_duplicate: z.enum(['merge', 'skip']).default('merge'),
});
export type ImportCommit = z.infer<typeof importCommitSchema>;

// ── Segment definition DSL ────────────────────────────
export const segmentDefinitionSchema = z.object({
  audience_type: z.enum(AUDIENCE_TYPE).optional(),
  email_consent: z.array(z.enum(EMAIL_CONSENT)).optional(),
  wa_consent: z.array(z.enum(WA_CONSENT)).optional(),
  tags_any: z.array(z.string()).optional(),
  tags_all: z.array(z.string()).optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  has_email: z.boolean().optional(),
  has_phone: z.boolean().optional(),
}).strict();
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

export const mktListCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  default_legal_basis: z.enum(EMAIL_LEGAL_BASIS).default('consent'),
});

export const mktSegmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  definition: segmentDefinitionSchema,
});
