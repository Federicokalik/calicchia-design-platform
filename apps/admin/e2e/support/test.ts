/**
 * `test` degli scenari: come quello di Playwright, ma
 *  - ogni pagina parte con l'avviso "Knowledge base AI incompleta" già chiuso
 *    (lo stack non ha le knowledge base e il modale coprirebbe l'interfaccia);
 *  - a fine scenario gli eventi della settimana corrente nei calendari di prova
 *    vengono tolti (`purgeWeek`), così la griglia non si affolla.
 */

import { test as base, expect } from '@playwright/test';
import { purgeWeek } from './calendar';

export const test = base.extend<{ sgombero: void }>({
  sgombero: [
    async ({ request }, provide) => {
      await provide();
      await purgeWeek(request);
    },
    { auto: true },
  ],
  context: async ({ context }, provide) => {
    await context.addInitScript(() => {
      try {
        sessionStorage.setItem('kb-missing-dismissed', '1');
      } catch {
        // Storage non disponibile: il modale resta, lo scenario lo vedrebbe fallire.
      }
    });
    await provide(context);
  },
});

export { expect };
