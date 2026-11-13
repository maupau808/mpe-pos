// Shop-wide settings (POS/shop-settings.js, T8): newest row wins, missing tab = off, get() is a local synchronous read, refresh is
// throttled, set() changes the cache at once and appends durably (kept, retried, removed only after the sheet shows it), the first
// write adds the tab and header, an older app's refusal says "Update the counter app". No network: a fake sheet.
// node POS/test_shop_settings.cjs
const assert = require('node:assert/strict');
const S = require('./shop-settings.js');

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
// tab: null = no Settings tab. offline: reads and appends throw. refuse: an older app's allow-list answer.
function fakeSheet(tab) {
  const f = { tab, offline: false, refuse: false, reads: 0, appends: [], adds: 0 };
  const gate = () => {
    if (f.refuse) throw new Error('Google Sheet range is not allowed');
    if (f.offline) throw new Error('Failed to fetch');
  };
  f.get = async range => {
    f.reads++; gate();
    if (!f.tab) throw new Error('Unable to parse range: ' + range);
    return f.tab.map(r => r.slice());
  };
  f.append = async (range, rows) => {
    gate();
    if (!f.tab) throw new Error('Unable to parse range: ' + range);
    f.appends.push({ range, rows });
    f.tab.push(...rows.map(r => r.map(v => String(v).replace(/^'/, ''))));
    return { updates: {} };
  };
  f.addTab = async () => { f.adds++; if (f.tab) throw new Error('A sheet with the name "Settings" already exists'); f.tab = []; };
  return f;
}

const results = [];
const check = async (name, fn) => { await fn(); results.push(name); console.log('ok  ', name); };

(async () => {
  await check('newest recorded_at wins; header, junk and unknown keys are ignored', () => {
    const rows = [S.HEADER, ['review_qr', 'on', '2026-11-05T10:00:00.000Z', 'PC Left'], ['review_qr', 'off', '2026-11-05T09:00:00.000Z', 'Mac app'],
      ['review_qr', 'maybe', '2026-11-06T00:00:00.000Z', 'x'], ['other', 'on', '2026-11-07T00:00:00.000Z', 'x']];
    assert.deepEqual(S.newest(rows), { review_qr: { value: 'on', at: '2026-11-05T10:00:00.000Z' } });
    assert.equal(S.newest([...rows, ['review_qr', 'OFF', '2026-11-05T11:00:00.000Z', 'browser']]).review_qr.value, 'off');
  });

  await check('get() is a synchronous local read: off with no cache, broken cache or blocked storage', () => {
    const st = memStorage();
    assert.equal(S.get('review_qr', st), 'off');
    st.setItem(S.CACHE_KEY, '{bad');
    assert.equal(S.get('review_qr', st), 'off');
    assert.equal(S.get('review_qr', { getItem() { throw new Error('blocked'); } }), 'off');
    st.setItem(S.CACHE_KEY, JSON.stringify({ review_qr: 'on', at: 'x', readAt: 1 }));
    assert.equal(S.get('review_qr', st), 'on');
  });

  await check('place labels: Mac app / PC Left / PC Right / Tech Dept / back_office / app / browser', () => {
    assert.deepEqual(['1', '2', '3', '4', '5', ''].map(d => S.placeLabel(d, true)), ['Mac app', 'PC Left', 'PC Right', 'Tech Dept', 'back_office', 'app']);
    assert.equal(S.placeLabel('6', true), 'app');
    assert.equal(S.placeLabel('1', false), 'browser');
  });

  await check('missing tab = off; refresh fills the cache from the sheet', async () => {
    const st = memStorage(), f = fakeSheet(null);
    const s = S.create({ ...f, storage: st, now: () => 1000 });
    assert.equal(await s.refresh({ force: true }), 'ok');
    assert.equal(s.get('review_qr'), 'off');
    assert.equal(f.adds, 0, 'a read never adds the tab');
    f.tab = [S.HEADER, ['review_qr', 'on', '2026-11-05T10:00:00.000Z', 'PC Right']];
    await s.refresh({ force: true });
    assert.equal(S.get('review_qr', st), 'on');
    assert.deepEqual(JSON.parse(st.getItem(S.CACHE_KEY)), { review_qr: 'on', at: '2026-11-05T10:00:00.000Z', readAt: 1000 });
  });

  await check('refresh is throttled (30 s) unless forced; a running refresh is shared', async () => {
    let t = 0;
    const f = fakeSheet([]), s = S.create({ ...f, storage: memStorage(), now: () => t });
    await Promise.all([s.refresh(), s.refresh()]);
    assert.equal(f.reads, 1);
    t = 10000; await s.refresh();
    assert.equal(f.reads, 1, 'throttled');
    t = 31000; await s.refresh();
    assert.equal(f.reads, 2);
    await s.refresh({ force: true });
    assert.equal(f.reads, 3);
  });

  await check('set: cache at once, first write adds the tab + header, row appended and removed after read-back', async () => {
    const st = memStorage(), f = fakeSheet(null);
    const s = S.create({ ...f, storage: st, place: 'PC Left', now: () => Date.UTC(2026, 10, 5, 12) });
    let seen = 0; s.subscribe(() => seen++);
    const p = s.set('review_qr', 'on');
    assert.equal(S.get('review_qr', st), 'on', 'shows at once, before the sheet answers');
    await p;
    assert.equal(f.adds, 1);
    assert.deepEqual(f.tab, [S.HEADER, ['review_qr', 'on', '2026-11-05T12:00:00.000Z', 'PC Left']]);
    assert.deepEqual(f.appends.map(a => a.range), ['Settings!A1', 'Settings!A1']);
    assert.deepEqual(s.pending(), []);
    assert.ok(seen >= 1);
  });

  await check('set offline: kept on this computer, sent by the next refresh, then removed', async () => {
    const st = memStorage(), f = fakeSheet([S.HEADER]);
    let t = Date.UTC(2026, 10, 5, 12);
    const s = S.create({ ...f, storage: st, place: 'Mac app', now: () => t });
    f.offline = true;
    await assert.rejects(s.set('review_qr', 'on'));
    assert.equal(S.get('review_qr', st), 'on');
    assert.equal(s.pending().length, 1);
    await s.refresh({ force: true });
    assert.equal(S.get('review_qr', st), 'on', 'an offline refresh keeps the cache');
    f.offline = false; t += 60000;
    await s.refresh({ force: true });
    assert.deepEqual(s.pending(), []);
    assert.equal(f.tab.length, 2);
    assert.equal(S.get('review_qr', st), 'on');
  });

  await check('a press while a refresh is reading wins over what was read', async () => {
    const st = memStorage(), f = fakeSheet([S.HEADER, ['review_qr', 'off', '2026-11-05T01:00:00.000Z', 'PC Left']]);
    let release; const hold = new Promise(r => { release = r; });
    const realGet = f.get; f.get = async r => { await hold; return realGet(r); };
    const s = S.create({ ...f, storage: st, now: () => Date.UTC(2026, 10, 5, 12) });
    const r = s.refresh({ force: true });
    const w = s.set('review_qr', 'on');
    release(); await r; await w;
    assert.equal(S.get('review_qr', st), 'on');
  });

  await check('an older app refuses the range: status old_app, set refused with the update text, cache unchanged, nothing kept', async () => {
    const st = memStorage(), f = fakeSheet([]);
    f.refuse = true;
    const s = S.create({ ...f, storage: st });
    await assert.rejects(s.set('review_qr', 'on'), { message: S.OLD_APP_TEXT });
    assert.equal(S.get('review_qr', st), 'off');
    assert.deepEqual(s.pending(), []);
    assert.equal(s.status(), 'old_app');
    await assert.rejects(s.set('review_qr', 'on'), { message: S.OLD_APP_TEXT });
    assert.equal(await s.refresh({ force: true }), 'old_app');
  });

  await check('signed out: status signed_out, cache kept', async () => {
    const st = memStorage(); st.setItem(S.CACHE_KEY, JSON.stringify({ review_qr: 'on' }));
    const s = S.create({ get: async () => { throw new Error('Not signed in'); }, append: async () => false, storage: st });
    assert.equal(await s.refresh({ force: true }), 'signed_out');
    assert.equal(s.get('review_qr'), 'on');
  });

  await check('a fast clock on another computer cannot undo a later press here', async () => {
    const fast = new Date(Date.UTC(2026, 10, 5, 12, 10)).toISOString(); // PC Left, 10 minutes fast
    const f = fakeSheet([['review_qr', 'on', fast, 'PC Left']]);
    const s = S.create({ ...f, storage: memStorage(), place: 'Mac app', now: () => Date.UTC(2026, 10, 5, 12, 1) });
    await s.refresh({ force: true });
    assert.equal(s.get('review_qr'), 'on');
    await s.set('review_qr', 'off');
    await s.refresh({ force: true });
    assert.equal(s.get('review_qr'), 'off', 'the press sorts after the value it replaced');
  });

  await check('unknown values and keys are refused', async () => {
    const s = S.create({ ...fakeSheet([]), storage: memStorage() });
    await assert.rejects(s.set('review_qr', 'yes'));
    await assert.rejects(s.set('nope', 'on'));
  });

  console.log(`${results.length}/${results.length} passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
