'use strict';
// The real Ledger host (POS/ledger-host.js) against a fake Google sheet: durable Payments writes, marks, the missing-tab
// state, the one-time setup, the record -> sale-tab mapping, the register's open-in-new-sale fill, and scan forwarding.
// No network, no sign-in, no live sheet. Run: node POS/test_ledger_host.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./ledger-data.js');
const K = require('./ledger-host.js');
const LedgerTab = require('./ledger-tab.js');
const { createFixtureHost } = require('./ledger-host-fixture.js');
const { ledgerSaleRequest } = require('../POSDesktop/src/pos-tabs.js');

// A fake sheet that behaves like Sheets USER_ENTERED: a leading ' keeps the text and is not stored.
function fakeSheet({ payments = true, signedIn = true } = {}) {
  const tabs = {};
  if (payments) tabs.Payments = [L.PAYMENT_COLUMNS.slice()];
  const calls = { append: 0, batch: [] };
  const sheet = {
    tabs, calls, failAppend: false, dropOnAppend: false,
    async get(range) {
      if (!signedIn) throw new Error('Not signed in');
      const tab = range.split('!')[0];
      if (!tabs[tab]) throw new Error(`Unable to parse range: ${range}`);
      return /A1:J1$/.test(range) ? tabs[tab].slice(0, 1).map(r => r.slice()) : tabs[tab].map(r => r.slice());
    },
    async append(range, rows) {
      if (!signedIn) return false;
      calls.append++;
      if (sheet.failAppend) throw new Error('network down');
      const tab = range.split('!')[0];
      if (!tabs[tab]) throw new Error(`Unable to parse range: ${range}`);
      if (!sheet.dropOnAppend) tabs[tab].push(...rows.map(r => r.map(v => String(v).replace(/^'/, ''))));
      return { updates: { updatedRange: range } };
    },
    async batchUpdate(requests) { calls.batch.push(requests); for (const r of requests) tabs[r.addSheet.properties.title] = []; return true; },
  };
  return sheet;
}
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
const pay = (id, method = 'cash') => L.buildPaymentRow({ payment_id: id, invoice_number: 'L21001', txnId: 'T-1', date: '2026-10-31', amount: 120.5, method, place: '9' }, Date.parse('2026-10-31T20:00:00Z'));

test('a payment is appended as text, read back exactly, then dropped from this computer', async () => {
  const sheet = fakeSheet(), storage = memoryStorage();
  const store = K.createPaymentsStore({ get: sheet.get, append: sheet.append, storage });
  await store.appendRows([pay('pay_a')]);
  assert.deepEqual(sheet.tabs.Payments[1], pay('pay_a'));
  assert.equal(sheet.tabs.Payments[1][4], '120.50', 'amount stays text, not a number');
  assert.deepEqual(store.pending(), []);
});

test('a failed append stays saved here, shows on the screen, and is sent once on the next load', async () => {
  const sheet = fakeSheet(), storage = memoryStorage();
  const store = K.createPaymentsStore({ get: sheet.get, append: sheet.append, storage });
  sheet.failAppend = true;
  await assert.rejects(store.appendRows([pay('pay_b')]));
  assert.equal(store.pending().length, 1);
  sheet.failAppend = false;
  const rows = await store.readAll();
  assert.ok(rows.some(r => r[0] === 'pay_b'));
  assert.deepEqual(store.pending(), []);
  await store.readAll();
  assert.equal(sheet.tabs.Payments.filter(r => r[0] === 'pay_b').length, 1, 'never sent twice');
});

test('a write that does not read back is kept and retried; while waiting it still shows', async () => {
  const sheet = fakeSheet(), storage = memoryStorage();
  const store = K.createPaymentsStore({ get: sheet.get, append: sheet.append, storage });
  sheet.dropOnAppend = true;
  await assert.rejects(store.appendRows([pay('pay_c')]), /tried again/);
  assert.ok((await store.readAll()).some(r => r[0] === 'pay_c'), 'shown from this computer');
  sheet.dropOnAppend = false;
  await store.readAll();
  assert.deepEqual(store.pending(), []);
});

test('signed out: nothing is kept and the error says not_signed_in', async () => {
  const sheet = fakeSheet({ signedIn: false }), storage = memoryStorage();
  const store = K.createPaymentsStore({ get: sheet.get, append: sheet.append, storage });
  await assert.rejects(store.appendRows([pay('pay_d')]), e => e.code === 'not_signed_in');
  assert.deepEqual(store.pending(), []);
});

test('no Payments tab: the page says so, everything else loads, Mark paid keeps nothing, the tab is never created', async () => {
  const sheet = fakeSheet({ payments: false }), storage = memoryStorage();
  const note = { textContent: '', hidden: true };
  const env = { kind: 'web', place: '9', storage, signedIn: async () => true, get: sheet.get, append: sheet.append };
  const host = K.createHost(env, { document: { getElementById: id => (id === 'hostNote' ? note : null) } });
  const [pays, marks] = await Promise.all([host.readPayments(), host.readMarks()]);
  assert.deepEqual(pays, [L.PAYMENT_COLUMNS.slice()]);
  assert.deepEqual(marks, { drafts: {}, edits: {} });
  assert.equal(note.textContent, 'Payments tab not set up yet');
  assert.equal(note.hidden, false);
  await assert.rejects(host.appendPaymentRows([pay('pay_e')]), e => e.code === 'payments_missing');
  assert.deepEqual(JSON.parse(storage.getItem(K.PENDING_KEY) || '[]'), []);
  assert.equal(sheet.tabs.Payments, undefined);
  assert.equal(sheet.calls.batch.length, 0);
});

test('marks: email_draft and edit rows never count as payments; readMarks returns their dates', async () => {
  const draft = L.buildMarkRow({ kind: 'email_draft', txnId: 'T-1', invoice_number: 'L21001', place: '9' }, Date.parse('2026-10-20T20:00:00Z'));
  const edit = L.buildMarkRow({ kind: 'edit', txnId: 'T-1', invoice_number: 'L21001', place: '2' }, Date.parse('2026-10-25T20:00:00Z'));
  assert.equal(draft[4], '0.00');
  assert.throws(() => L.buildMarkRow({ kind: 'cash', txnId: 'T-1' }));
  const rows = [L.PAYMENT_COLUMNS.slice(), draft, edit];
  assert.deepEqual(L.parsePayments(rows), []);
  assert.deepEqual(L.parseMarks(rows), { drafts: { 'T-1': '2026-10-20' }, edits: { 'T-1': '2026-10-25' } });
  const txn = [['TXN', 'T-1', '10/01/2026', '9:00 AM', 'A', '', '', '', '', '', '', '', '100.00', '', 'invoice', 'L21001']];
  const [rec] = L.derive(L.parseTransactions(txn), L.parsePayments(rows), '2026-10-31', L.parseMarks(rows).drafts);
  assert.equal(rec.state, 'dueSoon', 'still owed: a mark is not a payment');
  assert.equal(rec.paid, 0);
  assert.equal(rec.draftText, 'Draft made');

  const sheet = fakeSheet(), storage = memoryStorage();
  sheet.tabs.Payments.push(draft, edit);
  let reads = 0;
  const env = { kind: 'app', place: '1', storage, signedIn: async () => true, get: r => { reads++; return sheet.get(r); }, append: sheet.append };
  const host = K.createHost(env, {});
  const [, marks] = await Promise.all([host.readPayments(), host.readMarks()]);
  assert.equal(reads, 1, 'one read per load for payments and marks');
  assert.equal(marks.edits['T-1'], '2026-10-25');
});

test('the host maps a signed-out sheet to not_signed_in', async () => {
  const sheet = fakeSheet({ signedIn: false });
  const host = K.createHost({ kind: 'web', place: '9', storage: memoryStorage(), signedIn: async () => false, get: sheet.get, append: sheet.append }, {});
  await assert.rejects(host.readTransactions(), e => e.code === 'not_signed_in');
  await assert.rejects(host.readPayments(), e => e.code === 'not_signed_in');
});

test('one-time setup adds the tab and header and reads it back; it is idempotent and refuses a foreign row 1', async () => {
  const sheet = fakeSheet({ payments: false });
  assert.equal(await K.setupPaymentsTab(sheet), 'created');
  assert.deepEqual(sheet.calls.batch, [[{ addSheet: { properties: { title: 'Payments' } } }]]);
  assert.deepEqual(sheet.tabs.Payments, [L.PAYMENT_COLUMNS.slice()]);
  assert.equal(await K.setupPaymentsTab(sheet), 'already set up');
  assert.equal(sheet.tabs.Payments.length, 1);
  const other = fakeSheet();
  other.tabs.Payments = [['something', 'else']];
  await assert.rejects(K.setupPaymentsTab(other), /Nothing was changed/);
});

test('Reprint in the app prints through printDocument; only a fallback uses the page print', async () => {
  const printed = [];
  const env = { kind: 'app', place: '1', storage: memoryStorage(), signedIn: async () => true, get: async () => [], append: async () => true,
    printDocument: async request => { printed.push(request.number); return { ok: true }; } };
  const host = K.createHost(env, {});
  await host.reprint({}, { type: 'invoice', number: 'L21001' });
  assert.deepEqual(printed, ['L21001']);
  env.printDocument = async () => ({ ok: false });
  await assert.rejects(host.reprint({}, { type: 'invoice', number: 'L21001' }), /printer/);
});

const fixtureRecords = async () => {
  const fx = createFixtureHost({ today: '2026-10-31' });
  const m = await L.create({ txnRows: await fx.readTransactions(), paymentRows: await fx.readPayments(), today: '2026-10-31', displayRows: rows => ({ rows, states: new Map() }) });
  return m.records;
};

test('a Ledger record becomes the History shape the register fills from; both bridges accept every kind', async () => {
  const recs = await fixtureRecords();
  const r = recs.find(x => x.number === 'L21007');
  const h = K.toHistory(r);
  assert.equal(h.txnId, 'T-L21007');
  assert.equal(h.docType, 'invoice');
  assert.equal(h.docNumber, 'L21007');
  assert.match(h.date, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(h.name, 'Kainoa Akana / Akana Landscaping LLC');
  assert.deepEqual(h.customer, ['Kainoa Akana', 'Akana Landscaping LLC', 'PO Box 1182', 'Makawao', 'HI', '96768']);
  assert.deepEqual(h.items[0], { pn: 'FS131', desc: 'Stihl FS 131 trimmer', qty: '1', ea: '499.95', sub: '499.95', sn: '520114873' });
  assert.ok(!('paymentsLive' in h) && !('_hay' in h), 'only the fields the register reads');
  const note = K.toHistory(recs.find(x => x.number === 'L21009')).items.find(i => i.pn === 'Note');
  assert.deepEqual([note.ea, note.sub], ['', '']);
  for (const [kind, want] of Object.entries(K.SALE_KINDS)) {
    const req = K.saleRequest(kind, r);
    assert.equal(req.kind, want);
    assert.deepEqual(LedgerTab.saleMessage(req), req, 'website bridge');
    assert.deepEqual(ledgerSaleRequest(req), req, 'app bridge');
  }
  assert.throws(() => K.saleRequest('delete', r));
});

// The register's openLedgerSale, run as written in index.html with the register's helpers stubbed.
function runOpenLedgerSale(sale, { empty = true } = {}) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const start = html.indexOf('function openLedgerSale(');
  const src = html.slice(start, html.indexOf('\n}\n', start) + 2);
  const log = [];
  const ctx = {
    _reprintSource: null, _quoteSource: null, alerted: '',
    ledgerDraftTabIsEmpty: () => empty,
    alert: m => { ctx.alerted = m; },
    updateScreenDocTitle: () => log.push(['title']),
    fillTxnIntoPOS: (t, convertTo = null) => {
      log.push(['fill', t.items.length, convertTo]);
      if (convertTo) ctx._quoteSource = { txnId: t.txnId }; else ctx._reprintSource = { txnId: t.txnId, docNumber: t.docNumber };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nopenLedgerSale(' + JSON.stringify(sale) + ');', ctx);
  return { ctx, log };
}

test('register: edit keeps the record in place and flags it; copy and new invoice are new sales; a busy tab is never touched', async () => {
  const r = (await fixtureRecords()).find(x => x.number === 'L21007');
  let run = runOpenLedgerSale(K.saleRequest('edit', r));
  assert.deepEqual(run.log, [['fill', 3, null]]);
  assert.deepEqual(run.ctx._reprintSource, { txnId: 'T-L21007', docNumber: 'L21007', ledgerEdit: true });
  run = runOpenLedgerSale(K.saleRequest('copy', r));
  assert.deepEqual(run.log, [['fill', 3, 'invoice'], ['title']]);
  assert.equal(run.ctx._quoteSource, null, 'a copy is not linked to the old sale');
  assert.equal(run.ctx._reprintSource, null, 'a copy gets a new number');
  run = runOpenLedgerSale(K.saleRequest('newInvoice', r));
  assert.deepEqual(run.log, [['fill', 0, 'invoice'], ['title']]);
  run = runOpenLedgerSale(K.saleRequest('quote', r));
  assert.deepEqual(run.log, [['fill', 3, 'receipt']]);
  assert.equal(run.ctx._quoteSource.txnId, 'T-L21007');
  run = runOpenLedgerSale(K.saleRequest('edit', r), { empty: false });
  assert.deepEqual(run.log, []);
  assert.match(run.ctx.alerted, /not empty/);
  run = runOpenLedgerSale({ kind: 'edit', txn: { ...K.toHistory(r), contactConflict: true } });
  assert.deepEqual(run.log, []);
});

test('register: an in-place save of a Ledger edit leaves an edit mark; nothing else does', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /if \(identity\.ledgerEdit\) order\.ledgerEdit = true;/);
  assert.match(html, /if \(order\.ledgerEdit && writeMode === '\(updated existing\)'\) queueLedgerEditMark\(order, txnId\);/);
  assert.match(html, /<script src="ledger-data\.js"><\/script>\s*<script src="ledger-host\.js"><\/script>/);
});

test('scanner: a burst the register proves is a scan leaves Ledger, restores the search, and shows the sale tab', () => {
  const listeners = [];
  const field = { tagName: 'INPUT', events: [], dispatchEvent(e) { this.events.push(e.type); } };
  class Ev { constructor(type) { this.type = type; } }
  const win = { document: { activeElement: field }, Event: Ev, addEventListener: (type, fn, capture) => listeners.push([type, fn, capture]) };
  let shown = 0;
  const seen = [];
  // Stand-in for onHardwareScanKeydown: it prevents the Enter that ends a proven burst.
  const scanKeydown = e => { seen.push(e.key); if (e.key === 'Enter' && e.burst) e.defaultPrevented = true; };
  LedgerTab.forwardScans(win, scanKeydown, () => shown++);
  assert.equal(listeners.length, 1);
  const [type, fn, capture] = listeners[0];
  assert.deepEqual([type, capture], ['keydown', true]);
  for (const key of ['1', '2', '3']) fn({ key, defaultPrevented: false });
  fn({ key: 'Enter', defaultPrevented: false, burst: true });
  assert.equal(shown, 1);
  assert.deepEqual(field.events, ['input']);
  fn({ key: 'Enter', defaultPrevented: false, burst: false }); // slow typing + Enter stays in Ledger
  assert.equal(shown, 1);
  assert.deepEqual(seen, ['1', '2', '3', 'Enter', 'Enter'], 'every key goes through the register test');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /scanKeydown:onHardwareScanKeydown,onScan:\(\)=>activateTab\(activeTab\)/);
  assert.match(html, /const view = target\?\.ownerDocument\?\.defaultView \|\| window;/, 'a field in the Ledger frame is restored too');
});

test('scan clock: a scan in the Ledger frame and one on the register share one repeat guard', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const fn = name => { const a = html.indexOf('function ' + name + '('); return html.slice(a, html.indexOf('\n}\n', a) + 2); };
  const register = { timeOrigin: 1_700_000_000_000, now: () => 0 };
  const frameClock = { timeOrigin: register.timeOrigin + 60_000 }; // the Ledger frame loaded a minute after the register
  const ctx = { performance: register, Date, Number, Math, scanRecentValues: new Map(), SCAN_HARDWARE_REPEAT_LOCKOUT_MS: 100,
    SCAN_REPEAT_LOCKOUT_MS: 2250, hardwareFastRepeatEnabled: () => true, canonicalScannedCode: v => String(v).toUpperCase() };
  vm.createContext(ctx);
  vm.runInContext(fn('hardwareKeyTime') + fn('hardwareKeyWallTime') + fn('claimScannedValue'), ctx);
  const inFrame = stamp => ({ timeStamp: stamp, target: { ownerDocument: { defaultView: { performance: frameClock } } } });
  const onRegister = stamp => ({ timeStamp: stamp, target: { ownerDocument: { defaultView: { performance: register } } } });
  const frameAt = ctx.hardwareKeyWallTime(ctx.hardwareKeyTime(inFrame(500)));      // wall clock: origin + 60.5 s
  const registerAt = ctx.hardwareKeyWallTime(ctx.hardwareKeyTime(onRegister(60_550))); // 50 ms later on the register
  assert.equal(registerAt - frameAt, 50);
  assert.equal(ctx.claimScannedValue('70421', frameAt, 'hardware'), true);
  assert.equal(ctx.claimScannedValue('70421', registerAt, 'hardware'), false, 'the same code 50 ms later is a repeat');
  assert.equal(ctx.claimScannedValue('70421', registerAt + 150, 'hardware'), true);
  assert.equal(ctx.hardwareKeyTime({ timeStamp: 1234 }), 1234, 'an event with no window uses the register clock as before');
});
