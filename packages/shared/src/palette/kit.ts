/**
 * Brand kit in PDF del tool "Palette di settore" (fase 2): richiesta dal sito
 * (POST /api/palette/kit) e testo del consenso.
 *
 * Lo scopo dichiarato è l'iscrizione alla newsletter; il PDF è il regalo che
 * arriva dopo la conferma (double opt-in). Il testo del consenso sta qui
 * perché il sito lo mostra e l'API registra la versione accettata: cambiando
 * il testo si cambia anche KIT_CONSENT_VERSION.
 *
 * DA VALIDARE CON UN LEGALE prima del lancio (art. 7(4) GDPR: regalo legato
 * all'iscrizione).
 */

import { z } from 'zod';
import { sharedPaletteSchema } from './share';
import type { PaletteLocale } from './types';

export const KIT_CONSENT_VERSION = '2026-10-16';

export const KIT_CONSENT_TEXT: Record<PaletteLocale, string> = {
  it: "Mi iscrivo alla newsletter di Calicchia Design (siti web, branding e marketing per attività locali). Posso disiscrivermi quando voglio con un clic. In regalo ricevo il brand kit in PDF di questa palette.",
  en: 'I subscribe to the Calicchia Design newsletter (websites, branding and marketing for local businesses). I can unsubscribe at any time with one click. As a gift I get the PDF brand kit of this palette.',
};

export const kitRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  name: z.string().trim().max(100).optional(),
  palette: sharedPaletteSchema,
  /** Etichetta del settore come la mostra il sito (l'API non ha l'elenco dei settori). */
  sector_label: z
    .string()
    .trim()
    .max(60)
    .regex(/^[\p{L}\p{N} '’&.,()-]+$/u)
    .optional(),
  locale: z.enum(['it', 'en']),
  consent: z.literal(true),
  consent_version: z.literal(KIT_CONSENT_VERSION),
  turnstile_token: z.string().max(4096).optional(),
});

export type KitRequest = z.infer<typeof kitRequestSchema>;
