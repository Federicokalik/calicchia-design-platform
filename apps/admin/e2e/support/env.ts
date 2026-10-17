/**
 * Indirizzi e percorsi condivisi da playwright.config.ts, dal setup globale e
 * dagli scenari. Le porte hanno gli stessi default di e2e/stack/server.ts:
 * l'API ascolta sulla 3001 perché è la destinazione del proxy /api di vite
 * (server.proxy, ereditata da vite preview).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Origine dell'admin servito da vite preview (le chiamate /api passano dal suo proxy). */
export const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4173';

/** Porta di vite preview (stessa di BASE_URL). */
export const PREVIEW_PORT = Number(new URL(BASE_URL).port || 4173);

/** Server di controllo dello stack (solo loopback). */
export const CONTROL_URL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT || 3002}`;

/** Cartella di lavoro degli e2e, fuori dal repository. */
export const STATE_DIR = process.env.E2E_STATE_DIR || join(tmpdir(), 'caldes-e2e');

/** Sessione admin salvata dal setup globale e usata da ogni contesto. */
export const STORAGE_STATE = join(STATE_DIR, 'storage-state.json');
