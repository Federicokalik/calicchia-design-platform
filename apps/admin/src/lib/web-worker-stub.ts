// Stub per il bare-specifier `web-worker` richiesto da `elkjs/lib/elk.bundled.js`.
//
// elk.bundled.js esegue:
//   try { require.resolve("web-worker"); fe = true } catch {}
//   if (workerUrl && fe) { var ae = require("web-worker"); ... }
//
// In browser `Worker` e' sempre definito, quindi elkjs usa il Worker nativo e
// questo stub non viene mai realmente eseguito al runtime. Esiste solo per dare
// a Vite/Rollup un modulo locale da risolvere, evitando l'errore:
//   "Failed to resolve module specifier 'web-worker'".
//
// Vedi anche `vite.config.ts` (resolve.alias).

const StubWorker =
  typeof Worker !== 'undefined'
    ? Worker
    : (class NoopWorker {} as unknown as typeof Worker);

export default StubWorker;
export { StubWorker as Worker };
