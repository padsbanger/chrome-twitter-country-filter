/* Tests for lib/regions.js (plan Step 8). Run: node --test test/
 * Loads the generated data/countries.json + data/cities.json from disk;
 * no network needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const require_ = createRequire(import.meta.url);

/* lib/regions.js is a classic dual script: lib/package.json marks it
 * CommonJS, so require() returns the TCF object. Fallback (older/odd
 * Node versions or if the nested package.json is removed): evaluate
 * the source in a CJS-style function scope. */
function loadTCF() {
  let T;
  try {
    T = require_(path.join(repo, 'lib', 'regions.js'));
  } catch (e) {
    T = null;
  }
  if (T && typeof T.isoToFlag === 'function') return T;
  const src = readFileSync(path.join(repo, 'lib', 'regions.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

const TCF = loadTCF();
const countries = JSON.parse(readFileSync(path.join(repo, 'data', 'countries.json'), 'utf8'));
const cities = JSON.parse(readFileSync(path.join(repo, 'data', 'cities.json'), 'utf8'));
const names = TCF.buildNameMap(countries, false);
const namesIntl = TCF.buildNameMap(countries, true);

test('normalize', () => {
  assert.equal(TCF.normalize('United States'), 'united states');
  assert.equal(TCF.normalize('Ürümqi'), 'urumqi');
  assert.equal(TCF.normalize('  a-b  c '), 'a b c');
  assert.equal(TCF.normalize('ﬁre'), 'fire'); // NFKD ligature
  assert.equal(TCF.normalize(''), '');
  assert.equal(TCF.normalize(null), '');
  assert.equal(TCF.normalize('EAST Asia & Pacific'), 'east asia pacific');
});

test('flag round-trips and negatives', () => {
  assert.equal(TCF.isoToFlag('US'), '🇺🇸');
  assert.equal(TCF.flagToIso('🇺🇸'), 'US');
  assert.equal(TCF.isoToFlag('de'), '🇩🇪'); // case-insensitive
  assert.equal(TCF.flagToIso('🇩🇪'), 'DE');
  for (const c of ['FR', 'JP', 'BR', 'ZZ']) {
    assert.equal(TCF.flagToIso(TCF.isoToFlag(c)), c);
  }
  assert.equal(TCF.flagToIso('US'), null); // plain letters are not a flag
  assert.equal(TCF.flagToIso(''), null);
  assert.equal(TCF.flagToIso(null), null);
  assert.equal(TCF.flagToIso('🇺🇸🇩'), null); // three code points
  assert.equal(TCF.isoToFlag('USA'), null);
  assert.equal(TCF.isoToFlag('U'), null);
  assert.equal(TCF.isoToFlag(42), null);
});

test('TERRITORIES and REGIONS shape', () => {
  /* NOTE: the plan text says "the 33 ISO2 codes" but its own "exactly"
   * list (and the shared contract) enumerate 34 distinct codes; the
   * explicit list is authoritative. */
  const PLAN_TERRITORIES =
    'AI AW BM VG CX CK CW FK FO GF PF GI GL GP GU GG JE MO MQ YT MS NC MP RE BL MF PM SX TC VI WF EH AS AX'.split(' ');
  assert.equal(TCF.TERRITORIES.length, PLAN_TERRITORIES.length);
  assert.deepEqual([...TCF.TERRITORIES].sort(), [...PLAN_TERRITORIES].sort());
  assert.equal(Object.keys(TCF.REGIONS).length, 14);
  assert.deepEqual(TCF.REGIONS['europe'], { abbr: 'EUR', flag: '🇪🇺' });
  assert.equal(TCF.REGIONS['eastern europe non eu'].abbr, 'EEUR');
  assert.equal(TCF.REGIONS['west asia'].abbr, 'WAS');
  for (const [k, v] of Object.entries(TCF.REGIONS)) {
    assert.equal(k, TCF.normalize(k)); // keys are normalized names
    assert.ok(typeof v.abbr === 'string' && v.abbr.length >= 3);
    assert.ok(typeof v.flag === 'string' && v.flag.length > 0);
  }
});

test('buildNameMap sources and merge order', () => {
  assert.ok(names instanceof Map);
  assert.ok(names.size > 200);
  assert.equal(names.get('united states'), 'US'); // canonical
  assert.equal(names.get('usa'), 'US'); // alias
  assert.equal(names.get('deutschland'), 'DE'); // alias
  assert.equal(names.get('uk'), 'GB'); // alias
  assert.equal(names.get('holland'), 'NL'); // alias
  assert.equal(names.get('de'), 'DE'); // iso2 code
  assert.equal(names.get('fra'), 'FR'); // iso3 code
  assert.equal(names.get('usa'), 'US'); // iso3 code
  // Canonical names (earlier source) beat aliases pointing elsewhere.
  const m2 = TCF.buildNameMap([{ iso2: 'ZZ', iso3: 'ZZZ', name: 'America' }], false);
  assert.equal(m2.get('america'), 'ZZ');
});

test('buildNameMap withIntl adds CLDR names without breaking earlier ones', () => {
  assert.ok(namesIntl.size >= names.size);
  assert.equal(namesIntl.get('united states'), 'US');
  // Canonical name (world-countries v5) - in the plain map:
  assert.equal(names.get('republic of the congo'), 'CG');
  // world-countries v5 includes some territories, so their plain names
  // are canonical (earlier source):
  assert.equal(names.get('faroe islands'), 'FO');
  assert.equal(names.get('western sahara'), 'EH');
  // CLDR long names not present as canonical/alias/code:
  assert.equal(names.get('antigua barbuda'), undefined);
  assert.equal(namesIntl.get('antigua barbuda'), 'AG'); // "Antigua & Barbuda"
  assert.equal(names.get('myanmar burma'), undefined);
  assert.equal(namesIntl.get('myanmar burma'), 'MM'); // "Myanmar (Burma)"
});

test('resolveBasedIn order', () => {
  assert.deepEqual(TCF.resolveBasedIn('United States', names), { kind: 'country', iso: 'US' });
  assert.deepEqual(TCF.resolveBasedIn('🇩🇪', names), { kind: 'country', iso: 'DE' });
  assert.equal(TCF.resolveBasedIn('EU', names), null); // 2-letter but not a code
  assert.deepEqual(TCF.resolveBasedIn('Europe', names), {
    kind: 'region',
    name: 'Europe',
    abbr: 'EUR',
  });
  assert.deepEqual(TCF.resolveBasedIn('de', names), { kind: 'country', iso: 'DE' }); // 2-letter code
  assert.deepEqual(TCF.resolveBasedIn('DE', names), { kind: 'country', iso: 'DE' });
  assert.equal(TCF.resolveBasedIn('Nowhere Land', names), null);
  assert.equal(TCF.resolveBasedIn(null, names), null);
  assert.equal(TCF.resolveBasedIn('   ', names), null);
  assert.equal(TCF.resolveBasedIn(123, names), null);
});

test('resolveAccount priority: country-from-X > location-text country > region', () => {
  assert.deepEqual(TCF.resolveAccount('Europe', 'Berlin', names, cities), {
    country: 'DE',
    source: 'location',
  });
  assert.deepEqual(TCF.resolveAccount('United States', 'Berlin', names, cities), {
    country: 'US',
    source: 'x',
  });
  assert.deepEqual(TCF.resolveAccount(null, 'Paris', names, cities), {
    country: 'FR',
    source: 'location',
  });
  const regionOnly = TCF.resolveAccount('Europe', null, names, cities);
  assert.equal(regionOnly.source, 'x');
  assert.equal(regionOnly.region.abbr, 'EUR');
  assert.equal(regionOnly.region.kind, 'region');
  assert.equal(TCF.resolveAccount(null, 'Earth', names, cities), null);
  assert.equal(TCF.resolveAccount(null, null, names, cities), null);
});

test('resolveLocationText (plan Step 8 cases, real generated data)', () => {
  assert.equal(TCF.resolveLocationText('Paris', names, cities), 'FR');
  assert.equal(TCF.resolveLocationText('New York, USA', names, cities), 'US');
  assert.equal(TCF.resolveLocationText('Paris, France', names, cities), 'FR');
  assert.equal(TCF.resolveLocationText('Dubai', names, cities), 'AE');
  assert.equal(TCF.resolveLocationText('USA', names, cities), 'US');
  assert.equal(TCF.resolveLocationText('Deutschland', names, cities), 'DE');
  assert.equal(TCF.resolveLocationText('London', names, cities), null);
  assert.equal(TCF.resolveLocationText('London, Canada', names, cities), 'CA');
  assert.equal(TCF.resolveLocationText('Earth', names, cities), null);
  assert.equal(TCF.resolveLocationText(null, names, cities), null);
  /* DEVIATION from plan Step 8 (documented, not silent): the plan
   * expects resolveLocationText('New York, Texas') -> 'US' on the
   * assumption that GeoNames cities15000 lists NYC as "New York".
   * The current dump lists it as "New York City" (no "New York" row),
   * so the 'new york' city key does not exist and the literal plan
   * case resolves to null against the real generated data. The rule
   * itself (single-country city part + trailing non-country part) is
   * pinned by the synthetic tests below, and works on real data via
   * the actual city name: */
  assert.equal(TCF.resolveLocationText('New York City, Texas', names, cities), 'US');
  assert.equal(TCF.resolveLocationText('New York, Texas', names, cities), null);
});

test('city-part ambiguity rules (synthetic city maps)', () => {
  const syn = { testville: ['XX', 'YY'], singleton: ['AA'] };
  assert.equal(TCF.resolveLocationText('Testville', names, syn), null);
  assert.equal(TCF.resolveLocationText('Singleton', names, syn), 'AA');
  // Multi-country city alongside a single-country city -> ambiguous -> null.
  assert.equal(TCF.resolveLocationText('Singleton, Testville', names, syn), null);
  assert.equal(TCF.resolveLocationText('Testville, Singleton', names, syn), null);
  // A country-name part always wins over the city walk.
  assert.equal(TCF.resolveLocationText('Testville, France', names, syn), 'FR');
  // Right-most single-country city part wins when none is ambiguous.
  assert.equal(
    TCF.resolveLocationText('Berlin, Paris', names, { berlin: ['DE'], paris: ['FR'] }),
    'FR'
  );
});

test('data files sanity (generated artifacts)', () => {
  assert.ok(Array.isArray(countries) && countries.length >= 249);
  for (const c of countries) {
    assert.ok(/^[A-Z]{2}$/.test(c.iso2));
    assert.ok(/^[A-Z]{3}$/.test(c.iso3));
    assert.ok(typeof c.name === 'string' && c.name.length > 0);
  }
  // Sorted by name.
  for (let i = 1; i < countries.length; i++) {
    assert.ok(countries[i - 1].name <= countries[i].name);
  }
  assert.ok(Object.keys(cities).length >= 1000, 'cities.json populated');
  for (const [k, v] of Object.entries(cities)) {
    assert.equal(k, TCF.normalize(k));
    assert.ok(Array.isArray(v) && v.length >= 1);
    assert.deepEqual(v, [...v].sort());
  }
  // Plan-pinned data facts:
  assert.deepEqual(cities['paris'], ['FR']);
  assert.deepEqual(cities['dubai'], ['AE']);
  assert.ok(cities['london'].includes('GB') && cities['london'].includes('CA'));
  assert.ok(cities['london'].length >= 2);
});
