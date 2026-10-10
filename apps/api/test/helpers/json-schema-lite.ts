/**
 * Validatore minimo di JSON Schema (draft 2020-12) per i test dei contratti
 * in docs/calendar-radicale/contracts/*.schema.json, senza aggiungere
 * dipendenze all'API.
 *
 * Copre solo le parole chiave usate da quegli schemi: type, const, enum,
 * required, properties, additionalProperties, propertyNames, maxProperties,
 * items, contains, uniqueItems, minItems, maxItems, minLength, maxLength
 * (in code point), pattern (regex ECMAScript con flag u), minimum, maximum,
 * allOf, anyOf, oneOf, not, if/then/else e $ref locali (#/$defs/...).
 * `format`, `description`, `title` ed `examples` sono annotazioni e vengono
 * ignorate. Una parola chiave non supportata fa fallire la validazione con un
 * errore esplicito, così uno schema che cresce non passa in silenzio.
 */

type Schema = boolean | { [key: string]: unknown };

/** Uno schema JSON qualsiasi (documento letto da file o sotto-schema costruito nel test). */
export type JsonSchema = boolean | object;

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'format', '$defs', '$comment']);
const SUPPORTED = new Set([
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'propertyNames', 'maxProperties',
  'items', 'contains', 'uniqueItems', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref',
]);

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = jsonType(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Valida `value` contro `schema` e restituisce gli errori (vuoto = valido). */
export function validateJsonSchema(schema: JsonSchema, value: unknown): string[] {
  const root = schema as Schema;
  const errors: string[] = [];

  const resolve = (ref: string): Schema => {
    if (!ref.startsWith('#/')) throw new Error(`$ref non locale non supportato: ${ref}`);
    let node: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      node = (node as Record<string, unknown>)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (node === undefined) throw new Error(`$ref non risolto: ${ref}`);
    return node as Schema;
  };

  const check = (s: Schema, v: unknown, path: string, out: string[]): void => {
    if (s === true) return;
    if (s === false) {
      out.push(`${path}: schema false`);
      return;
    }
    for (const key of Object.keys(s)) {
      if (!ANNOTATIONS.has(key) && !SUPPORTED.has(key)) throw new Error(`parola chiave non supportata: ${key} (${path})`);
    }
    if (typeof s.$ref === 'string') check(resolve(s.$ref), v, path, out);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeMatches(v, t))) out.push(`${path}: tipo ${jsonType(v)} invece di ${types.join('|')}`);
    }
    if ('const' in s && !deepEqual(v, s.const)) out.push(`${path}: diverso da const ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) out.push(`${path}: ${JSON.stringify(v)} fuori da enum`);

    if (typeof v === 'string') {
      const len = [...v].length;
      if (typeof s.minLength === 'number' && len < s.minLength) out.push(`${path}: più corta di ${s.minLength}`);
      if (typeof s.maxLength === 'number' && len > s.maxLength) out.push(`${path}: più lunga di ${s.maxLength}`);
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) out.push(`${path}: non rispetta ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${path}: minore di ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${path}: maggiore di ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${path}: meno di ${s.minItems} elementi`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${path}: più di ${s.maxItems} elementi`);
      if (s.uniqueItems === true && v.some((x, i) => v.findIndex((y) => deepEqual(x, y)) !== i)) out.push(`${path}: elementi duplicati`);
      if (s.items !== undefined) v.forEach((x, i) => check(s.items as Schema, x, `${path}[${i}]`, out));
      if (s.contains !== undefined && !v.some((x) => validate(s.contains as Schema, x))) out.push(`${path}: nessun elemento soddisfa contains`);
    }
    if (jsonType(v) === 'object') {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      if (Array.isArray(s.required)) {
        for (const k of s.required as string[]) if (!(k in obj)) out.push(`${path}: manca ${k}`);
      }
      if (typeof s.maxProperties === 'number' && Object.keys(obj).length > s.maxProperties) out.push(`${path}: troppe proprietà`);
      for (const [k, x] of Object.entries(obj)) {
        if (s.propertyNames !== undefined) check(s.propertyNames as Schema, k, `${path}{${k}}`, out);
        if (k in props) check(props[k], x, `${path}.${k}`, out);
        else if (s.additionalProperties !== undefined) check(s.additionalProperties as Schema, x, `${path}.${k}`, out);
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) check(sub, v, path, out);
    if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((sub) => validate(sub, v))) out.push(`${path}: nessuno schema di anyOf`);
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as Schema[]).filter((sub) => validate(sub, v)).length;
      if (n !== 1) out.push(`${path}: ${n} schemi di oneOf invece di 1`);
    }
    if (s.not !== undefined && validate(s.not as Schema, v)) out.push(`${path}: soddisfa not`);
    if (s.if !== undefined) {
      const branch = validate(s.if as Schema, v) ? s.then : s.else;
      if (branch !== undefined) check(branch as Schema, v, path, out);
    }
  };

  const validate = (s: Schema, v: unknown): boolean => {
    const local: string[] = [];
    check(s, v, '$', local);
    return local.length === 0;
  };

  check(root, value, '$', errors);
  return errors;
}
