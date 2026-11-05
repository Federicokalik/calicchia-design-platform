/**
 * Nome e TLD di un dominio registrabile dalla Public Suffix List (tldts).
 *
 * `domains.full_domain` è una colonna generata (`domain_name || '.' || tld`):
 * passando domain_name "crimatek.com" e tld "com" si otteneva
 * "crimatek.com.com". Qui si accettano tre forme e si ricavano sempre nome e
 * suffisso pubblico coerenti, anche per i suffissi a più livelli (co.uk,
 * com.au, gov.it...):
 *  - full_domain: "crimatek.co.uk";
 *  - domain_name completo: "crimatek.com" (tld facoltativo, se presente deve coincidere);
 *  - domain_name + tld: "crimatek" + "it".
 * Forme incoerenti (TLD diversi, full_domain che non corrisponde,
 * sottodomini, suffissi fuori dalla sezione ICANN della PSL) → errore.
 */
import { parse } from 'tldts';

export type DomainParseResult =
  | { ok: true; domain_name: string; tld: string }
  | { ok: false; field: 'domain_name' | 'tld' | 'full_domain'; error: string };

// Etichetta DNS: lettere (anche IDN), cifre, trattini interni; 1-63 caratteri.
const LABEL_RE = /^(?!-)[\p{L}\p{N}-]{1,63}(?<!-)$/u;

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase().replace(/\.$/, '');
  return v || undefined;
}

function parseFull(host: string, field: 'domain_name' | 'full_domain'): DomainParseResult {
  if (!host.split('.').every((l) => LABEL_RE.test(l))) {
    return { ok: false, field, error: `"${host}" non è un nome di dominio valido` };
  }
  const p = parse(host, { allowPrivateDomains: false });
  if (p.isIp) return { ok: false, field, error: `"${host}" è un indirizzo IP, non un dominio` };
  if (!p.publicSuffix || !p.isIcann || !p.domainWithoutSuffix) {
    return { ok: false, field, error: `TLD di "${host}" non riconosciuto (Public Suffix List)` };
  }
  if (p.subdomain) {
    return {
      ok: false,
      field,
      error: `"${host}" contiene un sottodominio ("${p.subdomain}"): indica il dominio registrabile "${p.domain}"`,
    };
  }
  return { ok: true, domain_name: p.domainWithoutSuffix, tld: p.publicSuffix };
}

export function parseDomainInput(input: {
  domain_name?: string | null;
  tld?: string | null;
  full_domain?: string | null;
}): DomainParseResult {
  const full = clean(input.full_domain);
  const name = clean(input.domain_name);
  const tld = clean(input.tld)?.replace(/^\./, '');

  if (full) {
    const parsed = parseFull(full, 'full_domain');
    if (!parsed.ok) return parsed;
    if (name && name !== parsed.domain_name && name !== full) {
      return { ok: false, field: 'domain_name', error: `domain_name "${name}" incoerente con full_domain "${full}"` };
    }
    if (tld && tld !== parsed.tld) {
      return { ok: false, field: 'tld', error: `tld "${tld}" incoerente con full_domain "${full}" (TLD "${parsed.tld}")` };
    }
    return parsed;
  }

  if (!name) return { ok: false, field: 'domain_name', error: 'campo obbligatorio mancante (oppure full_domain)' };

  if (name.includes('.')) {
    const parsed = parseFull(name, 'domain_name');
    if (!parsed.ok) return parsed;
    if (tld && tld !== parsed.tld) {
      return { ok: false, field: 'tld', error: `tld "${tld}" incoerente con domain_name "${name}" (TLD "${parsed.tld}")` };
    }
    return parsed;
  }

  if (!LABEL_RE.test(name)) return { ok: false, field: 'domain_name', error: `"${name}" non è un nome di dominio valido` };
  if (!tld) return { ok: false, field: 'tld', error: 'campo obbligatorio mancante (oppure il dominio completo in domain_name o full_domain)' };
  const parsed = parseFull(`${name}.${tld}`, 'domain_name');
  if (!parsed.ok) return { ...parsed, field: 'tld' };
  if (parsed.tld !== tld || parsed.domain_name !== name) {
    return { ok: false, field: 'tld', error: `"${name}.${tld}" non corrisponde a nome "${name}" + TLD "${tld}"` };
  }
  return parsed;
}
