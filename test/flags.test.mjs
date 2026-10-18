import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function events() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
    }
  };
}
class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}

for (const url of ['https://x.com/i/api/graphql/id/HomeTimeline', '/i/api/graphql/id/HomeTimeline']) {
  for (const identity of ['core', 'legacy']) {
    test(`captures ${identity} users from ${url}`, async () => {
      const window = events();
      const timers = [];
      const batches = [];
      window.location = {href: 'https://x.com/home'};
      const user = {__typename: 'User', [identity]: {screen_name: 'alice'}, location: {location: 'Poland'}};
      window.fetch = async () => ({ok: true, clone: () => ({json: async () => ({data: {user}})})});
      class XMLHttpRequest { open() {} setRequestHeader() {} send() {} }
      window.addEventListener('tcf:users', e => batches.push(...e.detail.users));
      vm.runInNewContext(source('page/patch.js'), {
        window, XMLHttpRequest, CustomEvent, URL, document: {},
        setTimeout: fn => { timers.push(fn); return timers.length; }
      });
      window.dispatchEvent(new CustomEvent('tcf:ready'));
      await window.fetch(url);
      await new Promise(resolve => setImmediate(resolve));
      for (const fn of timers) fn();
      assert.equal(batches[0]?.screen_name, 'alice');
      assert.equal(batches[0]?.location, 'Poland');
    });
  }
}

for (const initiallyHydrated of [true, false]) {
test(`unresolved cached authors get one lookup (initially hydrated: ${initiallyHydrated})`, async () => {
  const window = events();
  const intervals = [];
  const lookups = [];
  let hydrated = initiallyHydrated;
  let finishLookup;
  const block = {isConnected: true, querySelector: () => null};
  const article = {isConnected: true, style: {}};
  window.TCF = {resolveAccount: () => null, buildNameMap: () => new Map()};
  window.TCFSEL = {
    SEL_TWEET: 'article',
    extractAuthor: () => hydrated ? {screen_name: 'alice', nameBlockEl: block} : null,
    extractQuotedAuthor: () => null
  };
  window.addEventListener('tcf:lookup', e => {
    lookups.push(e.detail.screen_name);
    finishLookup = () => window.dispatchEvent(new CustomEvent('tcf:user-result', {
      detail: {ok: true, screen_name: 'alice', based_in: null, location: null}
    }));
  });
  const document = {
    visibilityState: 'visible', body: {}, getElementById: () => ({}),
    querySelectorAll: () => [article], addEventListener() {}
  };
  const chrome = {
    runtime: {id: 'test', onMessage: {addListener() {}}, getURL: p => p,
      sendMessage: (msg, cb) => cb({ok: true})},
    storage: {onChanged: {addListener() {}}, local: {
      get: (key, cb) => cb({[key]: key === 'tcf.cache' ? {alice: {location: 'somewhere', ts: Date.now()}} : {}}),
      set() {}
    }}
  };
  vm.runInNewContext(source('content/content.js'), {
    window, document, chrome, CustomEvent, console,
    MutationObserver: class {observe() {}},
    fetch: async () => ({json: async () => []}),
    setTimeout: () => 1, clearTimeout() {},
    setInterval: (fn, ms) => intervals.push({fn, ms})
  });
  await new Promise(resolve => setImmediate(resolve));
  hydrated = true;
  const sweep = intervals.find(x => x.ms === 2000).fn;
  const pace = intervals.find(x => x.ms === 15000).fn;
  sweep(); pace(); sweep();
  assert.equal(typeof finishLookup, 'function');
  finishLookup();
  sweep(); pace();
  assert.deepEqual(lookups, ['alice']);
});
}
