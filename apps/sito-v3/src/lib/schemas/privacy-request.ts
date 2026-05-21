import { z } from 'zod';

// Enum values mirror the API contract (`request_type` in
// apps/api/src/routes/gdpr-requests.ts): English, snake-free identifiers.
// The Italian copy lives in the form's label map, not here.
export const privacyRequestTypeSchema = z.enum([
  'access',
  'erasure',
  'portability',
  'rectification',
  'objection',
  'restriction',
]);

export const privacyRequestSchema = z.object({
  requestType: privacyRequestTypeSchema,
  name: z
    .string()
    .trim()
    .min(2, 'Inserisci almeno 2 caratteri.')
    .max(100, 'Il nome non puo superare 100 caratteri.'),
  email: z.string().trim().email('Inserisci un indirizzo email valido.'),
  description: z
    .string()
    .trim()
    .min(20, 'Descrivi la richiesta con almeno 20 caratteri.')
    .max(2000, 'La descrizione non puo superare 2000 caratteri.'),
  gdpr: z.literal(true, {
    errorMap: () => ({ message: 'Devi confermare la presa visione privacy.' }),
  }),
});

export type PrivacyRequestType = z.infer<typeof privacyRequestTypeSchema>;
export type PrivacyRequestInput = z.infer<typeof privacyRequestSchema>;
