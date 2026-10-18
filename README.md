# Twitter Country Filter

A Manifest V3 Chrome/Brave extension for `x.com` / `twitter.com` that shows each
tweet author's country-of-origin flag inline next to their name, and lets you
hide tweets from countries you choose — no build step, no runtime dependencies,
no backend.

## What it does

- Renders a flag (or a small region chip, e.g. `EUR`) next to every tweet author's
  name whose country the extension can determine.
- Toolbar popup: pick countries whose tweets are hidden from the timeline
  (hidden instantly, no reload), toggle flags on/off, and control auto-lookup.

## Install

1. Open `chrome://extensions` (Brave: `brave://extensions`) and enable
   **Developer mode**.
2. Click **Load unpacked** and select this repository root (the folder containing
   `manifest.json`).
3. Log in to `x.com`. The extension is intentionally inert when logged out — it
   uses the page's own session and makes no anonymous requests.

## Usage

- **Flags appear as soon as the timeline itself loads.** X's timeline and
  profile responses carry each author's location text, which the extension
  resolves locally — no extra requests, no budget spent. Hovering an author's
  name also captures X's own profile request for free.
- With **Auto-lookup missing countries** on, authors the timeline does not
  locate (empty profile location, or ambiguous free text) are resolved one at
  a time via X's per-account query (paced, see rate-limit note below).
- **Hiding countries.** Open the popup and tick countries in the list: matching
  tweets disappear immediately; untick to bring them back. The list includes a
  **Territories** group for subnational codes X reports (e.g. Puerto Rico,
  Greenland).
- **Search** filters the country list by name substring.
- **Hide tweets with unknown country** hides tweets whose country cannot be
  determined (no data, or lookup failed / rate-limited).
- **Clear cached countries** drops the local cache; flags then re-appear via
  hover or auto-lookup.

## How country is determined

Priority per account:

1. `account_based_in` from X's own `AboutAccountQuery` response — the canonical
   English country name, a region name, or a flag emoji that X attributes to the
   account. This is authoritative.
2. The account's free-text **location** field, matched against a bundled dataset
   of country names (CLDR/`Intl.DisplayNames` + an alias table) and cities
   (GeoNames). "New York, USA" resolves to 🇺🇸 via the right-most part.
3. Unresolvable → no flag. Only hidden if "Hide tweets with unknown country"
   is on.

X's API ships user objects in two payload shapes: the legacy one
(`legacy.location` string, `about_profile.account_based_in`) and the current
one (a `location.location` object; `about_profile` is no longer present on
timeline and profile responses as of Oct 2026). The extension reads both, so
free location data from timelines works with either.

A **region chip** (e.g. `EUR`, `NAM`) means X reports a region rather than a
country (e.g. "Europe"); regions have no single flag, so the chip is shown
instead. Region accounts are never hidden by the country rules.

## Accuracy caveats

- The flag shows **X's attribution of the account**, not the physical location of
  the person posting. An account can be based in one country and tweet from
  another.
- Accounts with no `account_based_in` and no usable location text get no flag;
  they are "unknown".
- City matching is best-effort: genuinely ambiguous city names (e.g. "London"
  exists in several countries) resolve only when a country name disambiguates.

## Rate limiting

X rate-limits the per-account lookup this extension uses. The extension imposes
its own cap of **≤ 40 lookups per 15 minutes across all tabs**, paced ~15 s
apart, so on a first visit flags fill in gradually. The popup's budget line
shows the current window usage and a countdown while the cap is reached. A
30-day local cache makes revisits instant and consumes no budget. Free
interception of the page's own requests (hover/profile visits) does not count
against the cap.

## Privacy

- No third-party requests, no analytics, no API keys. The only requests the
  extension makes go to `x.com` itself, using your own session headers.
- No data leaves the browser: settings and the account cache live in
  `chrome.storage.local`.

## Regeneration & tests

```sh
npm i -D world-countries   # dev-only dependency for data generation
npm run gen-data           # regenerate data/countries.json + data/cities.json
npm run gen-icons          # regenerate icons/icon{16,48,128}.png
npm test                   # node --test test/ (no network required)
```
