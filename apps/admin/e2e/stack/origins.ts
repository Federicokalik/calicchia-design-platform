/**
 * Origine dell'admin fra quelle ammesse dall'API (CORS_ORIGINS, che è anche
 * l'elenco della difesa CSRF delle scritture). In produzione nginx inoltra
 * l'Host dell'admin; il proxy di vite preview invece lo riscrive
 * (changeOrigin), quindi l'Origin del browser non coinciderebbe con nessuna
 * origine nota. Va importato subito dopo l'ambiente di test e prima di
 * qualsiasi modulo di src/, che legge CORS_ORIGINS all'import.
 */

import { BASE_URL } from '../support/env';

const current = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
process.env.CORS_ORIGINS = [...new Set([...current, new URL(BASE_URL).origin])].join(',');
