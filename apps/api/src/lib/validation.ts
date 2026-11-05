/**
 * Validazione dei body e degli argomenti dei tool con zod, con errori che
 * dicono QUALE campo è sbagliato e perché.
 *
 * - `parseOr400(c, schema, value, hints)`: valida, e in caso di errore
 *   lancia una HTTPException 400 con `{ error, details: [{ path, message }] }`
 *   (lo stesso formato che apps/admin/src/lib/api.ts mostra all'utente).
 * - Campi sconosciuti: con gli schemi `.strict()` ogni chiave non prevista è
 *   un dettaglio a sé, con il suggerimento del nome giusto se noto (`hints`:
 *   { renewal_price: 'renewal_cost' }). Prima venivano ignorati in silenzio
 *   o arrivavano a Postgres come colonne inesistenti (500).
 * - Messaggi in italiano tramite `itErrorMap`.
 */
import { HTTPException } from 'hono/http-exception';
import { z, type ZodError, type ZodTypeAny } from 'zod';

export interface ValidationDetail {
  path: Array<string | number>;
  message: string;
}

const TYPE_LABELS: Record<string, string> = {
  string: 'testo',
  number: 'numero',
  integer: 'intero',
  boolean: 'booleano (true/false)',
  object: 'oggetto',
  array: 'array',
  date: 'data',
  null: 'null',
  undefined: 'assente',
};

const label = (t: string) => TYPE_LABELS[t] ?? t;

/** Error map italiana per gli schemi zod dell'API. */
export const itErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'campo obbligatorio mancante' };
      return { message: `tipo non valido: atteso ${label(issue.expected)}, ricevuto ${label(issue.received)}` };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `valore non ammesso "${String(issue.received)}": valori possibili ${issue.options.map(String).join(', ')}` };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'indirizzo email non valido' };
      if (issue.validation === 'uuid') return { message: 'UUID non valido' };
      if (issue.validation === 'url') return { message: 'URL non valido' };
      if (issue.validation === 'regex') return { message: 'formato non valido' };
      return { message: 'testo non valido' };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: issue.minimum === 1 ? 'non può essere vuoto' : `almeno ${issue.minimum} caratteri` };
      if (issue.type === 'array') return { message: `almeno ${issue.minimum} elementi` };
      return { message: `deve essere ${issue.inclusive ? '≥' : '>'} ${issue.minimum}` };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `al massimo ${issue.maximum} caratteri` };
      if (issue.type === 'array') return { message: `al massimo ${issue.maximum} elementi` };
      return { message: `deve essere ${issue.inclusive ? '≤' : '<'} ${issue.maximum}` };
    case z.ZodIssueCode.invalid_date:
      return { message: 'data non valida' };
    default:
      return { message: ctx.defaultError };
  }
};

/** Dettagli per campo da un errore zod; le chiavi sconosciute diventano un dettaglio ciascuna. */
export function zodDetails(error: ZodError, hints: Readonly<Record<string, string>> = {}): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) {
        const hint = hints[key];
        details.push({
          path: [...issue.path, key],
          message: hint ? `campo non riconosciuto: usa ${hint}` : 'campo non riconosciuto',
        });
      }
      continue;
    }
    details.push({ path: issue.path, message: issue.message });
  }
  return details;
}

export function formatPath(path: ReadonlyArray<string | number>): string {
  return path.length ? path.join('.') : '(body)';
}

/** Messaggio unico leggibile: "Validazione fallita — a: …; b: …". */
export function validationMessage(details: ValidationDetail[], prefix = 'Validazione fallita'): string {
  const parts = details.map((d) => `${formatPath(d.path)}: ${d.message}`);
  return `${prefix} — ${parts.join('; ')}`;
}

/** Errore 400 con dettagli per campo, reso da app.onError come `{ error, details }`. */
export class RequestValidationError extends HTTPException {
  readonly details: ValidationDetail[];

  constructor(details: ValidationDetail[], prefix?: string) {
    const message = validationMessage(details, prefix);
    super(400, {
      message,
      res: new Response(JSON.stringify({ error: message, details }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      }),
    });
    this.details = details;
  }
}

/** Valida `value` con `schema`; su errore lancia RequestValidationError (400). */
export function parseOr400<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  hints: Readonly<Record<string, string>> = {},
  prefix?: string,
): z.output<S> {
  const result = schema.safeParse(value, { errorMap: itErrorMap });
  if (!result.success) throw new RequestValidationError(zodDetails(result.error, hints), prefix);
  return result.data;
}

/** Errore di un singolo campo (validazioni fuori da zod: PSL, allegati, riferimenti). */
export function fieldError(path: Array<string | number>, message: string, prefix?: string): RequestValidationError {
  return new RequestValidationError([{ path, message }], prefix);
}

/** Data di calendario YYYY-MM-DD valida (rifiuta 2026-02-30). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'formato data non valido: usa YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'data inesistente');
