/* Twitter Country Filter — content script (isolated world, classic script).
 *
 * Responsibilities: state (settings/cache/names/cities), MutationObserver,
 * resolve→render→hide pipeline, quoted-author rendering, lookup queue + pacing,
 * free-data (tcf:users) merge, debounced cache persistence, settings sweep,
 * sweep timer, styles. Never breaks the page: every handler body is try/catch.
 */
(() => {
  'use strict';
  if (window.__TCF_CONTENT__) return;
  window.__TCF_CONTENT__ = true;

  const TCF = window.TCF;
  const SEL = window.TCFSEL;
  if (!TCF || !SEL) {
    console.warn('tcf: TCF or TCFSEL globals missing; aborting');
    return;
  }

  const SETTINGS_KEY = 'tcf.settings';
  const CACHE_KEY = 'tcf.cache';
  const DEFAULT_SETTINGS = {showFlags: true, hideCountries: [], hideUnknown: false, autoLookup: true};
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_MAX = 20000;
  const QUEUE_MAX = 200;

  /* ---------------- state ---------------- */

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let cache = {};              // {[screen_name_lc]: {based_in, location, ts}}
  let countries = [];
  let cities = {};
  let names = new Map();
  const articles = new Map();  // article -> {screen_name, quoteScreenName?}
  const queue = [];            // deduped FIFO of screen_name_lc, cap 200
  let inFlight = false;
  let queryDead = false;
  let reqCounter = 0;
  let saveTimer = null;
  let foundAny = false;
  let driftWarned = false;
  let displayNames = null;

  const observer = new MutationObserver(onMutations);

  const warned = new Set();
  function warn(err) {
    const key = err && err.message ? err.message : String(err);
    if (warned.has(key)) return; // e.g. context-invalidation errors repeat on every event
    warned.add(key);
    console.warn('tcf', err);
  }
  function swallowCb() { void chrome.runtime.lastError; }

  /* ---------------- rendering helpers ---------------- */

  function countryName(iso) {
    try {
      if (!displayNames) displayNames = new Intl.DisplayNames(['en'], {type: 'region'});
      return displayNames.of(iso) || iso;
    } catch (e) { return iso; }
  }

  function clearMarks(el) {
    if (!el) return;
    let m;
    while ((m = el.querySelector('[data-tcf-flag],[data-tcf-region]'))) m.remove();
  }

  /* ---------------- cache ---------------- */

  // null -> value upgrades; value -> value keeps the newer value (incoming wins);
  // incoming null keeps the existing value. Returns true when cache changed.
  function mergeUser(screenName, basedIn, location) {
    const key = String(screenName).toLowerCase();
    const prev = cache[key];
    const next = {
      based_in: (typeof basedIn === 'string' && basedIn) || (prev && prev.based_in) || null,
      location: (typeof location === 'string' && location) || (prev && prev.location) || null,
      ts: Date.now()
    };
    if (prev) {
      if ((prev.based_in || null) === next.based_in && (prev.location || null) === next.location) return false;
    }
    cache[key] = next;
    return true;
  }

  function saveCache() {
    if (saveTimer) return; // coalesce: one pending write is enough
    saveTimer = setTimeout(flushCache, 1000);
  }

  function flushCache() {
    saveTimer = null;
    try {
      const now = Date.now();
      const cutoff = now - CACHE_TTL_MS;
      const keys = Object.keys(cache);
      for (let i = 0; i < keys.length; i++) {
        const v = cache[keys[i]];
        if (!v || typeof v.ts !== 'number' || v.ts < cutoff) delete cache[keys[i]];
      }
      const remaining = Object.keys(cache);
      if (remaining.length > CACHE_MAX) {
        remaining.sort((a, b) => ((cache[a].ts || 0) - (cache[b].ts || 0)));
        for (let i = 0; i < remaining.length - CACHE_MAX; i++) delete cache[remaining[i]];
      }
      chrome.storage.local.set({[CACHE_KEY]: cache}, swallowCb);
    } catch (e) { warn(e); }
  }

  /* ---------------- lookup queue ---------------- */

  function enqueue(key) {
    if (queue.length >= QUEUE_MAX) return;
    if (queue.indexOf(key) !== -1) return;
    queue.push(key);
  }

  function pruneQueue() {
    try {
      for (let i = queue.length - 1; i >= 0; i--) {
        const key = queue[i];
        const entry = cache[key];
        const answer = entry ? TCF.resolveAccount(entry.based_in || null, entry.location || null, names, cities) : null;
        if (answer) queue.splice(i, 1);
      }
    } catch (e) { warn(e); }
  }

  function paceLookups() {
    try {
      if (queryDead || !settings.autoLookup || document.visibilityState !== 'visible') return;
      if (!queue.length || inFlight) return;
      chrome.runtime.sendMessage({type: 'tcf:may-lookup'}, (response) => {
        void chrome.runtime.lastError;
        try {
          if (!response || !response.ok || inFlight) return;
          const name = queue.shift();
          if (!name) return;
          inFlight = true; // max 1 in flight; next pace tick waits for the result
          reqCounter += 1;
          window.dispatchEvent(new CustomEvent('tcf:lookup', {detail: {screen_name: name, reqId: reqCounter}}));
        } catch (e) { warn(e); inFlight = false; }
      });
    } catch (e) { warn(e); }
  }

  /* ---------------- resolve + render ---------------- */

  // Render one author into a name block. isQuote: flag only, never hidden.
  function renderPair(article, nameBlockEl, screenName, isQuote) {
    if (!nameBlockEl || !nameBlockEl.isConnected) return;
    const key = String(screenName).toLowerCase();
    const entry = cache[key];
    const answer = entry ? TCF.resolveAccount(entry.based_in || null, entry.location || null, names, cities) : null;

    if (!isQuote) {
      let display = '';
      if (answer && answer.country) {
        display = settings.hideCountries.indexOf(answer.country) !== -1 ? 'none' : '';
      } else if (!answer) {
        display = settings.hideUnknown ? 'none' : '';
      }
      article.style.display = display;
    }
    if (!answer && !entry) enqueue(key);

    let want = null; // 'flag' | 'region' | null
    if (settings.showFlags && answer) {
      if (answer.country) want = 'flag';
      else if (answer.region && !isQuote) want = 'region';
    }

    const existing = nameBlockEl.querySelector('[data-tcf-flag],[data-tcf-region]');
    if (existing) {
      const kind = existing.hasAttribute('data-tcf-flag') ? 'flag' : 'region';
      if (kind === want) return; // idempotent: correct mark already present
      existing.remove(); // wrong kind or should disappear
    }
    if (!want) return;

    const span = document.createElement('span');
    if (want === 'flag') {
      span.setAttribute('data-tcf-flag', '');
      span.title = countryName(answer.country) + ' · ' + (answer.source === 'x' ? 'per X' : 'per profile location');
      span.textContent = TCF.isoToFlag(answer.country);
    } else {
      span.setAttribute('data-tcf-region', '');
      span.title = answer.region.name + ' (region, not a country)';
      span.textContent = answer.region.abbr;
    }
    nameBlockEl.appendChild(span);
  }

  function processArticle(article) {
    foundAny = true;
    const author = SEL.extractAuthor(article);
    if (!author) return;
    const quoted = SEL.extractQuotedAuthor(article);
    const prev = articles.get(article);
    // X recycles article elements: clear stale marks when the occupant changed.
    if (!prev || prev.screen_name !== author.screen_name) clearMarks(author.nameBlockEl);
    const quoteName = quoted ? quoted.screen_name : null;
    if (!prev || (prev.quoteScreenName || null) !== quoteName) {
      if (quoted) clearMarks(quoted.nameBlockEl);
    }
    const info = {screen_name: author.screen_name};
    if (quoted) info.quoteScreenName = quoteName;
    articles.set(article, info);
    renderPair(article, author.nameBlockEl, author.screen_name, false);
    if (quoted) renderPair(article, quoted.nameBlockEl, quoted.screen_name, true);
  }

  function reRenderAuthor(key) {
    try {
      for (const [article, info] of Array.from(articles.entries())) {
        if (!article.isConnected) { articles.delete(article); continue; }
        const top = String(info.screen_name || '').toLowerCase();
        const quote = String(info.quoteScreenName || '').toLowerCase();
        if (top === key || (quote && quote === key)) processArticle(article);
      }
    } catch (e) { warn(e); }
  }

  function sweepAll() {
    try {
      for (const article of Array.from(articles.keys())) {
        if (article.isConnected) processArticle(article);
      }
    } catch (e) { warn(e); }
  }

  // 2s sweep: re-resolve articles lacking a mark; prune disconnected entries.
  function sweep() {
    try {
      for (const article of Array.from(articles.keys())) {
        if (!article.isConnected) { articles.delete(article); continue; }
        const author = SEL.extractAuthor(article);
        if (!author) continue;
        if (!author.nameBlockEl.querySelector('[data-tcf-flag],[data-tcf-region]')) processArticle(article);
      }
    } catch (e) { warn(e); }
  }

  function pruneRemoved(root) {
    try {
      if (articles.has(root)) articles.delete(root);
      if (root.querySelectorAll) {
        const found = root.querySelectorAll(SEL.SEL_TWEET);
        for (let i = 0; i < found.length; i++) articles.delete(found[i]);
      }
    } catch (e) { warn(e); }
  }

  function onMutations(mutations) {
    try {
      for (const mutation of mutations) {
        for (let i = 0; i < mutation.removedNodes.length; i++) {
          const node = mutation.removedNodes[i];
          if (node.nodeType === 1) pruneRemoved(node);
        }
        for (let i = 0; i < mutation.addedNodes.length; i++) {
          const node = mutation.addedNodes[i];
          if (node.nodeType !== 1 || typeof node.querySelectorAll !== 'function') continue;
          if (node.matches && node.matches(SEL.SEL_TWEET)) {
            processArticle(node);
            continue;
          }
          const found = node.querySelectorAll(SEL.SEL_TWEET);
          for (let j = 0; j < found.length; j++) processArticle(found[j]);
        }
      }
    } catch (e) { warn(e); }
  }

  /* ---------------- data + settings loading ---------------- */

  function loadCache() {
    try {
      chrome.storage.local.get(CACHE_KEY, (items) => {
        swallowCb();
        try {
          const c = items && items[CACHE_KEY];
          if (c && typeof c === 'object') cache = c;
          pruneQueue();
          sweepAll();
        } catch (e) { warn(e); }
      });
    } catch (e) { warn(e); }
  }

  function loadData() {
    let pending = 2;
    const done = () => {
      if (--pending > 0) return;
      try {
        names = TCF.buildNameMap(countries, true);
      } catch (e) { warn(e); }
      pruneQueue();
      sweepAll();
    };
    fetch(chrome.runtime.getURL('data/countries.json'))
      .then((r) => r.json())
      .then((d) => { countries = Array.isArray(d) ? d : []; done(); })
      .catch((e) => { warn(e); done(); });
    fetch(chrome.runtime.getURL('data/cities.json'))
      .then((r) => r.json())
      .then((d) => { cities = (d && typeof d === 'object') ? d : {}; done(); })
      .catch((e) => { warn(e); done(); });
  }

  function applySettings(raw) {
    settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    if (!Array.isArray(settings.hideCountries)) settings.hideCountries = [];
    sweepAll();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (items) => {
        swallowCb();
        try { applySettings(items && items[SETTINGS_KEY]); } catch (e) { warn(e); }
      });
    } catch (e) { warn(e); }
  }

  function onVisibility() {
    try {
      if (document.visibilityState === 'hidden' && saveTimer) {
        clearTimeout(saveTimer);
        flushCache();
      }
    } catch (e) { warn(e); }
  }

  function checkDrift() {
    if (!driftWarned && !foundAny) {
      driftWarned = true;
      console.warn('tcf: no tweet articles found after 5s — possible selector drift');
    }
  }

  /* ---------------- styles ---------------- */

  function injectStyles() {
    try {
      if (document.getElementById('tcf-styles')) return;
      const style = document.createElement('style');
      style.id = 'tcf-styles';
      style.textContent = 'span[data-tcf-flag]{margin-left:4px;vertical-align:middle;font-size:.95em} ' +
        'span[data-tcf-region]{margin-left:4px;vertical-align:middle;font-size:.7em;color:#8899a6;' +
        'background:rgba(136,153,166,.15);border-radius:4px;padding:1px 4px;letter-spacing:.03em}';
      (document.head || document.documentElement).appendChild(style);
    } catch (e) { warn(e); }
  }

  /* ---------------- event + message handlers ---------------- */

  // Free data from intercepted page responses (hover, profile, timelines).
  window.addEventListener('tcf:users', (event) => {
    try {
      const users = (event && event.detail && event.detail.users) || [];
      const changed = new Set();
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        if (!u || typeof u.screen_name !== 'string') continue;
        const key = u.screen_name.toLowerCase();
        if (mergeUser(key, u.based_in || null, u.location || null)) changed.add(key);
      }
      if (changed.size) {
        saveCache();
        for (const key of changed) reRenderAuthor(key);
      }
    } catch (e) { warn(e); }
  });

  window.addEventListener('tcf:user-result', (event) => {
    try {
      const detail = (event && event.detail) || {};
      inFlight = false;
      // Report to the SW whenever a network attempt happened (no-headers short-circuits before fetch).
      if (detail.reason !== 'no-headers') {
        try {
          chrome.runtime.sendMessage({type: 'tcf:lookup-done', rate: detail.rate || {}}, swallowCb);
        } catch (e) { warn(e); }
      }
      if (detail.ok && typeof detail.screen_name === 'string') {
        const key = detail.screen_name.toLowerCase();
        if (mergeUser(key, detail.based_in || null, detail.location || null)) saveCache();
        reRenderAuthor(key);
      } else if (detail.reason === 'query-404') {
        queryDead = true; // stop auto-lookup for this tab
        console.warn('tcf: AboutAccountQuery returned 404; disabling auto-lookup for this tab');
      }
    } catch (e) { warn(e); }
  });

  chrome.runtime.onMessage.addListener((message) => {
    try {
      if (message && message.type === 'tcf:settings-changed') loadSettings();
    } catch (e) { warn(e); }
  });

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      try {
        if (areaName === 'local' && changes[SETTINGS_KEY]) applySettings(changes[SETTINGS_KEY].newValue);
      } catch (e) { warn(e); }
    });
  } catch (e) { warn(e); }

  /* ---------------- startup ---------------- */

  function startup() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        console.warn('tcf: extension context is invalid — the extension was reloaded/updated while this tab was open. Reload the x.com tab.');
        return;
      }
      injectStyles();
      loadSettings();
      loadCache();
      loadData();
      // Initial synchronous pass over the whole page, then tell patch.js
      // (MAIN world) it may flush its replayed tcf:users buffer.
      const existing = document.querySelectorAll(SEL.SEL_TWEET);
      for (let i = 0; i < existing.length; i++) processArticle(existing[i]);
      window.dispatchEvent(new CustomEvent('tcf:ready'));
      if (document.body) observer.observe(document.body, {childList: true, subtree: true});
    } catch (e) { warn(e); }
    setInterval(sweep, 2000);
    setInterval(paceLookups, 15000);
    setTimeout(checkDrift, 5000);
    try {
      document.addEventListener('visibilitychange', onVisibility);
    } catch (e) { warn(e); }
  }

  startup();
})();
