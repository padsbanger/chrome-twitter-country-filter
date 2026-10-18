/* Twitter Country Filter — pure resolution core (plan Step 2).
 *
 * Classic script (no ESM syntax): loaded by the extension's content
 * scripts (page world + content world, see manifest.json) and by Node
 * for tests and tools/gen-data.mjs. `lib/package.json` marks this
 * directory CommonJS so `require('./lib/regions.js')` returns the TCF
 * object under a root "type": "module" package; browsers ignore it.
 * No DOM or chrome references at top level.
 */
(function () {
  'use strict';

  /* NFKD, strip combining marks, lowercase, collapse runs of
   * non-[a-z0-9] to single spaces, trim. */
  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /* ISO 3166-1 alpha-2 -> flag emoji (regional indicators). */
  function isoToFlag(iso2) {
    if (typeof iso2 !== 'string' || !/^[A-Za-z]{2}$/.test(iso2)) return null;
    const u = iso2.toUpperCase();
    return String.fromCodePoint(
      0x1F1E6 + (u.charCodeAt(0) - 65),
      0x1F1E6 + (u.charCodeAt(1) - 65)
    );
  }

  /* Flag emoji (exactly two regional-indicator code points) -> ISO2, or null. */
  function flagToIso(flag) {
    if (typeof flag !== 'string') return null;
    const cps = Array.from(flag);
    if (cps.length !== 2) return null;
    let out = '';
    for (const cp of cps) {
      const n = cp.codePointAt(0);
      if (n < 0x1F1E6 || n > 0x1F1FF) return null;
      out += String.fromCharCode(n - 0x1F1E6 + 65);
    }
    return out;
  }

  /* 33 non-ISO-3166-1 territories X may report (not in data/countries.json). */
  const TERRITORIES = [
    'AI', 'AW', 'BM', 'VG', 'CX', 'CK', 'CW', 'FK', 'FO', 'GF',
    'PF', 'GI', 'GL', 'GP', 'GU', 'GG', 'JE', 'MO', 'MQ', 'YT',
    'MS', 'NC', 'MP', 'RE', 'BL', 'MF', 'PM', 'SX', 'TC', 'VI',
    'WF', 'EH', 'AS', 'AX',
  ];

  /* Informal names -> ISO2. Every alias is normalized with normalize()
   * in buildNameMap before lookup. */
  const ALIASES = {
    US: ['USA', 'U.S.', 'U.S.A.', 'America', 'United States of America'],
    GB: ['UK', 'U.K.', 'Great Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
    DE: ['Germany', 'Deutschland'],
    FR: ['France', 'French Republic'],
    RU: ['Russia', 'Russian Federation'],
    CN: ["China", "People's Republic of China"],
    JP: ['Nippon'],
    KR: ['South Korea'],
    KP: ['North Korea'],
    TR: ['Turkey', 'Turkiye'],
    IR: ['Iran'],
    NL: ['Holland'],
    SA: ['Saudi Arabia'],
    AE: ['UAE', 'United Arab Emirates'],
    PL: ['Poland'],
    IT: ['Italy', 'Italia'],
    ES: ['Spain', 'España'],
    CH: ['Switzerland', 'Schweiz'],
    AT: ['Austria', 'Österreich'],
    BE: ['Belgium', 'België'],
    IE: ['Ireland', 'Éire'],
    CZ: ['Czech Republic', 'Czechia'],
    GR: ['Greece', 'Hellas'],
    MM: ['Burma'],
    CD: ['Democratic Republic of the Congo', 'Congo (Kinshasa)'],
    CG: ['Republic of Congo', 'Congo (Brazzaville)'],
    BO: ['Bolivia (Plurinational State of)'],
  };

  /* The 14 region names X reports, keyed by normalize(name)
   * (plan Step 2). */
  const REGIONS = {
    'africa': { abbr: 'AFR', flag: '🌏' },
    'australasia': { abbr: 'AUS', flag: '🌏' },
    'east asia pacific': { abbr: 'EAP', flag: '🌏' },
    'eastern europe': { abbr: 'EEUR', flag: '🌏' },
    'eastern europe non eu': { abbr: 'EEUR', flag: '🌏' },
    'europe': { abbr: 'EUR', flag: '🇪🇺' },
    'north africa': { abbr: 'NAF', flag: '🌍' },
    'north america': { abbr: 'NAM', flag: '🌎' },
    'south america': { abbr: 'SAM', flag: '🌎' },
    'east asia': { abbr: 'EAS', flag: '🌏' },
    'central asia': { abbr: 'CAS', flag: '🌏' },
    'south asia': { abbr: 'SAS', flag: '🌏' },
    'southeast asia': { abbr: 'SEAS', flag: '🌏' },
    'west asia': { abbr: 'WAS', flag: '🌍' },
  };

  /* normalized name -> iso2. Merge order (later sources never overwrite
   * earlier ones): canonical names, ALIASES, ISO2 codes, ISO3 codes
   * (from the passed entries' iso3 field), then Intl.DisplayNames
   * short/long/narrow over the passed iso2s + TERRITORIES — only names
   * that resolve to exactly one code of that union are taken. */
  function buildNameMap(countries, withIntl) {
    const names = new Map();
    const put = (key, iso2) => {
      const k = normalize(key);
      if (k && !names.has(k)) names.set(k, iso2);
    };
    for (const c of countries) put(c.name, c.iso2);
    for (const iso2 of Object.keys(ALIASES)) {
      for (const alias of ALIASES[iso2]) put(alias, iso2);
    }
    for (const c of countries) put(c.iso2, c.iso2);
    for (const c of countries) if (c.iso3) put(c.iso3, c.iso2);
    if (withIntl) {
      try {
        const union = new Set();
        for (const c of countries) union.add(c.iso2);
        for (const t of TERRITORIES) union.add(t);
        const nameToCodes = new Map();
        const styles = [
          new Intl.DisplayNames(['en'], { type: 'region', style: 'short' }),
          new Intl.DisplayNames(['en'], { type: 'region', style: 'long' }),
          new Intl.DisplayNames(['en'], { type: 'region', style: 'narrow' }),
        ];
        for (const code of union) {
          for (const d of styles) {
            let name;
            try {
              name = d.of(code);
            } catch (e) {
              name = undefined;
            }
            if (!name) continue;
            const k = normalize(name);
            if (!k) continue;
            if (!nameToCodes.has(k)) nameToCodes.set(k, new Set());
            nameToCodes.get(k).add(code);
          }
        }
        for (const [k, codes] of nameToCodes) {
          if (codes.size === 1) names.set(k, [...codes][0]);
        }
      } catch (e) {
        /* Intl.DisplayNames unavailable: country/alias/ISO resolution still works */
      }
    }
    return names;
  }

  /* order: flagToIso -> 2-letter code (if in name map) -> name map -> REGIONS -> null */
  function resolveBasedIn(basedIn, names) {
    if (typeof basedIn !== 'string' || !basedIn.trim()) return null;
    const flag = flagToIso(basedIn);
    if (flag) return { kind: 'country', iso: flag };
    const upper = basedIn.toUpperCase();
    if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) {
      const iso = names.get(normalize(upper));
      if (iso) return { kind: 'country', iso };
    }
    const k = normalize(basedIn);
    const iso = names.get(k);
    if (iso) return { kind: 'country', iso };
    const region = REGIONS[k];
    if (region) return { kind: 'region', name: basedIn, abbr: region.abbr };
    return null;
  }

  /* Returns iso2 or null (plan Step 2, rules 1–5). */
  function resolveLocationText(text, names, cities) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const whole = normalize(text);
    if (whole && names.has(whole)) return names.get(whole);
    const parts = String(text)
      .split(/,|·|—| - /)
      .map((p) => normalize(p))
      .filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (names.has(parts[i])) return names.get(parts[i]);
    }
    if (cities) {
      let candidate = null;
      let ambiguous = false;
      for (let i = parts.length - 1; i >= 0; i--) {
        const vals = cities[parts[i]];
        if (!vals) continue;
        if (vals.length === 1) {
          if (candidate === null) candidate = vals[0];
        } else {
          ambiguous = true;
        }
      }
      if (ambiguous) return null;
      if (candidate !== null) return candidate;
    }
    return null;
  }

  /* country-from-X > location-text country > region-from-X > null */
  function resolveAccount(basedIn, location, names, cities) {
    const r = resolveBasedIn(basedIn, names);
    if (r && r.kind === 'country') return { country: r.iso, source: 'x' };
    const iso = resolveLocationText(location, names, cities);
    if (iso) return { country: iso, source: 'location' };
    if (r && r.kind === 'region') return { region: r, source: 'x' };
    return null;
  }

  const TCF = {
    normalize,
    isoToFlag,
    flagToIso,
    TERRITORIES,
    ALIASES,
    REGIONS,
    buildNameMap,
    resolveBasedIn,
    resolveLocationText,
    resolveAccount,
  };

  if (typeof module !== 'undefined') {
    module.exports = TCF;
  } else {
    window.TCF = TCF;
  }
})();
