// background.js — Manifest V3 service worker for Twitter Country Filter.
// Owns the shared rate ledger (chrome.storage.session), default settings,
// and the popup ⇄ service-worker message protocol.

'use strict';

const X_PATTERNS = [
  '*://*.x.com/*',
  '*://x.com/*',
  '*://*.twitter.com/*',
  '*://twitter.com/*',
];

const WINDOW_MS = 900000; // 15-minute budget window
const BUDGET_LIMIT = 40;
const SETTINGS_KEY = 'tcf.settings';
const BUDGET_KEY = 'tcf.budget';
const CACHE_KEY = 'tcf.cache';

const DEFAULT_SETTINGS = {
  showFlags: true,
  hideCountries: [],
  hideUnknown: false,
  autoLookup: true,
};

function windowStart() {
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}

// Load the ledger; roll `used` over when the 15-minute window changes.
// The service worker can be killed between messages, so every handler
// starts from storage, never from an in-memory copy.
async function loadBudget() {
  const start = windowStart();
  const stored = await chrome.storage.session.get(BUDGET_KEY);
  const b = stored[BUDGET_KEY];
  if (!b || b.start !== start) {
    return { start, used: 0, limit: BUDGET_LIMIT, resetAt: 0 };
  }
  const now = Date.now();
  return {
    start: b.start,
    used: typeof b.used === 'number' ? b.used : 0,
    limit: BUDGET_LIMIT,
    resetAt: b.resetAt > now ? b.resetAt : 0,
  };
}

async function saveBudget(budget) {
  await chrome.storage.session.set({ [BUDGET_KEY]: budget });
}

function sendToTabs(message) {
  return chrome.tabs
    .query({ url: X_PATTERNS })
    .then((tabs) =>
      Promise.all(
        tabs.map((tab) =>
          chrome.tabs.sendMessage(tab.id, message).catch(() => {
            // Tab has no content script (e.g. logged-out X, non-X page).
          })
        )
      )
    )
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'tcf:may-lookup') {
    loadBudget().then((b) => {
      const now = Date.now();
      if (b.used >= b.limit) {
        sendResponse({ ok: false, waitMs: Math.max(1, b.start + WINDOW_MS - now) });
      } else if (b.resetAt > now) {
        sendResponse({ ok: false, waitMs: Math.max(1, b.resetAt - now) });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true; // async response
  }

  if (msg.type === 'tcf:lookup-done') {
    loadBudget().then(async (b) => {
      const now = Date.now();
      const rate = msg.rate || {};
      b.used += 1;
      if (rate.status === 429 || rate.remaining === 0) {
        b.resetAt = rate.reset ? now + rate.reset * 1000 : now + WINDOW_MS;
      }
      if (rate.remaining != null && rate.remaining < b.limit) {
        b.used = Math.min(b.used, b.limit - rate.remaining);
      }
      await saveBudget(b);
      sendResponse({ ok: true });
    });
    return true; // async response
  }

  if (msg.type === 'tcf:clear-cache') {
    chrome.storage.local
      .remove(CACHE_KEY)
      .then(() => sendToTabs({ type: 'tcf:settings-changed' }))
      .then(() => sendResponse({ ok: true }));
    return true; // async response
  }

  if (msg.type === 'tcf:get-state') {
    Promise.all([
      chrome.storage.local.get(SETTINGS_KEY),
      chrome.storage.local.get(CACHE_KEY),
      loadBudget(),
    ]).then(([settings, cache, budget]) => {
      sendResponse({
        settings: settings[SETTINGS_KEY] || { ...DEFAULT_SETTINGS },
        budget: { used: budget.used, limit: budget.limit, resetAt: budget.resetAt },
        cached: cache[CACHE_KEY] ? Object.keys(cache[CACHE_KEY]).length : 0,
      });
    });
    return true; // async response
  }

  return false;
});
