# Plan: Twitter/X Country Flag & Filter Extension (Chrome/Brave)

## Context

Build a Manifest V3 browser extension (Chrome + Brave, no build step, no runtime deps) in the empty repo `/home/strielok/Projects/chrome-twitter-country-filter` that, on `x.com`/`twitter.com`:

1. Shows the country-of-origin flag of each tweet's author account, inline next to the author name.
2. Lets the user pick countries (toolbar popup) whose tweets are hidden from the timeline.

Country of origin is what X attributes to the account, resolved in this priority:
1. `about_profile.account_based_in` from X's `AboutAccountQuery` response (canonical English country name, a region name, or a flag emoji) — authoritative.
2. The account's free-text `location` field (from the same response, or from any intercepted page response) matched against a bundled dataset (country names via `Intl.DisplayNames` CLDR + alias table, cities via generated GeoNames file).
3. Unresolvable → no flag shown; hidden only if the "hide unknown" option is on.

Key facts established by research (source: the mature X-Pat extension, `asmyshlyaev177/x-profile-location`, current main, Aug 2026 measurements):

- The home-timeline GraphQL `User` nodes **no longer carry the location text**: `legacy` is empty; only `profile_bio.description` is present. So per-tweet flags cannot come from timeline payloads alone — they need per-account lookups or free interception of the page's own profile requests.
- Authoritative lookup: `GET https://x.com/i/api/graphql/<queryId>/AboutAccountQuery?variables={"screenName":"<handle>"}` with the page session's headers. Response: `data.user_result_by_screen_name.result` with `about_profile: {account_based_in, location_accurate, source}` and `legacy: {location, ...}`. Observed queryId: `XRqGa7EeokUU5kppkh13EA` (may rotate — see runtime sniffing below).
- X rate-limits this lookup: 50 per 15 minutes; 429 responses carry `x-rate-limit-reset` (seconds).
- Required request headers (all captured from the page's own GraphQL requests, never hard-coded): `authorization`, `x-twitter-client-language`, `x-twitter-active-user`, `x-csrf-token` (fall back to the `ct0` cookie via `document.cookie`, which is readable).
- DOM (2026): tweet row = `article[data-testid="tweet"]`; author name block = `[data-testid="User-Name"]` (fallback `UserName`); profile links inside it match `a[href]` with href `^/([A-Za-z0-9_]{1,50})$`; quoted tweets = `div[role="link"]` containing its own name block where the author is plain text (last `@token`).
- `account_based_in` values use X's canonical vocabulary: English country names ("United States"), region names ("Europe", "North America"), or a flag emoji. Regions have no single flag: display a 3-letter chip (e.g. `EUR`).

No backend, no API keys, no analytics. The only network calls the extension makes are to X's own endpoint, with the user's own session.

## Approach

### Step 0 — Repo scaffolding

Create exactly these files (no build tooling, no `package.json` runtime deps):

```
manifest.json
background.js
lib/regions.js            # pure logic, node-testable (no chrome/DOM refs at top level)
page/patch.js             # MAIN-world: request/response interception, lookup execution
content/selectors.js      # all X DOM selectors in one place
content/content.js        # observer, cache, rendering, hiding, pacing
popup/popup.html
popup/popup.css
popup/popup.js
data/cities.json          # generated, committed (Step 1)
data/countries.json       # generated, committed (Step 1)
tools/gen-data.mjs        # one-shot data generator
tools/gen-icons.mjs       # one-shot icon generator
test/regions.test.mjs     # node --test
icons/icon16.png icon48.png icon128.png   # generated, committed
README.md
```

`manifest.json` (MV3, Chrome/Brave):

```json
{
  "manifest_version": 3,
  "name": "Twitter Country Filter",
  "description": "Show each tweet author's country flag and hide tweets from countries you choose.",
  "version": "1.0.0",
  "permissions": ["storage"],
  "background": { "service_worker": "background.js" },
  "action": {
    "default_title": "Twitter Country Filter",
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "web_accessible_resources": [
    {
      "resources": ["data/countries.json", "data/cities.json"],
      "matches": ["*://*.x.com/*", "*://x.com/*", "*://*.twitter.com/*", "*://twitter.com/*"]
    }
  ],
    {
      "matches": ["*://*.x.com/*", "*://x.com/*", "*://*.twitter.com/*", "*://twitter.com/*"],
      "js": ["lib/regions.js", "page/patch.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["*://*.x.com/*", "*://x.com/*", "*://*.twitter.com/*", "*://twitter.com/*"],
      "js": ["lib/regions.js", "content/selectors.js", "content/content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

Notes: `"world": "MAIN"` (Chrome 111+/Brave equivalent) is what makes the page-context interception possible without injecting script tags; no `host_permissions` needed because all X requests run in the page's own context. `web_accessible_resources` IS required for the two data files: current Chromium (verified 152) makes content-script `fetch()` requests from the page's origin, so a content-script fetch of `chrome.runtime.getURL('data/…')` fails without the WAR entry (service-worker fetch works; the WAR entry is also harmless on older Chromium). `lib/regions.js` is listed in both content scripts so one pure module serves page world, content world, and (via `import`) node tests.

### Step 1 — Data generation (`tools/gen-data.mjs`)

One-shot script, run once at implementation time, outputs committed. `package.json` with only dev deps for generation is allowed (`npm i -D world-countries`).

- `data/countries.json` — from the `world-countries` npm package (MIT): array of `{"iso2": cca2, "iso3": cca3, "name": name.common}` for all 249 entries, sorted by name.
- `data/cities.json` — from GeoNames `https://download.geonames.org/export/dump/cities15000.zip` (TSV: `geonameid,name,asciiname,alternatenames,countrycode,latitude,longitude,fcl,featurecode,countryid,admin1,admin2,admin3,admin4,population,alt...`). Keep rows with `population >= 100000` (~1,200 cities). Also add every capital from `world-countries` (`capital[0]` → `cca2`), which catches small capitals under 100k. Output shape: `{"<normalized city>": ["<ISO2>", ...]}` where the value lists every country the normalized name maps to (usually one; e.g. genuinely ambiguous names keep all). Normalization: `String.normalize('NFKD')`, strip combining marks, lowercase, replace runs of non-`[a-z0-9]` with a single space, trim.
- If the GeoNames download fails: emit `data/cities.json` as `{}` and print a warning — the extension works without city matching (country-name matching still applies). Do not fail the build.

The script must be deterministic (same inputs → same bytes) and re-runnable; it is committed so data can be regenerated when GeoNames changes.

### Step 2 — `lib/regions.js` (pure resolution core)

A single classic script exposing `window.TCF` in browsers and `module.exports` in node (the `typeof module` idiom). Functions:

- `normalize(s: string): string` — as in Step 1.
- `isoToFlag(iso2: string): string` — regional-indicator pair: `String.fromCodePoint(...iso2.toUpperCase().replace(/./g, c => 0x1F1E6 + c.charCodeAt(0) - 65))`.
- `flagToIso(flag: string): string | null` — inverse: exactly 2 code points, each in `0x1F1E6..0x1F1FF` → letters, else `null`.
- `TERRITORIES: string[]` — the 33 ISO2 codes of subnational territories X reports in `account_based_in` (X's own flag vocabulary): exactly `AI AW BM VG CX CK CW FK FO GF PF GI GL GP GU GG JE MO MQ YT MS NC MP RE BL MF PM SX TC VI WF EH AS AX`.
- `ALIASES: Record<string, string[]>` — informal names → ISO2. MUST contain at least: `US: ["USA","U.S.","U.S.A.","America","United States of America"]`, `GB: ["UK","U.K.","Great Britain","England","Scotland","Wales","Northern Ireland"]`, `DE: ["Germany","Deutschland"]`, `FR: ["France","French Republic"]`, `RU: ["Russia","Russian Federation"]`, `CN: ["China","People's Republic of China"]`, `JP: ["Nippon"]`, `KR: ["South Korea"]`, `KP: ["North Korea"]`, `TR: ["Turkey","Turkiye"]`, `IR: ["Iran"]`, `NL: ["Holland"]`, `SA: ["Saudi Arabia"]`, `AE: ["UAE"]`, `PL: ["Poland"]`. More entries allowed; each alias normalized with `normalize()` before lookup.
- `REGIONS: Record<string, {abbr: string, flag: string}>` — exactly the 14 region names X reports:
  `Africa AFR 🌏`, `Australasia AUS 🌏`, `East Asia & Pacific EAP 🌏`, `Eastern Europe EEUR 🌏`, `Eastern Europe (Non-EU) EEUR 🌏`, `Europe EUR 🇪🇺`, `North Africa NAF 🌍`, `North America NAM 🌎`, `South America SAM 🌎`, `East Asia EAS 🌏`, `Central Asia CAS 🌏`, `South Asia SAS 🌏`, `Southeast Asia SEAS 🌏`, `West Asia WAS 🌍`.
- `buildNameMap(countries: {iso2, name}[], withIntl: boolean): Map<string,string>` — maps normalized name → iso2. Sources merged: `countries` list (canonical names); `ALIASES`; 2-letter and 3-letter ISO codes (ISO3 built from a static `ISO3: Record<iso3, iso2>` table covering the same 249 — generated into `data/countries.json` alongside, i.e. country entries also carry `iso3`); and, when `withIntl` (browser only), `Intl.DisplayNames(['en'], {type: 'region'})` short/long/narrow styles over the union of the 249 iso2 codes + `TERRITORIES` (skip CLDR names that resolve to codes outside that union). Later sources must not overwrite earlier ones (canonical/alias precedence over CLDR spellings).
- `resolveBasedIn(basedIn: string | null, names: Map): {kind:'country', iso: string} | {kind:'region', name: string, abbr: string} | null` — order: `flagToIso` → 2-letter code (uppercased, if in name map) → `names.get(normalize(basedIn))` → `REGIONS[normalize(basedIn)]` (exact, case-insensitive via normalize) → `null`.
- `resolveLocationText(text: string | null, names: Map, cities: Record<string,string[]>): string | null` (returns iso2 or null) —
  1. `null`/empty → `null`.
  2. Whole normalized text is in `names` → that iso2.
  3. Split raw text on `,`, `·`, `—`, ` - ` (keep order); walk parts **last to first**: first part that hits `names` → return. (Right-most wins: "New York, USA" → US.)
  4. Walk parts last to first again: first part that hits `cities` with a **single**-country value → return that. If a part hits a multi-country city, remember it; only use it if no later city part is unambiguous (ambiguity → `null`).
  5. Else `null`.
- `resolveAccount(basedIn: string | null, location: string | null, names, cities)` — final per-account answer:
  1. `r = resolveBasedIn(basedIn, names)`; if `r.kind === 'country'` → return `{country: r.iso, source: 'x'}`.
  2. If `r.kind === 'region'` or `r === null`: `iso = resolveLocationText(location, names, cities)`; if `iso` → `{country: iso, source: 'location'}`.
  3. If step 2 failed and step 1 gave a region → `{region: r, source: 'x'}`.
  4. Else `null`.

Data loading in the browser: `content/content.js` fetches `chrome.runtime.getURL('data/countries.json')` and `'data/cities.json'` (extension resources; no host permission needed) and calls `buildNameMap(..., true)`.

### Step 3 — `page/patch.js` (MAIN world)

IIFE with `window.__TCF_PATCHED__` guard. Responsibilities:

1. **Header capture.** Wrap `window.fetch` and `XMLHttpRequest` (open/setRequestHeader/send). For the first request whose URL contains `x.com/i/api`, record request headers (lowercased): `authorization`, `x-twitter-client-language`, `x-twitter-active-user`, `x-csrf-token` (if present). Then `window.dispatchEvent(new CustomEvent('tcf:headers', {detail:{ok:true}}))` once. Re-capture (update) `authorization`/`x-csrf-token` on every subsequent `/i/api` request (tokens rotate).
2. **queryId sniffing.** Default `QUERY_ID = 'XRqGa7EeokUU5kppkh13EA'`. On any observed page request URL matching `/i/api/graphql/([A-Za-z0-9]+)/AboutAccountQuery`, update the stored queryId (rotation resilience).
3. **Response interception.** For every fetch/XHR whose URL contains `x.com/i/api`: on success, parse the JSON (defensive `try/catch`; for fetch use `response.clone().json()`, for XHR `load` + `JSON.parse(xhr.responseText)`). Deep-scan (max depth 25, skip arrays/objects beyond, skip strings longer than 5000 chars) for objects with `__typename === 'User'` and a `core.screen_name` string. For each, emit `{screen_name, name: core.name ?? null, location: legacy?.location ?? null, based_in: about_profile?.account_based_in ?? null}` (include only non-null fields) into one batched `CustomEvent('tcf:users', {detail: {users: [...]}})` dispatched at most once per 250ms. This captures free data from HomeTimeline, TweetDetail, hover `UserByScreenName`, profile `AboutAccountQuery`, etc.
4. **Lookup execution.** Listen for `CustomEvent('tcf:lookup')` (`detail: {screen_name, reqId}`). If headers not captured yet → respond `tcf:user-result {screen_name, reqId, ok:false, reason:'no-headers'}`. Else `fetch('https://x.com/i/api/graphql/' + QUERY_ID + '/AboutAccountQuery?variables=' + encodeURIComponent(JSON.stringify({screenName})), {method:'GET', credentials:'include', headers: {authorization, 'x-twitter-client-language', 'x-twitter-active-user', 'content-type':'application/json', 'x-csrf-token': captured['x-csrf-token'] || ct0FromCookie}})`. Read `x-rate-limit-limit/remaining/reset` and `status`. Parse `data.user_result_by_screen_name.result` → `{based_in: result.about_profile?.account_based_in ?? null, location: result.legacy?.location ?? null, ok: true, rate: {status, limit, remaining, reset}}`; if `status === 404` (rotated queryId) set `ok:false, reason:'query-404'`. Dispatch `CustomEvent('tcf:user-result', {detail: {...}})`. All errors → `ok:false, reason:'error'`. `ct0FromCookie`: `document.cookie.match(/(?:^|; )ct0=([^;]*)/)?.[1]` (decodeURIComponent).

### Step 4 — `background.js` (service worker)

- `chrome.runtime.onInstalled`: write defaults to `chrome.storage.local` key `tcf.settings` if absent: `{"showFlags": true, "hideCountries": [], "hideUnknown": false, "autoLookup": true}`.
- **Rate ledger** in `chrome.storage.session` key `tcf.budget`: `{"start": <ms of current 15-min window boundary>, "used": n, "limit": 40, "resetAt": 0}`. Window boundary = `Math.floor(Date.now() / 900000) * 900000`; reset `used` when the window rolls.
- `chrome.runtime.onMessage`:
  - `{type:'tcf:may-lookup'}` → if `used >= limit` → `{ok:false, waitMs: start+900000-now}`; else if `resetAt > now` → `{ok:false, waitMs: resetAt-now}`; else `{ok:true}`.
  - `{type:'tcf:lookup-done', rate:{status, limit, remaining, reset}}` → `used++`; if `status === 429` or `remaining === 0` → `resetAt = rate.reset ? now + rate.reset*1000 : now + 900000`; if `remaining != null && remaining < limit` → `used = Math.min(used, limit - remaining)`. Persist.
  - `{type:'tcf:clear-cache'}` → delete `tcf.cache` from local storage; `chrome.tabs.query` for the four X patterns and `sendMessage {type:'tcf:settings-changed'}` to each (so flags are dropped and lookups may re-run).
  - `{type:'tcf:get-state'}` (from popup) → `{settings, budget:{used, limit, resetAt}, cached: <count of tcf.cache entries>}`.

### Step 5 — `content/selectors.js` and `content/content.js`

`selectors.js` (classic script, `window.TCFSEL`):

```js
SEL_TWEET = 'article[data-testid="tweet"]'
SEL_NAME_BLOCKS = ['[data-testid="User-Name"]', '[data-testid="UserName"]']  // try in order
SEL_QUOTE_CONTAINER = 'div[role="link"]'
RE_PROFILE_HREF = /^\/([A-Za-z0-9_]{1,50})$/
```

Plus `extractAuthor(rootEl)` → `{screen_name, nameBlockEl}`: find the first name block (either testid) in `rootEl`, then its first `a[href]` whose href matches `RE_PROFILE_HREF`; return null when absent. `extractQuotedAuthor(article)` → `{screen_name, nameBlockEl} | null`: among `article.querySelectorAll('div[role="link"]')`, the first containing a name block; screen_name = last `@([A-Za-z0-9_]{1,50})` in its text (quote authors are plain text, display name may contain `@`).

`content.js` responsibilities:

1. **State.** `settings` (from `tcf.settings`, defaults as Step 4), `cache` (from `tcf.cache`: `{[screen_name_lc]: {based_in, location, ts}}`), `names` map (Step 2, built after fetching the two data files), `articles: Map<HTMLElement, {screen_name, quoteScreenName}>` for on-screen tweets.
2. **Observer.** `MutationObserver` on `document.body` (`{childList:true, subtree:true}`): for added nodes, process the node itself if it matches `SEL_TWEET` or any `querySelectorAll(SEL_TWEET)`. Also run once on load for the initial page (covers server-rendered timeline and `document_idle` race: the MAIN-world buffer from Step 3 replays early `tcf:users` batches — implement the same replay: `patch.js` buffers `tcf:users` batches until it receives `CustomEvent('tcf:ready')` from content.js, then flushes).
3. **Per-article processing.** `author = extractAuthor(article)`; skip if none. `resolveAndRender(article, author.screen_name)`:
   - `entry = cache[name_lc]`; `answer = entry ? TCF.resolveAccount(entry.based_in, entry.location, names, cities) : null`.
   - If `answer?.country`: render flag `<span data-tcf-flag title="<CountryName> · <source note>">` + `isoToFlag(iso)` appended to `nameBlockEl` (guard: skip if `nameBlockEl` already has `[data-tcf-flag],[data-tcf-region]`). If `settings.hideCountries.includes(iso)` → `article.style.display = 'none'`, else `''`.
   - Else if `answer?.region`: render `<span data-tcf-region title="<Region name> (region, not a country)">` + `abbr` (same guard/insertion). Never hidden by country rules.
   - Else (unknown): remove any existing flag elements; if `settings.hideUnknown` → `display:'none'`, else `''`; enqueue for lookup (below).
   - Quoted author: same resolve+render into the quote's name block (flag only; quote never hidden).
4. **Lookup queue & pacing.** `queue: string[]` (deduped, FIFO, cap 200). Every 15000ms: if `settings.autoLookup && document.visibilityState === 'visible' && queue.length`: `chrome.runtime.sendMessage({type:'tcf:may-lookup'})` → on `{ok:true}` shift one name, `dispatchEvent(new CustomEvent('tcf:lookup', {detail:{screen_name, reqId: <counter>}}))`, mark in-flight (max 1 in flight; if a previous result is pending, wait for it). On `tcf:user-result`: if `ok` → merge into `cache` (`{based_in, location, ts: Date.now()}`), persist (see 6), re-run `resolveAndRender` for every on-screen article by that author (top-level and quoted). If `reason === 'query-404'` → set `queryDead = true` (stop auto-lookup for this tab; console.warn). Report `{type:'tcf:lookup-done', rate}` to SW whenever a network attempt happened.
5. **Free-data path.** On `tcf:users`: for each user, if `screen_name` new or `based_in`/`location` richer than cached (null → value upgrades; value → value keeps newer `ts`), merge into `cache`, persist, and re-render on-screen articles for that author. This is what makes hover/profile visits fill flags instantly.
6. **Persistence.** `saveCache()`: evict entries older than 30 days; if `> 20000` entries drop oldest-`ts` down to 20000; write whole object to `tcf.cache` (debounced 1s, plus on `visibilitychange`→hidden).
7. **Settings changes.** `chrome.storage.onChanged` for `tcf.settings` and incoming `{type:'tcf:settings-changed'}`: re-read settings, then sweep every entry in `articles` through `resolveAndRender` (flags appear/disappear, tweets hide/show instantly).
8. **Sweep timer.** Every 2000ms: for each `articles` entry whose article still has no flag element and whose author now resolves (or is queued/unknown) — re-run `resolveAndRender`. Bound cost: only on-screen articles (map is pruned when articles leave the DOM — prune in the observer on removed nodes, and drop `article.isConnected === false` entries in the sweep).
9. **Styles.** Inject one `<style id="tcf-styles">`: `span[data-tcf-flag]{margin-left:4px;vertical-align:middle;font-size:.95em} span[data-tcf-region]{margin-left:4px;vertical-align:middle;font-size:.7em;color:#8899a6;background:rgba(136,153,166,.15);border-radius:4px;padding:1px 4px;letter-spacing:.03em}` (X dark theme compatible; no other page styling touched).

Error posture: any unexpected throw in observer/message handlers → `console.warn('tcf', err)`; the extension must never break the page.

### Step 6 — `popup/`

`popup.html` (width 320px, max-height 480px; loads `<script src="../lib/regions.js"></script>` before `popup/popup.js`): header with title + budget line (`<span id="budget">`), a search `<input>`, four toggle rows (checkboxes with labels): "Show flags" (`showFlags`), "Auto-lookup missing countries" (`autoLookup`), "Hide tweets with unknown country" (`hideUnknown`), then a scrollable `<ul id="countries">` (one `<li>` per country: `isoToFlag` + name + checkbox), and a "Clear cached countries" button.

`popup.js`:
- On open: `chrome.runtime.sendMessage({type:'tcf:get-state'})`; render.
- Country list source: `fetch(chrome.runtime.getURL('data/countries.json'))` + `TERRITORIES` rendered as a second group "Territories" (flag + `Intl.DisplayNames(['en'],{type:'region'}).of(code)` name). Checkboxes bound to `settings.hideCountries` (ISO2 array).
- Search filters the list by name (case-insensitive substring).
- Any change → update `tcf.settings` locally, then `chrome.tabs.query({url: [4 X patterns]})` → `tabs.sendMessage(tab.id, {type:'tcf:settings-changed'})` to each (catch per-tab errors).
- "Clear cached countries" → `{type:'tcf:clear-cache'}` to SW.
- Budget line: `<used>/<limit> lookups this 15-min window` + "resets in <n> min" when `used >= limit`.

### Step 7 — Icons, README

- `tools/gen-icons.mjs` (pure node, `zlib` only): renders a 128×128 RGBA image — rounded square (radius 24) fill `#1D9BF0` over transparent; white flag glyph: vertical pole rect `x=42,y=28,w=8,h=72`; flag rect `x=50,y=28,w=52,h=36` fill `#FFFFFF`; stripe rect `x=50,y=48,w=52,h=12` fill `#1D9BF0`. Nearest-neighbor downscale to 48 and 16. Encode PNG (IHDR/IDAT/IEND with `zlib.deflateSync`, CRC32 — ~50 lines) → `icons/icon{16,48,128}.png`. Run it; commit outputs.
- `README.md`: what it does; install (Chrome/Brave → `chrome://extensions` → Developer mode → Load unpacked → select repo root; requires a logged-in x.com session); usage (popup controls); how country is determined (X's `account_based_in` first, then profile location text; what a region chip means); accuracy caveats (this is X's attribution, not physical location; accounts with no data get no flag); rate-limit note (≤40 lookups per 15 min across all tabs, paced, so flags fill in gradually on first visit; a 30-day local cache makes revisits instant); privacy (no third-party requests, no data leaves the browser); regeneration (`npm i -D world-countries && node tools/gen-data.mjs && node tools/gen-icons.mjs`); tests (`node --test test/`).

### Step 8 — Tests (`test/regions.test.mjs`, `node --test`)

Import `lib/regions.js` (node export) and the generated `data/*.json` via `fs`. Assert at least:

- `isoToFlag('US') === '🇺🇸'`; `flagToIso('🇺🇸') === 'US'`; `flagToIso('US') === null`.
- `resolveBasedIn('United States')` → country US; `resolveBasedIn('🇩🇪')` → DE; `resolveBasedIn('EU') === null` (2-letter but not a code) — note: `EU` is not in the name map; `resolveBasedIn('Europe')` → region EUR.
- `resolveAccount('Europe', 'Berlin')` → `{country:'DE', source:'location'}` (region falls through to city).
- `resolveLocationText('Paris')` → 'FR' (single-country city); `resolveLocationText('New York, USA')` → 'US'; `resolveLocationText('Paris, France')` → 'FR'; `resolveLocationText('Dubai')` → 'AE'; `resolveLocationText('USA')` → 'US'; `resolveLocationText('Deutschland')` → 'DE'; `resolveLocationText('London')` → null (both London GB and London CA exceed the 100k city threshold — ambiguous city alone is not an answer); `resolveLocationText('London, Canada')` → 'CA' (country-name part disambiguates an ambiguous city); `resolveLocationText('Earth')` → null; `resolveLocationText(null)` → null.
- `resolveLocationText('New York, Texas')` → 'US' (city part unambiguous).
- Ambiguity: call the city-part logic with a synthetic `{"testville": ["XX","YY"]}` cities map → `resolveLocationText('Testville')` → null (multi-country city alone is not an answer).

Tests must pass before the extension code is considered done; they run with no network.

## Critical files & anchors

- `page/patch.js` — the whole data pipeline hinges on it: fetch/XHR wrapping, header capture order (authorization must be captured before any `tcf:lookup` fires), the `tcf:users` replay buffer (content.js dispatches `tcf:ready` at startup), and the 250ms batch dispatch.
- `content/content.js` — resolution→render→hide pipeline and the 15s pacing loop; the `articles` Map lifecycle (add in observer, prune on removal) is where leaks/duplicate flags would come from.
- `lib/regions.js` — pure; its `resolveAccount` priority order (country-from-X > location-text country > region) is the product's core semantics and is what tests pin.
- `background.js` — ledger math (`used`, window rollover, 429 `resetAt`); wrong math either wastes X's window or starves flags.
- `data/cities.json` — generated artifact; if it's `{}` (GeoNames unavailable) everything still works, but city resolution silently disappears — verify its entry count at implementation time (~1,200+).

## Verification

Prerequisite: a browser with the extension loaded and a logged-in x.com session.

1. `node --test test/` → all pass. `node tools/gen-data.mjs` → `data/countries.json` ~249 entries, `data/cities.json` ~1,200+ entries. `node tools/gen-icons.mjs` → three valid PNGs (open one).
2. Chrome: `chrome://extensions` → enable Developer mode → "Load unpacked" → select the repo root. No errors in the extension's service-worker/console.
3. Open `https://x.com` (logged in), Home timeline:
   - Hover any author's name → their hover/profile request is intercepted → flag (or region chip) appears next to that author within ~1–2s, on every visible tweet by them.
   - With "Auto-lookup" on, scroll: new authors without cache get flagged one at a time, ~15s apart. Popup budget line counts down from 40.
4. Hide a country: pick a currently visible tweet with a known flag (note its country in the popup), tick that country → the tweet disappears immediately; untick → it reappears. Ticking multiple countries hides all matching tweets; the popup list shows which are checked.
5. Unknown handling: find a tweet with no flag (or none resolved yet), tick "Hide tweets with unknown country" → it disappears; untick → back. (Accounts whose lookup failed or was rate-limited count as unknown.)
6. Cache: reload the page → previously flagged authors are flagged instantly without consuming budget (budget line unchanged). "Clear cached countries" → flags disappear and re-appear via lookup/hover.
7. Brave: repeat step 2–4 in Brave (`brave://extensions` → Load unpacked, same folder) — identical behavior.
8. Logged-out check: open x.com without login → no crashes, no console errors beyond X's own; extension inert.

## Assumptions & contingencies

- A logged-in x.com session is assumed; the extension is intentionally inert when logged out (no anonymous timeline access is attempted).
- Flag emoji rendering is assumed (all Chromium desktop/Android platforms render them; Windows shows letter pairs — acceptable).
- `XRqGa7EeokUU5kppkh13EA` is the current `AboutAccountQuery` queryId as observed in X-Pat (Aug 2026). If it 404s at runtime, the page-sniffed id (from the user opening "About this account", or any hover that fires the operation) takes over; if neither is available, auto-lookup disables itself for the tab (`query-404`) and flags still work from free interception + cache. No manual step needed.
- If X removes `about_profile` from `AboutAccountQuery` responses or renames it, `based_in` will be null and resolution degrades to location-text matching — no crash. If `legacy` stays empty in profile responses too, coverage drops to whatever the hover responses provide; that is a data-availability limit, not a code fix.
- If X renames the `data-testid` values (`tweet`, `User-Name`), `content/selectors.js` is the single file to update; until then the extension simply sees no tweets (console.warn on first tick with zero articles found after 5s of an x.com page).
- GeoNames download failure → `cities.json = {}` (Step 1); city resolution is lost, country-name resolution and X-reported data unaffected.
- The 40-per-15-min self-imposed cap (X's limit is 50) leaves ~10 lookups for the user's own hovers/profiles; if the user's own browsing 429s, X's `x-rate-limit-reset` pauses auto-lookup until reset (Step 4 ledger).
