#!/usr/bin/env node
/* Data generator (plan Step 1). Run: node tools/gen-data.mjs
 *
 * Emits (deterministic bytes for identical inputs, re-runnable):
 *   data/countries.json — [{iso2, iso3, name}] from world-countries,
 *                         sorted by name, 2-space indent + trailing \n.
 *   data/cities.json    — {"<normalized city>": ["ISO2", ...]} from the
 *                         GeoNames cities15000 dump (population >= 100000,
 *                         plus every world-countries capital[0]), sorted
 *                         keys and values, 2-space indent + trailing \n.
 *                         On GeoNames fetch failure: {} + stderr warning.
 *
 * Dependency-free zip reading (zlib inflateRaw of local file entries).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import path from 'node:path';
import worldCountries from 'world-countries';
import TCF from '../lib/regions.js';

const { normalize } = TCF;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

/* ---------- data/countries.json ---------- */

const countries = worldCountries
  .filter((c) => c.cca2 && c.cca3 && c.name && c.name.common)
  .map((c) => ({ iso2: c.cca2, iso3: c.cca3, name: c.name.common }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const seenIso2 = new Set();
const uniqCountries = countries.filter((c) => {
  if (seenIso2.has(c.iso2)) return false;
  seenIso2.add(c.iso2);
  return true;
});

writeFileSync(
  path.join(dataDir, 'countries.json'),
  JSON.stringify(uniqCountries, null, 2) + '\n'
);

/* ---------- data/cities.json ---------- */

const GEO_NAMES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';

/* Minimal ZIP reader: first non-directory entry, method 8 (deflate ->
 * inflateRaw) or 0 (stored). Sizes are taken from the central directory,
 * which is always populated (unlike local headers when the data-descriptor
 * bit is set, as in the GeoNames dump). */
function zipFirstEntry(buf) {
  const dec = new TextDecoder();
  // Locate the End Of Central Directory record (scan backwards; it is
  // within the last 64KB + comment, well under the 22-byte max window).
  let eocd = -1;
  const minOff = Math.max(0, buf.length - 65557);
  for (let off = buf.length - 22; off >= minOff; off--) {
    if (buf.readUInt32LE(off) === 0x06054b50) {
      eocd = off;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(cd + 10);
    const cSize = buf.readUInt32LE(cd + 20);
    const nLen = buf.readUInt16LE(cd + 28);
    const xLen = buf.readUInt16LE(cd + 30);
    const cLen = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    const name = dec.decode(buf.subarray(cd + 46, cd + 46 + nLen));
    // Data offset comes from the local header (name/extra can differ in length).
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    cd += 46 + nLen + xLen + cLen;
    if (name.endsWith('/')) continue;
    if (method === 8) return zlib.inflateRawSync(buf.subarray(start, start + cSize));
    if (method === 0) return buf.subarray(start, start + cSize);
    throw new Error('unsupported zip compression method ' + method);
  }
  throw new Error('no readable entry in zip');
}

async function fetchCitiesTsv() {
  const res = await fetch(GEO_NAMES_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('utf-8').decode(zipFirstEntry(buf));
}

let cities = {};
try {
  const tsv = await fetchCitiesTsv();
  const byName = new Map(); // normalized city -> Set<ISO2>

  const rows = tsv
    .split('\n')
    .map((l) => (l ? l.split('\t') : null))
    .filter((c) => c && c.length >= 14 && c[1] && /^[A-Z]{2}$/.test(c[8] || ''));

  /* Detect the population column: the column (index >= 8) holding the
   * most integer values >= 100000. GeoNames has shifted this column
   * between dump revisions (13 in the classic 18-column layout, 14 in
   * the current 19-column layout), so do not hardcode it. */
  let minLen = Infinity;
  for (const c of rows) if (c.length < minLen) minLen = c.length;
  let popIdx = -1;
  let best = 0;
  for (let ci = 8; ci < minLen; ci++) {
    let n = 0;
    for (const c of rows) {
      const v = parseInt(c[ci], 10);
      if (Number.isFinite(v) && v >= 100000) n++;
    }
    if (n > best) {
      best = n;
      popIdx = ci;
    }
  }
  if (popIdx < 0 || best < 100) throw new Error('could not detect population column');

  for (const c of rows) {
    const pop = parseInt(c[popIdx], 10);
    if (!Number.isFinite(pop) || pop < 100000) continue;
    const k = normalize(c[1]);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(c[8]);
  }

  /* Every world-countries capital[0] -> cca2 (catches capitals under 100k). */
  for (const c of worldCountries) {
    const cap = c.capital && c.capital[0];
    if (!cap || !c.cca2) continue;
    const k = normalize(cap);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(c.cca2);
  }

  for (const k of [...byName.keys()].sort()) {
    cities[k] = [...byName.get(k)].sort();
  }
} catch (err) {
  process.stderr.write(
    `warning: cities.json left empty (GeoNames fetch failed: ${err.message})\n`
  );
  cities = {};
}

writeFileSync(
  path.join(dataDir, 'cities.json'),
  JSON.stringify(cities, null, 2) + '\n'
);

console.log(`data/countries.json: ${uniqCountries.length} entries`);
console.log(`data/cities.json: ${Object.keys(cities).length} entries`);
