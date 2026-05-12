import { z } from 'zod';

export const privacyRequestTypeSchema = z.enum([
  'accesso',
  'cancellazione',
  'portabilita',
  'rettifica',
  'opposizione',
  'limitazione',
]);

export const privacyRequestSchema = z.object({
  requestType: privacyRequestTypeSchema,
  name: z.string().trim().min(2, 'Inserisci almeno 2 caratteri.'),
  email: z.string().trim().email('Inserisci un indirizzo email valido.'),
  description: z
    .string()
    .trim()
    .min(20, 'Descrivi la richiesta con almeno 20 caratteri.')
    .max(5000, 'La descrizione non puo superare 5000 caratteri.'),
  gdpr: z.literal(true, {
    errorMap: () => ({ message: 'Devi confermare la presa visione privacy.' }),
  }),
  turnstileToken: z.string().trim().min(1, 'Verifica anti-bot richiesta.'),
});

export type PrivacyRequestType = z.infer<typeof privacyRequestTypeSchema>;
export type PrivacyRequestInput = z.infer<typeof privacyRequestSchema>;
