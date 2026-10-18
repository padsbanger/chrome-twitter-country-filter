/* Twitter Country Filter — MAIN-world page patch (classic script; no extension APIs).
 *
 * Wraps window.fetch and XMLHttpRequest to:
 *   1. capture the page session's X API request headers (first /i/api request),
 *      re-capturing authorization / x-csrf-token on later requests (token rotation);
 *   2. sniff the AboutAccountQuery graphql queryId from observed URLs;
 *   3. deep-scan API responses for User nodes and batch them into tcf:users events
 *      (buffered until the content script says tcf:ready, then flushed in order);
 *   4. execute per-account AboutAccountQuery lookups on tcf:lookup events and
 *      report tcf:user-result.
 */
(() => {
  'use strict';
  if (window.__TCF_PATCHED__) return;
  window.__TCF_PATCHED__ = true;

  function isApiUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return /(^|\.)(x\.com|twitter\.com)$/.test(url.hostname) &&
        url.pathname.startsWith('/i/api/');
    } catch (e) { return false; }
  }
  const QUERY_ID_RE = /\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/AboutAccountQuery/;
  const MAX_DEPTH = 25;
  const MAX_STR = 5000;
  const HEADER_KEYS = ['authorization', 'x-twitter-client-language', 'x-twitter-active-user', 'x-csrf-token'];

  let queryId = 'XRqGa7EeokUU5kppkh13EA';
  let headers = null;
  let ready = false;

  /* ---------------- tcf:users batching + replay buffer ---------------- */

  const pending = [];   // users not yet dispatched (max 250ms old)
  const replay = [];    // finished batches waiting for tcf:ready (original order)
  let flushTimer = null;

  function dispatchUsers(users) {
    window.dispatchEvent(new CustomEvent('tcf:users', {detail: {users: users}}));
  }

  function flushNow() {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.splice(0);
    if (!ready) replay.push(batch);
    else dispatchUsers(batch);
  }

  function queueUsers(users) {
    for (let i = 0; i < users.length; i++) pending.push(users[i]);
    if (pending.length && !flushTimer) flushTimer = setTimeout(flushNow, 250);
  }

  window.addEventListener('tcf:ready', () => {
    ready = true;
    while (replay.length) dispatchUsers(replay.shift());
    if (pending.length) flushNow();
  }, {once: true});

  /* ---------------- header capture + queryId sniffing ---------------- */

  function sniffQueryId(url) {
    const m = url.match(QUERY_ID_RE);
    if (m) queryId = m[1];
  }

  function captureHeaders(reqHeaders) {
    const got = {};
    for (let i = 0; i < HEADER_KEYS.length; i++) {
      const k = HEADER_KEYS[i];
      const v = reqHeaders && reqHeaders[k];
      if (typeof v === 'string' && v) got[k] = v;
    }
    if (!headers) {
      if (!Object.keys(got).length) return;
      headers = got;
      window.dispatchEvent(new CustomEvent('tcf:headers', {detail: {ok: true}}));
      return;
    }
    let changed = false;
    // Tokens rotate: always re-capture these two when present.
    if (got.authorization && got.authorization !== headers.authorization) {
      headers.authorization = got.authorization;
      changed = true;
    }
    if (got['x-csrf-token'] && got['x-csrf-token'] !== headers['x-csrf-token']) {
      headers['x-csrf-token'] = got['x-csrf-token'];
      changed = true;
    }
    // Backfill one-shot headers that were absent on the first capture.
    for (let i = 0; i < HEADER_KEYS.length; i++) {
      const k = HEADER_KEYS[i];
      if (k === 'authorization' || k === 'x-csrf-token') continue;
      if (got[k] && !headers[k]) {
        headers[k] = got[k];
        changed = true;
      }
    }
    if (changed) window.dispatchEvent(new CustomEvent('tcf:headers', {detail: {ok: true}}));
  }

  function collectHeaders(input, init) {
    const out = {};
    try {
      if (input && typeof input !== 'string' && input.headers && typeof input.headers.forEach === 'function') {
        input.headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
      }
    } catch (e) { /* ignore */ }
    try {
      const ih = init && init.headers;
      if (!ih) return out;
      if (Array.isArray(ih)) {
        for (let i = 0; i < ih.length; i++) {
          const p = ih[i];
          if (p && p.length >= 2) out[String(p[0]).toLowerCase()] = String(p[1]);
        }
      } else if (typeof ih.forEach === 'function') {
        ih.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
      } else if (typeof ih === 'object') {
        for (const k in ih) {
          if (Object.prototype.hasOwnProperty.call(ih, k)) out[k.toLowerCase()] = String(ih[k]);
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /* ---------------- response deep-scan for User nodes ---------------- */

  function scanValue(value, depth, out) {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) scanValue(value[i], depth + 1, out);
      return;
    }
    if (value.__typename === 'User') {
      const core = value.core && value.core.screen_name ? value.core : value.legacy;
      if (core && typeof core === 'object' && typeof core.screen_name === 'string' && core.screen_name) {
        const user = {screen_name: core.screen_name};
        if (typeof core.name === 'string' && core.name) user.name = core.name;
        const legacy = value.legacy;
        if (legacy && typeof legacy === 'object' && typeof legacy.location === 'string' && legacy.location) {
          user.location = legacy.location;
        }
        // New payload shape (current GraphQL endpoints): profile location is
        // location.location (object), bio is profile_bio.description; the old
        // legacy / about_profile fields are no longer present on timeline and
        // profile responses.
        const loc = value.location;
        if (loc && typeof loc === 'object' && typeof loc.location === 'string' && loc.location) {
          user.location = loc.location;
        }
        const about = value.about_profile;
        if (about && typeof about === 'object' && typeof about.account_based_in === 'string' && about.account_based_in) {
          user.based_in = about.account_based_in;
        }
        out.push(user);
      }
    }
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = value[key];
      // Strings are leaves; never recursed (long strings > MAX_STR skipped too).
      if (typeof child === 'string') {
        if (child.length > MAX_STR) continue;
        continue;
      }
      scanValue(child, depth + 1, out);
    }
  }

  function scanData(data) {
    if (data === null || data === undefined) return;
    const out = [];
    scanValue(data, 0, out);
    if (out.length) queueUsers(out);
  }

  /* ---------------- fetch wrap ---------------- */

  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;
      else if (input instanceof URL) url = input.href;
    } catch (e) { /* ignore */ }
    let isApi = false;
    if (isApiUrl(url)) {
      isApi = true;
      sniffQueryId(url);
      captureHeaders(collectHeaders(input, init));
    }
    let result;
    try {
      result = realFetch.apply(this, arguments);
    } catch (e) {
      result = Promise.reject(e);
    }
    if (isApi) {
      Promise.resolve(result).then((response) => {
        if (!response) return;
        try {
          if (response.ok) response.clone().json().then(scanData, () => {});
        } catch (e) { /* ignore */ }
      }, () => {});
    }
    return result;
  };

  /* ---------------- XMLHttpRequest wrap ---------------- */

  const realOpen = XMLHttpRequest.prototype.open;
  const realSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const realSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__tcfUrl = typeof url === 'string' ? url : String(url);
      this.__tcfHeaders = {};
      if (isApiUrl(this.__tcfUrl)) sniffQueryId(this.__tcfUrl);
    } catch (e) { /* ignore */ }
    return realOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__tcfHeaders) this.__tcfHeaders[String(name).toLowerCase()] = String(value);
    } catch (e) { /* ignore */ }
    return realSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    try {
      const url = xhr.__tcfUrl || '';
      if (isApiUrl(url)) {
        // Headers are read after send starts: method/url from open() plus the
        // setRequestHeader() calls recorded per request.
        captureHeaders(xhr.__tcfHeaders || {});
        xhr.addEventListener('load', () => {
          try {
            const status = xhr.status;
            if (status < 200 || status >= 300) return;
            let data;
            if (xhr.responseType === 'json') {
              data = xhr.response;
            } else {
              const text = xhr.responseText;
              if (typeof text !== 'string' || !text) return;
              data = JSON.parse(text);
            }
            scanData(data);
          } catch (e) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
    return realSend.apply(this, arguments);
  };

  /* ---------------- lookup execution ---------------- */

  function ct0FromCookie() {
    try {
      const m = document.cookie.match(/(?:^|; )ct0=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function toInt(value) {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  window.addEventListener('tcf:lookup', (event) => {
    const detail = (event && event.detail) || {};
    const screenName = typeof detail.screen_name === 'string' ? detail.screen_name : '';
    const reqId = detail.reqId;
    const respond = (payload) => {
      const d = {screen_name: screenName, reqId: reqId};
      for (const k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) d[k] = payload[k];
      }
      window.dispatchEvent(new CustomEvent('tcf:user-result', {detail: d}));
    };

    if (!screenName) { respond({ok: false, reason: 'error'}); return; }
    if (!headers || !headers.authorization) { respond({ok: false, reason: 'no-headers'}); return; }

    const reqHeaders = {
      'authorization': headers.authorization,
      'content-type': 'application/json',
      'x-csrf-token': headers['x-csrf-token'] || ct0FromCookie()
    };
    if (headers['x-twitter-client-language']) reqHeaders['x-twitter-client-language'] = headers['x-twitter-client-language'];
    if (headers['x-twitter-active-user']) reqHeaders['x-twitter-active-user'] = headers['x-twitter-active-user'];

    let response;
    try {
      const url = 'https://x.com/i/api/graphql/' + queryId + '/AboutAccountQuery?variables=' +
        encodeURIComponent(JSON.stringify({screenName: screenName}));
      // Use the raw fetch so our own lookup is not re-intercepted.
      response = realFetch.call(window, url, {method: 'GET', credentials: 'include', headers: reqHeaders});
    } catch (e) {
      respond({ok: false, reason: 'error'});
      return;
    }

    Promise.resolve(response).then((res) => {
      const rate = {
        status: res.status,
        limit: toInt(res.headers.get('x-rate-limit-limit')),
        remaining: toInt(res.headers.get('x-rate-limit-remaining')),
        reset: toInt(res.headers.get('x-rate-limit-reset'))
      };
      if (res.status === 404) { respond({ok: false, reason: 'query-404', rate: rate}); return; }
      if (!res.ok) { respond({ok: false, reason: 'error', rate: rate}); return; }
      return res.json().then((data) => {
        const result = data && data.data && data.data.user_result_by_screen_name &&
          data.data.user_result_by_screen_name.result;
        const basedIn = result && result.about_profile ? result.about_profile.account_based_in : null;
        const legacyLoc = result && result.legacy ? result.legacy.location : null;
        // New payload shape: location is a {location: string} object, no legacy.
        const newLoc = result && result.location && typeof result.location === 'object'
          ? result.location.location
          : null;
        respond({
          ok: true,
          based_in: (typeof basedIn === 'string' && basedIn) || null,
          location: (typeof legacyLoc === 'string' && legacyLoc) ||
            (typeof newLoc === 'string' && newLoc) || null,
          rate: rate
        });
      });
    }).catch(() => {
      respond({ok: false, reason: 'error'});
    });
  });
})();
