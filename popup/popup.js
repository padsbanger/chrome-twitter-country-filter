// popup.js — toolbar popup controller for Twitter Country Filter.
// Classic script; relies on window.TCF from ../lib/regions.js (loaded first).

'use strict';

(function () {
  const X_PATTERNS = [
    '*://*.x.com/*',
    '*://x.com/*',
    '*://*.twitter.com/*',
    '*://twitter.com/*',
  ];
  const SETTINGS_KEY = 'tcf.settings';
  const WINDOW_MS = 900000;

  const DEFAULT_SETTINGS = {
    showFlags: true,
    hideCountries: [],
    hideUnknown: false,
    autoLookup: true,
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let budget = null; // {used, limit, resetAt}
  let cachedCount = 0;
  let items = []; // {iso2, name, territory: boolean}

  const listEl = document.getElementById('countries');
  const budgetEl = document.getElementById('budget');
  const searchEl = document.getElementById('search');
  const clearEl = document.getElementById('clear-cache');

  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });

  function territoryName(code) {
    try {
      return displayNames.of(code);
    } catch (e) {
      return code;
    }
  }

  function isoFlag(iso2) {
    return window.TCF ? TCF.isoToFlag(iso2) : iso2;
  }

  function isHidden(iso2) {
    return settings.hideCountries.indexOf(iso2) !== -1;
  }

  function notifyTabs() {
    chrome.tabs
      .query({ url: X_PATTERNS })
      .then(function (tabs) {
        tabs.forEach(function (tab) {
          if (tab.id == null) return;
          chrome.tabs
            .sendMessage(tab.id, { type: 'tcf:settings-changed' })
            .catch(function () {
              // No content script in this tab (non-X page, logged out, ...).
            });
        });
      })
      .catch(function () {});
  }

  function persistSettings() {
    chrome.storage.local
      .set({ [SETTINGS_KEY]: settings })
      .then(notifyTabs)
      .catch(function (e) {
        console.warn('tcf popup', e);
      });
  }

  function renderBudget() {
    if (!budget) {
      budgetEl.textContent = '—';
      return;
    }
    let text =
      budget.used + '/' + budget.limit + ' lookups this 15-min window';
    if (budget.used >= budget.limit) {
      const now = Date.now();
      const reset =
        budget.resetAt > now ? budget.resetAt : Math.ceil(now / WINDOW_MS) * WINDOW_MS;
      const mins = Math.max(1, Math.ceil((reset - now) / 60000));
      text += ' — resets in ' + mins + ' min';
    }
    budgetEl.textContent = text;
  }

  function renderClearLabel() {
    clearEl.textContent =
      cachedCount > 0
        ? 'Clear cached countries (' + cachedCount + ')'
        : 'Clear cached countries';
  }

  function applySearch() {
    const term = searchEl.value.toLowerCase();
    const filtered = term
      ? items.filter(function (it) {
          return it.name.toLowerCase().indexOf(term) !== -1;
        })
      : items;

    listEl.textContent = '';

    function appendGroup(title, groupItems) {
      if (!groupItems.length) return;
      const head = document.createElement('li');
      head.className = 'group-title';
      head.textContent = title;
      listEl.appendChild(head);
      groupItems.forEach(function (it) {
        listEl.appendChild(buildRow(it));
      });
    }

    appendGroup(
      'Countries',
      filtered.filter(function (it) {
        return !it.territory;
      })
    );
    appendGroup(
      'Territories',
      filtered.filter(function (it) {
        return it.territory;
      })
    );
  }

  function buildRow(it) {
    const li = document.createElement('li');

    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = isoFlag(it.iso2);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = isHidden(it.iso2);
    box.addEventListener('change', function () {
      const next = settings.hideCountries.slice();
      const i = next.indexOf(it.iso2);
      if (box.checked && i === -1) next.push(it.iso2);
      if (!box.checked && i !== -1) next.splice(i, 1);
      settings.hideCountries = next;
      persistSettings();
    });

    li.appendChild(flag);
    li.appendChild(name);
    li.appendChild(box);
    li.addEventListener('click', function (e) {
      if (e.target !== box) {
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change'));
      }
    });
    return li;
  }

  function renderToggles() {
    document.querySelectorAll('input[data-setting]').forEach(function (el) {
      el.checked = !!settings[el.dataset.setting];
      el.addEventListener('change', function () {
        settings[el.dataset.setting] = el.checked;
        persistSettings();
      });
    });
  }

  function render() {
    renderToggles();
    applySearch();
    renderBudget();
    renderClearLabel();
  }

  function loadCountries() {
    return fetch(chrome.runtime.getURL('data/countries.json')).then(function (r) {
      return r.json();
    });
  }

  searchEl.addEventListener('input', applySearch);

  clearEl.addEventListener('click', function () {
    chrome.runtime
      .sendMessage({ type: 'tcf:clear-cache' })
      .then(function () {
        cachedCount = 0;
        renderClearLabel();
      })
      .catch(function (e) {
        console.warn('tcf popup', e);
      });
  });

  Promise.all([loadCountries(), chrome.runtime.sendMessage({ type: 'tcf:get-state' })])
    .then(function (res) {
      const countries = res[0];
      const state = res[1] || {};
      if (state.settings) {
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
        if (!Array.isArray(settings.hideCountries)) settings.hideCountries = [];
      }
      if (state.budget) budget = state.budget;
      cachedCount = state.cached || 0;

      items = countries.map(function (c) {
        return { iso2: c.iso2, name: c.name, territory: false };
      });
      TCF.TERRITORIES.forEach(function (code) {
        items.push({ iso2: code, name: territoryName(code), territory: true });
      });

      render();
      // Keep the "resets in N min" countdown live while the popup is open.
      setInterval(renderBudget, 5000);
    })
    .catch(function (e) {
      console.warn('tcf popup', e);
      budgetEl.textContent = '—';
      render();
    });
})();
