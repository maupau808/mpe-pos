/* Shop-wide settings (Trevor 2026-11-05, 1A): one "Settings" tab in the sales sheet, shared by the Mac app, PC Left, PC Right
 * and the website. Rows A:D = key, value, recorded_at (ISO), place (Mac app / PC Left / PC Right / app / browser). Append-only:
 * for a key the newest recorded_at wins; a missing tab or no row means the default (review_qr: off).
 *
 * Print reads get() only: a synchronous localStorage read (mpeShopSettingsV1 { review_qr, at, readAt }), never the network.
 * refresh() runs in the background (page load, every 5 minutes, window shown again). set() changes this computer's cache at once,
 * then appends durably through ledger-host.js createRowStore (kept in localStorage, appended, read back, removed only then; a row
 * left behind is sent on the next refresh). The first write adds the tab (exact addSheet) and its header row, as Codes and Payments.
 * An app older than 0.3.71 refuses the Settings range: status 'old_app' and the switch says OLD_APP_TEXT; print keeps the cache.
 * Loaded by index.html (register) and ledger.html (History, through MPELedgerHost.shopSettings). Test: node POS/test_shop_settings.cjs
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.MPEShopSettings = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const CACHE_KEY = 'mpeShopSettingsV1';
  const PENDING_KEY = 'mpeShopSettingsPendingV1';
  const RANGE = 'Settings!A:D', APPEND = 'Settings!A1';
  const HEADER = ['key', 'value', 'recorded_at', 'place'];
  const VALUES = Object.freeze({ review_qr: ['on', 'off'] });
  const DEFAULTS = Object.freeze({ review_qr: 'off' });
  const REFRESH_MS = 5 * 60 * 1000;   // other computers pick a change up within this
  const MIN_GAP_MS = 30 * 1000;       // a window shown again refreshes, but not more often than this
  const OLD_APP_TEXT = 'Update the counter app to change this';
  const PLACES = { 1: 'Mac app', 2: 'PC Left', 3: 'PC Right', 4: 'Tech Dept', 5: 'back_office' };

  const s = v => String(v == null ? '' : v).trim();
  const idOf = r => [0, 1, 2, 3].map(i => s(r && r[i])).join('\u0001');
  const TAB = { range: RANGE, appendRange: APPEND, pendingKey: PENDING_KEY, missingText: 'Settings tab not set up yet', missingCode: 'settings_missing',
    noun: 'setting', idOf, same: (a, b) => !!a && idOf(a) === idOf(b) };
  const kit = () => root.MPELedgerHostKit || require('./ledger-host.js');
  const storageOf = () => { try { return root.localStorage || null; } catch (_) { return null; } };
  const notAllowed = e => /not allowed/i.test(s(e && e.message));

  function readCache(storage) {
    try { const v = JSON.parse((storage && storage.getItem(CACHE_KEY)) || 'null'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
  }
  // The value print uses: synchronous, local only.
  function get(key, storage) {
    const v = readCache(storage === undefined ? storageOf() : storage)[key];
    return VALUES[key] && VALUES[key].includes(v) ? v : DEFAULTS[key];
  }
  // Sheet rows -> { key: { value, at } }: the newest recorded_at wins (ISO text sorts in time order; a later row wins a tie).
  function newest(rows) {
    const out = {};
    for (const r of rows || []) {
      const key = s(r && r[0]), value = s(r && r[1]).toLowerCase(), at = s(r && r[2]);
      if (!VALUES[key] || !VALUES[key].includes(value) || !at) continue;   // the header row and anything unknown
      if (!out[key] || at >= out[key].at) out[key] = { value, at };
    }
    return out;
  }
  // Where a row came from: the register digit (1 Mac, 2 PC Left, 3 PC Right, 4 Tech Dept, 5 back_office) in the app, else the browser.
  const placeLabel = (digit, app) => (app ? PLACES[s(digit)] || 'app' : 'browser');

  // deps: { get(range), append(range, rows), addTab(), storage, place, now }. addTab adds the Settings tab (only that tab).
  function create({ get: read, append, addTab, storage = storageOf(), place = '', now = () => Date.now() }) {
    const store = kit().createRowStore({ get: read, append, storage }, TAB);
    let state = 'unknown', last = -Infinity, running = null, sets = 0;
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => { try { fn(); } catch (_) { /* a broken listener never stops the others */ } });
    // ponytail: one setting, so the cache keeps one recorded_at; give each key its own when a second setting arrives.
    function save(map, readAt) {
      const c = readCache(storage);
      for (const key of Object.keys(VALUES)) {
        c[key] = map[key] ? map[key].value : DEFAULTS[key];
        c.at = map[key] ? map[key].at : '';
      }
      if (readAt != null) c.readAt = readAt;
      try { storage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (_) { /* blocked storage: print falls back to the default */ }
    }
    const pending = () => store.pending();
    const keep = rows => storage.setItem(PENDING_KEY, JSON.stringify(rows));
    async function createTab() {
      try { await addTab(); } catch (e) { if (/already exists/i.test(s(e && e.message))) return; throw e; } // another computer made it first
      if (await append(APPEND, [HEADER]) === false) throw Object.assign(new Error('Not signed in'), { code: 'not_signed_in' });
    }
    // Rows waiting on this computer -> the sheet. The first write adds the tab.
    async function send() {
      try { await store.appendRows([]); } catch (e) {
        if (e.code !== 'settings_missing' || typeof addTab !== 'function') throw e;
        await createTab();
        await store.appendRows([]);
      }
    }
    const statusOf = e => (notAllowed(e) ? 'old_app' : e && e.code === 'not_signed_in' ? 'signed_out' : 'error');

    // Background only (never on the print path). Throttled unless force.
    function refresh({ force = false } = {}) {
      if (running) return running;
      if (!force && now() - last < MIN_GAP_MS) return Promise.resolve(state);
      last = now();
      const before = sets;
      running = (async () => {
        let rows;
        try { rows = await store.readAll(); state = 'ok'; } catch (e) {
          if (e.code !== 'settings_missing') { state = statusOf(e); return state; }
          state = 'ok';
          rows = pending();
          if (rows.length) send().catch(() => {}); // a switch pressed before the tab existed: add it now
        }
        if (before === sets) save(newest(rows), now()); // a press during the read wins over what was read
        return state;
      })().finally(() => { running = null; notify(); });
      return running;
    }

    // The switch. The cache changes at once; the row is kept here until the sheet shows it.
    async function set(key, value) {
      if (!VALUES[key] || !VALUES[key].includes(value)) throw new Error('Unknown setting');
      if (state === 'old_app') throw new Error(OLD_APP_TEXT);
      const prev = readCache(storage), row = [key, value, new Date(Math.max(now(), (Date.parse(prev.at) || 0) + 1)).toISOString(), place]; // always after the value it replaces, even if another computer's clock runs fast
      sets++;
      save({ [key]: { value, at: row[2] } });
      keep([...pending(), row]);
      notify();
      try { await send(); } catch (e) {
        if (!notAllowed(e)) throw e; // kept: the next refresh tries again
        keep(pending().filter(r => idOf(r) !== idOf(row)));
        try { storage.setItem(CACHE_KEY, JSON.stringify(prev)); } catch (_) { /* blocked storage */ }
        state = 'old_app';
        notify();
        throw new Error(OLD_APP_TEXT);
      }
    }

    // Page load, every 5 minutes, the window shown again; another page on this computer changing the cache redraws the switch.
    function start(w) {
      refresh({ force: true });
      const timer = setInterval(() => refresh({ force: true }), REFRESH_MS);
      const shown = () => { if (w.document.visibilityState === 'visible') refresh(); };
      const changed = e => { if (e.key === CACHE_KEY) notify(); };
      w.document.addEventListener('visibilitychange', shown);
      w.addEventListener('storage', changed);
      return () => { clearInterval(timer); w.document.removeEventListener('visibilitychange', shown); w.removeEventListener('storage', changed); };
    }

    return {
      get: key => get(key, storage),
      refresh, set, start, pending,
      status: () => state,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  return { CACHE_KEY, PENDING_KEY, RANGE, APPEND, HEADER, DEFAULTS, REFRESH_MS, MIN_GAP_MS, OLD_APP_TEXT, get, newest, placeLabel, create };
});
