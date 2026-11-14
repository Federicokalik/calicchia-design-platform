/**
 * JSON Merge Patch (RFC 7396) per i campi jsonb aggiornati in modo parziale
 * (es. customers.billing_address).
 *
 * - le chiavi del patch sostituiscono quelle del target;
 * - una chiave a `null` nel patch rimuove la chiave dal target;
 * - gli oggetti annidati si fondono ricorsivamente;
 * - array e scalari sostituiscono in blocco.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergePatch(target: unknown, patch: unknown): JsonValue {
  if (!isPlainObject(patch)) return patch as JsonValue;
  const result: Record<string, JsonValue> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}
