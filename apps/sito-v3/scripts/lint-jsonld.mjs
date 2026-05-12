#!/usr/bin/env node
// Lint JSON-LD blocks emitted on a given URL.
// Usage: node scripts/lint-jsonld.mjs <url> [<url> ...]
const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: lint-jsonld.mjs <url> [<url> ...]');
  process.exit(1);
}

const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

function flagsForNode(it) {
  const flags = [];
  if (it.priceRange) flags.push('HAS priceRange (FAIL)');
  if (it.review || it.Review) flags.push('HAS review (FAIL)');
  if (it.aggregateRating || it.AggregateRating) flags.push('HAS aggregateRating (FAIL)');
  if (it['@type'] === 'OfferCatalog') {
    const ile = it.itemListElement || [];
    flags.push(`OfferCatalog with ${ile.length} offers`);
    const withPrice = ile.filter((o) => o.price || o.priceCurrency || o.priceRange).length;
    if (withPrice) flags.push(`${withPrice} offers with price field (FAIL)`);
    const noItem = ile.filter((o) => !o.itemOffered).length;
    if (noItem) flags.push(`${noItem} offers without itemOffered (FAIL)`);
    const noName = ile.filter((o) => !(o.itemOffered && o.itemOffered.name)).length;
    if (noName) flags.push(`${noName} offers without itemOffered.name (FAIL)`);
  }
  return flags;
}

let totalFail = 0;

for (const url of urls) {
  console.log(`\n=== ${url} ===`);
  const res = await fetch(url);
  const html = await res.text();
  const items = [];
  let m;
  while ((m = re.exec(html))) items.push(m[1]);
  console.log(`Found ${items.length} JSON-LD blocks`);

  for (let i = 0; i < items.length; i++) {
    try {
      const json = JSON.parse(items[i]);
      const arr = Array.isArray(json) ? json : json['@graph'] ? json['@graph'] : [json];
      for (let j = 0; j < arr.length; j++) {
        const node = arr[j];
        const flags = flagsForNode(node);
        const fails = flags.filter((f) => f.includes('FAIL')).length;
        totalFail += fails;
        const t = JSON.stringify(node['@type']);
        console.log(`  block#${i}.${j} @type=${t}${flags.length ? ' [' + flags.join('; ') + ']' : ''}`);
      }
    } catch (err) {
      console.log(`  block#${i} PARSE ERROR: ${err.message}`);
      totalFail++;
    }
  }
}

console.log(`\nTotal FAIL flags: ${totalFail}`);
process.exit(totalFail > 0 ? 1 : 0);
