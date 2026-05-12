import { z } from 'zod';

export const SERVICE_OPTIONS = [
  // Matrix services (4)
  'web-design',
  'e-commerce',
  'sviluppo-web',
  'seo',
  // Standalone services
  'branding',
  'manutenzione-siti',
  'assistenza-wordpress',
  'wordpress-migrazione',
] as const;

export const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Inserisci nome e cognome (almeno 2 caratteri).')
    .max(100, 'Nome troppo lungo (max 100 caratteri).'),
  email: z
    .string()
    .trim()
    .email('Email non valida.')
    .max(255, 'Email troppo lunga.'),
  message: z
    .string()
    .trim()
    .min(20, 'Scrivimi almeno 20 caratteri sul progetto.')
    .max(2000, 'Messaggio troppo lungo (max 2000 caratteri).'),
  phone: z
    .string()
    .trim()
    .regex(/^\+\d{1,4}\s?\d{4,15}$/, 'Formato telefono non valido (es. +39 3510000000).')
    .optional()
    .or(z.literal('')),
  company: z
    .string()
    .trim()
    .max(150, 'Nome azienda troppo lungo (max 150 caratteri).')
    .optional()
    .or(z.literal('')),
  services: z.array(z.enum(SERVICE_OPTIONS)).max(20).optional(),
  sectors: z.array(z.string().trim()).max(10).optional(),
  wants_call: z.boolean().optional(),
  wants_meet: z.boolean().optional(),
  gdpr_consent: z.literal(true, {
    errorMap: () => ({ message: "Devi accettare l'informativa privacy." }),
  }),
  source_page: z.string().trim().max(255).optional().or(z.literal('')),
  source_service: z.string().trim().max(100).optional().or(z.literal('')),
  source_profession: z.string().trim().max(100).optional().or(z.literal('')),
  lead_source: z.string().trim().max(64).optional().or(z.literal('')),
  meet_slot: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'Formato slot non valido.')
    .optional()
    .or(z.literal('')),
  turnstile_token: z.string().trim().min(1, 'Verifica anti-bot richiesta.'),
});

export type ContactInput = z.infer<typeof contactSchema>;
