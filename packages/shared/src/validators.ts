import { z } from 'zod';

export const contactSchema = z.object({
  name: z.string().min(2, 'Il nome deve avere almeno 2 caratteri'),
  email: z.string().email('Email non valida'),
  subject: z.string().optional(),
  message: z.string().min(10, 'Il messaggio deve avere almeno 10 caratteri'),
});

export type ContactFormData = z.infer<typeof contactSchema>;

// =====================================================
// Public form contracts — single source of truth
//
// Audit J-K-11: routes/contacts.ts and routes/calendar/public.ts used to
// reimplement validation inline (~20 lines of typeof / .length / regex
// checks each). With the schema living in shared, the public sito-v3
// forms could in the future feed the same shape, and a contract change
// becomes a one-file edit instead of three.
//
// `passthrough()` lets the api accept fields not listed here (turnstile_token,
// source_page, lead_source) without validating them — they're handled
// downstream where they're actually consumed. Keeping the schema strict
// on what we DO validate but tolerant on what we IGNORE.
// =====================================================

const phoneE164ish = z.string()
  .min(6, 'Numero richiesto')
  .max(30, 'Numero troppo lungo')
  .regex(/^\+\d{1,4}\s?\d{4,15}$/, 'Formato telefono non valido (es. +39 3510000000)');

export const publicContactSchema = z.object({
  name: z.string().trim().min(1, 'Nome richiesto').max(100, 'Nome troppo lungo (max 100 caratteri)'),
  email: z.string().trim().toLowerCase().email('Email non valida').max(255, 'Email troppo lunga'),
  message: z.string().trim().max(2000, 'Messaggio troppo lungo (max 2000 caratteri)').optional().default(''),
  phone: phoneE164ish.optional().or(z.literal('')).transform((v) => v || undefined),
  company: z.string().trim().max(150, 'Nome azienda troppo lungo').optional().or(z.literal('')).transform((v) => v || undefined),
  services: z.array(z.string()).max(20).optional(),
  sectors: z.array(z.string()).max(10).optional(),
  wants_call: z.boolean().optional().default(false),
  wants_meet: z.boolean().optional().default(false),
  gdpr_consent: z.literal(true, { errorMap: () => ({ message: 'Consenso GDPR richiesto' }) }),
  source_page: z.string().max(255).optional(),
  source_service: z.string().max(64).optional(),
  source_profession: z.string().max(64).optional(),
  lead_source: z.string().trim().max(64, 'Origine lead troppo lunga').optional().or(z.literal('')).transform((v) => v || undefined),
  meet_slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'Formato slot non valido').optional(),
}).passthrough();
export type PublicContactBody = z.infer<typeof publicContactSchema>;

export const publicBookingAttendeeSchema = z.object({
  name: z.string().trim().min(2, 'Nome richiesto (min 2 caratteri)').max(200, 'Nome troppo lungo (max 200)'),
  email: z.string().trim().toLowerCase().email('Email non valida'),
  phone: z.string().trim().regex(/^[+\d][\d\s\-().]{4,49}$/, 'Numero di telefono non valido').optional().or(z.literal('')).transform((v) => v || undefined),
  company: z.string().trim().max(200, 'Nome azienda troppo lungo (max 200)').optional().or(z.literal('')).transform((v) => v || undefined),
  message: z.string().trim().max(2000, 'Messaggio troppo lungo (max 2000 caratteri)').optional().or(z.literal('')).transform((v) => v || undefined),
  timezone: z.string().min(1).max(79).optional(),
}).passthrough();

export const publicBookingSchema = z.object({
  event_type_slug: z.string().min(1, 'event_type_slug richiesto').max(120),
  start: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'start ISO richiesto'),
  attendee: publicBookingAttendeeSchema,
  gdpr_consent: z.literal(true, { errorMap: () => ({ message: 'Consenso GDPR richiesto' }) }),
}).passthrough();
export type PublicBookingBody = z.infer<typeof publicBookingSchema>;

/**
 * Helper for Hono handlers: run safeParse and short-circuit with a 400
 * carrying the first zod issue message. Returns null on success so the
 * handler can keep the existing early-return control flow.
 */
export function firstZodIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Dati non validi';
}

export const projectSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug deve contenere solo lettere minuscole, numeri e trattini'),
  title: z.string().min(1, 'Titolo richiesto'),
  description: z.string().optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  cover_image: z.string().url().optional().or(z.literal('')),
  gallery: z.array(z.string().url()).optional(),
  technologies: z.array(z.string()).optional(),
  live_url: z.string().url().optional().or(z.literal('')),
  repo_url: z.string().url().optional().or(z.literal('')),
  is_featured: z.boolean().optional(),
  is_published: z.boolean().optional(),
  display_order: z.number().int().optional(),
});

export type ProjectFormData = z.infer<typeof projectSchema>;

export const blogPostSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug deve contenere solo lettere minuscole, numeri e trattini'),
  title: z.string().min(1, 'Titolo richiesto'),
  content: z.string().min(1, 'Contenuto richiesto'),
  excerpt: z.string().optional(),
  cover_image: z.string().url().optional().or(z.literal('')),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  is_published: z.boolean().optional(),
  allow_comments: z.boolean().optional(),
});

export type BlogPostFormData = z.infer<typeof blogPostSchema>;

export const loginSchema = z.object({
  email: z.string().email('Email non valida'),
  password: z.string().min(6, 'Password deve avere almeno 6 caratteri'),
});

export type LoginFormData = z.infer<typeof loginSchema>;

// =====================================================
// WhatsApp / preferenze comunicazione
// =====================================================

export const whatsappCategorySchema = z.enum(['transactional', 'operational', 'marketing']);
export type WhatsappCategory = z.infer<typeof whatsappCategorySchema>;

export const whatsappAiModeSchema = z.enum(['off', 'triage', 'auto_reply']);
export type WhatsappAiMode = z.infer<typeof whatsappAiModeSchema>;

export const whatsappSendSchema = z.object({
  phone: z.string().min(6, 'Numero richiesto'),
  text: z.string().min(1, 'Testo richiesto').max(4000, 'Testo troppo lungo'),
  category: whatsappCategorySchema.optional().default('operational'),
});

export const communicationPreferencesPatchSchema = z.object({
  whatsapp_operational: z.boolean().optional(),
  whatsapp_marketing: z.boolean().optional(),
  email_operational: z.boolean().optional(),
  email_marketing: z.boolean().optional(),
}).refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Nessuna modifica' }
);

export type CommunicationPreferencesPatch = z.infer<typeof communicationPreferencesPatchSchema>;

export const communicationPreferencesSchema = z.object({
  id: z.string().uuid(),
  whatsapp_transactional: z.boolean(),
  whatsapp_operational: z.boolean(),
  whatsapp_marketing: z.boolean(),
  email_operational: z.boolean(),
  email_marketing: z.boolean(),
  sms_transactional: z.boolean(),
  preferences_token: z.string(),
});

export type CommunicationPreferences = z.infer<typeof communicationPreferencesSchema>;

// =====================================================
// GEO Audit tool — public contracts
//
// `/api/geo-audit/scan`   accepts a URL, runs the deterministic audit, returns a
//                         teaser (score + top findings) and an auditId.
// `/api/geo-audit/unlock` accepts the auditId + email (+ GDPR consent), generates
//                         the AI action plan, creates the lead and returns the
//                         full report. Mirrors publicContactSchema's email/consent
//                         handling so the same lead pipeline rules apply.
// =====================================================

export const geoAuditScanSchema = z.object({
  url: z.string().trim().min(4, 'URL richiesto').max(2048, 'URL troppo lungo'),
  locale: z.enum(['it', 'en']).optional().default('it'),
}).passthrough();
export type GeoAuditScanBody = z.infer<typeof geoAuditScanSchema>;

export const geoAuditUnlockSchema = z.object({
  audit_id: z.string().uuid('audit_id non valido'),
  email: z.string().trim().toLowerCase().email('Email non valida').max(255, 'Email troppo lunga'),
  name: z.string().trim().max(100, 'Nome troppo lungo').optional().or(z.literal('')).transform((v) => v || undefined),
  gdpr_consent: z.literal(true, { errorMap: () => ({ message: 'Consenso GDPR richiesto' }) }),
  wants_intervention: z.boolean().optional(),
}).passthrough();
export type GeoAuditUnlockBody = z.infer<typeof geoAuditUnlockSchema>;
