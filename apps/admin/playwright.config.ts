/**
 * Configurazione degli e2e dell'admin (contratto F6 §9.3).
 *
 * Due webServer: lo stack (API vera + Radicale reale + database dei test, vedi
 * e2e/stack/server.ts) e l'admin già buildato servito da `vite preview`, il cui
 * proxy /api è quello di vite.config.ts. Un solo worker e nessun parallelismo:
 * gli scenari condividono lo stesso stack.
 *
 * Prima di lanciare:
 *   TEST_DATABASE_URL=postgresql://caldes:caldes@localhost:5432/caldes_test \
 *   RADICALE_BIN=/percorso/del/venv/bin/radicale \
 *   pnpm --filter @calicchia/api test:migrate && pnpm --filter @calicchia/admin build
 * Il browser è quello di PLAYWRIGHT_BROWSERS_PATH (in locale /opt/pw-browsers);
 * E2E_CHROMIUM_PATH lo sostituisce con un eseguibile preciso.
 */

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { BASE_URL, CONTROL_URL, PREVIEW_PORT, STORAGE_STATE } from './e2e/support/env';

const CI = !!process.env.CI;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    viewport: { width: 1440, height: 1100 },
    trace: 'on-first-retry',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1100 },
        ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @calicchia/api exec tsx --import ./test/helpers/preload.mjs ../admin/e2e/stack/server.ts',
      cwd: repoRoot,
      url: `${CONTROL_URL}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm --filter @calicchia/admin exec vite preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      cwd: repoRoot,
      url: BASE_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
