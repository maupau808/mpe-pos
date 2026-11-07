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
const { ledgerSaleRequest, ledgerEditRequest } = require('../POSDesktop/src/pos-tabs.js');

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
      return /A1:K1$/.test(range) ? tabs[tab].slice(0, 1).map(r => r.slice()) : tabs[tab].map(r => r.slice());
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
  assert.deepEqual(marks, { drafts: {}, edits: {}, cancels: {}, before: {}, prints: {}, pdfs: {}, log: {}, sent: {}, paylinks: {}, editLog: {} });
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
  assert.deepEqual(L.parseMarks(rows), { drafts: { 'T-1': '2026-10-20' }, edits: { 'T-1': '2026-10-25' }, cancels: {}, before: {}, prints: {}, pdfs: {}, sent: {}, paylinks: {}, editLog: { 'T-1': [{ at: '2026-10-25T20:00:00.000Z', date: '2026-10-25', rows: null }] },
    log: { 'T-1': [{ kind: 'email_draft', date: '2026-10-20', at: '2026-10-20T20:00:00.000Z', place: '9', note: '' }] } });
  // Prints, PDFs and PDF opens: never payments, one timeline entry each, oldest stays first.
  const out = [L.buildMarkRow({ kind: 'print', txnId: 'T-1', invoice_number: 'L21001', place: '2' }, Date.parse('2026-10-21T20:00:00Z')),
    L.buildMarkRow({ kind: 'print', txnId: 'T-1', invoice_number: 'L21001', place: '1', note: 'reprint' }, Date.parse('2026-10-22T20:00:00Z')),
    L.buildMarkRow({ kind: 'pdf', txnId: 'T-1', invoice_number: 'L21001', place: '3' }, Date.parse('2026-10-23T20:00:00Z')),
    L.buildMarkRow({ kind: 'pdf_open', txnId: 'T-1', invoice_number: 'L21001', place: '1' }, Date.parse('2026-10-24T20:00:00Z')),
    L.buildMarkRow({ kind: 'email_sent', txnId: 'T-1', invoice_number: 'L21001', place: '1', note: 'kai@example.test' }, Date.parse('2026-10-25T21:00:00Z'))];
  assert.deepEqual(L.parsePayments([...rows, ...out]), []);
  assert.deepEqual(L.parseMarks([...rows, ...out]).log['T-1'].map(m => m.kind + ':' + m.note), ['email_draft:', 'print:', 'print:reprint', 'pdf:', 'pdf_open:', 'email_sent:kai@example.test']);
  assert.deepEqual([...L.cancelledIds([...rows, ...out])], []);
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

// ---- Customers tab: the same durable rule as Payments (one store implementation, two tabs) ----
const custRow = (ref = '8') => L.buildCustomerRow({ company: 'Fake Co', name: 'Ann Fake', phone: '808-555-0808', email: 'a@x.example', street: '1 Fake Rd', city: 'Wailuku', region: 'HI', zip: '96793' }, ref, Date.parse('2026-11-01T20:00:00Z'));
const customerSheet = () => { const s = fakeSheet(); s.tabs.Customers = [L.CUSTOMER_COLUMNS.slice(0, 9)]; return s; };
test('a customer edit is appended as text (columns A to J), read back exactly, then dropped from this computer', async () => {
  const sheet = customerSheet(), storage = memoryStorage();
  const host = K.createHost({ kind: 'app', place: '1', storage, signedIn: async () => true, get: sheet.get, append: sheet.append }, {});
  await host.appendCustomerRows([custRow()]);
  assert.deepEqual(sheet.tabs.Customers[1], custRow());
  assert.equal(sheet.tabs.Customers[1].length, 10);
  assert.equal(sheet.tabs.Customers[1][9], '8', 'QBO Id in column J');
  assert.deepEqual(JSON.parse(storage.getItem(K.CUST_PENDING_KEY)), []);
  assert.equal(storage.getItem(K.PENDING_KEY), null, 'payments queue untouched');
  assert.deepEqual(await host.readCustomers(), sheet.tabs.Customers);
});
test('customer edit: a failed append stays saved and shows meanwhile; a write that does not read back is retried; never sent twice', async () => {
  const sheet = customerSheet(), storage = memoryStorage();
  const host = K.createHost({ kind: 'web', place: '9', storage, signedIn: async () => true, get: sheet.get, append: sheet.append }, {});
  sheet.failAppend = true;
  await assert.rejects(host.appendCustomerRows([custRow('')]));
  sheet.failAppend = false;
  assert.equal(JSON.parse(storage.getItem(K.CUST_PENDING_KEY)).length, 1);
  sheet.dropOnAppend = true;
  const shown = await host.readCustomers();           // tries again, the sheet still does not show it
  assert.deepEqual(shown.at(-1), custRow(''), 'a pending row is shown');
  assert.equal(JSON.parse(storage.getItem(K.CUST_PENDING_KEY)).length, 1);
  sheet.dropOnAppend = false;
  await host.readCustomers();
  await host.readCustomers();
  assert.equal(sheet.tabs.Customers.filter(r => r[0] === 'Fake Co').length, 1, 'sent once');
  assert.deepEqual(JSON.parse(storage.getItem(K.CUST_PENDING_KEY)), []);
});
test('customer edit: no Customers tab reads as no rows and saves nothing; the tab is never created; signed out says so', async () => {
  const sheet = fakeSheet(), storage = memoryStorage();
  const host = K.createHost({ kind: 'web', place: '9', storage, signedIn: async () => true, get: sheet.get, append: sheet.append }, {});
  assert.deepEqual(await host.readCustomers(), []);
  await assert.rejects(host.appendCustomerRows([custRow()]), e => e.code === 'customers_missing');
  assert.equal(sheet.tabs.Customers, undefined);
  assert.equal(sheet.calls.batch.length, 0);
  assert.deepEqual(JSON.parse(storage.getItem(K.CUST_PENDING_KEY) || '[]'), []);
  const out = fakeSheet({ signedIn: false });
  const h2 = K.createHost({ kind: 'web', place: '9', storage: memoryStorage(), signedIn: async () => false, get: out.get, append: out.append }, {});
  await assert.rejects(h2.appendCustomerRows([custRow()]), e => e.code === 'not_signed_in');
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
  await host.reprint({}, { type: 'receipt', number: 'R11001' });
  assert.deepEqual(printed, ['L21001', 'R11001'], 'receipts print through the app too');
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
  const disc = K.toHistory({ ...r, items: [{ pn: 'B270L', desc: 'Trimmer', qty: '1', ea: 445, sub: 445, serials: [], origEa: 508, off: 63 }] }).items[0];
  assert.deepEqual([disc.originalEa, disc.discountPerUnit], ['508.00', '63.00'], 'a discounted line loads back as a discount');
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
  assert.deepEqual(run.log, [['fill', 3, 'invoice']]); // Convert to invoice
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
  assert.match(html, /if \(order\.ledgerEdit\) \{\s*const kept = peekEditBefore\(txnId\);\s*if \(writeMode === '\(updated existing\)' \|\| kept !== null\)/);
  assert.match(html, /queueLedgerEditMark\(order, txnId, note, editMarkId\(txnId, rows\)\)/);
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

// ---- QuickBooks history: app IPC and website Drive read ----
const zlib = require('node:zlib');
const QBO = { version: 1, records: [{ kind: 'invoice', number: '10234' }] };
test('app: the QuickBooks copy comes through the Ledger bridge parsed; unchanged passes through; an older app has no such call', async () => {
  const seen = [];
  const desktop = { role: 'ledger', google: {}, platform: 'darwin',
    qboHistory: async known => { seen.push(known); return known === 'V1' ? { unchanged: true, modifiedTime: 'V1' } : { text: JSON.stringify(QBO), modifiedTime: 'V1' }; } };
  const env = K.environment({ mpeDesktop: desktop, navigator: { userAgent: 'Macintosh' } });
  const host = K.createHost(env, {});
  assert.deepEqual(await host.readQboHistory(''), { data: QBO, modifiedTime: 'V1' });
  assert.deepEqual(await host.readQboHistory('V1'), { unchanged: true, modifiedTime: 'V1' });
  assert.deepEqual(seen, ['', 'V1']);
  const old = K.createHost(K.environment({ mpeDesktop: { role: 'ledger', google: {} }, navigator: {} }), {});
  assert.equal(old.readQboHistory, undefined);
});
test('Refresh from QuickBooks: only the Mac app (preload gives qboRefresh on darwin) has it; Windows app and website have none', async () => {
  const calls = [];
  const base = { role: 'ledger', google: {}, qboHistory: async () => ({ unchanged: true }) };
  const mac = K.createHost(K.environment({ mpeDesktop: { ...base, platform: 'darwin', qboRefresh: async () => { calls.push('mac'); return { ok: true }; } }, navigator: { userAgent: 'Macintosh' } }), {});
  assert.deepEqual(await mac.refreshQbo(), { ok: true });
  assert.deepEqual(calls, ['mac']);
  const win = K.createHost(K.environment({ mpeDesktop: { ...base, platform: 'win32' }, navigator: {} }), {});
  assert.equal(win.refreshQbo, undefined);
  assert.equal(typeof win.readQboHistory, 'function', 'the PC still shows the "QuickBooks as of" line');
  const parent = { sheetsGet() {}, googleSessionAvailable: () => true, localStorage: { getItem: () => 't' } };
  const site = K.createHost(K.environment({ parent, DecompressionStream, Response }), {});
  assert.equal(site.refreshQbo, undefined);
  assert.equal(typeof site.readQboHistory, 'function');
  const preload = fs.readFileSync(path.join(__dirname, '../POSDesktop/src/ledger-tab-preload.js'), 'utf8');
  assert.match(preload, /process\.platform === 'darwin' \? \{ qboRefresh:/);
});
test('website: the page token reads the pinned Drive file (alt=media), gunzips it, and asks Drive once per page', async () => {
  const calls = [];
  const parent = { sheetsGet() {}, googleSessionAvailable: () => true, localStorage: { getItem: k => (k === 'gToken' ? 'fixture-token' : null) } };
  const w = { parent, document: undefined, DecompressionStream, Response,
    fetch: async (url, init) => { calls.push([url, init.headers.Authorization]); return new Response(zlib.gzipSync(JSON.stringify(QBO))); } };
  w.parent = parent;
  const host = K.createHost(K.environment(w), w);
  const first = await host.readQboHistory('');
  assert.deepEqual(first, { data: QBO, modifiedTime: 'web' });
  assert.deepEqual(calls, [[`https://www.googleapis.com/drive/v3/files/1TVEYXRKC8E_Db-46IUBPSCkQaBBROWBF?alt=media`, 'Bearer fixture-token']]);
  assert.deepEqual(await host.readQboHistory('web'), { unchanged: true });
  assert.equal(calls.length, 1);
  w.fetch = async () => new Response('no', { status: 401 });
  await assert.rejects(host.readQboHistory(''), e => e.code === 'not_signed_in');
  w.fetch = async () => new Response('no', { status: 500 });
  await assert.rejects(host.readQboHistory(''), /HTTP 500/);
});
test('the register page never loads or writes the QuickBooks file, and History code never writes to Drive or the sheet for it', () => {
  const host = fs.readFileSync(path.join(__dirname, 'ledger-host.js'), 'utf8');
  assert.equal((host.match(/QBO_FILE_ID/g) || []).length, 3, 'one constant, two uses (website read, export)');
  assert.ok(!/method:\s*'(PUT|PATCH|DELETE)'/.test(host));
  assert.ok(!fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').includes('1TVEYXRKC8E_Db'));
});

test('host.editSession builds one silent request: raw record, the card-fee hint, the loaded fingerprint and only the changed fields', async () => {
  const sent = [];
  const sheet = fakeSheet({ payments: true });
  const host = K.createHost({ kind: 'app', place: '1', storage: memoryStorage(), signedIn: async () => true, get: sheet.get, append: sheet.append, editSession: async req => { sent.push(req); return { v: 1, ok: true, verified: true, sessionId: req.sessionId }; } }, {});
  const record = { txnId: 'TX-1', date: '2026-11-04', time: '9:00 AM', name: 'JO', company: '', phone: '', email: '', addr: '', total: 100, kind: 'invoice', number: 'L21001', fromQuote: 'TX-Q', po: 'PO-9', fingerprint: '["fp"]', items: [{ pn: 'A', desc: 'Saw', qty: '1', ea: 100, sub: 100, serials: [] }] };
  const out = await host.editSession(record, { phone: '808', updateInfo: true }, { cardFee: true });
  assert.equal(out.ok, true);
  const req = sent[0];
  assert.deepEqual([req.v, req.kind, req.mode], [1, 'edit', 'silent']); assert.match(req.sessionId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(req.txn.po, 'PO-9'); assert.equal(req.txn.fromQuote, 'TX-Q'); assert.equal(req.txn.cardFee, true); assert.equal(req.loaded.fingerprint, '["fp"]');
  assert.deepEqual(req.patch, { phone: '808', updateInfo: true });
  assert.ok(ledgerEditRequest(req), 'main accepts exactly this shape');
  assert.ok(!req.txn.items.some(i => i.pn === 'Note'), 'the raw record: no synthetic deposit note');
  const none = await host.editSession({ ...record, fingerprint: '' }, { phone: '1' }, {});
  assert.equal(none.ok, false); assert.equal(none.code, 'open_sale_screen'); assert.equal(sent.length, 1, 'nothing is sent without a fingerprint');
  const old = K.createHost({ kind: 'app', place: '1', storage: memoryStorage(), signedIn: async () => true, get: sheet.get, append: sheet.append }, {});
  assert.equal(old.editSession, undefined, 'an app without the capability gets read-only fields');
});

test('website edit session: a hidden same-origin frame is sent the request once it says ready, answers once, is removed, and strangers are ignored', async () => {
  const listeners = [], posted = []; let removed = false, appended = null;
  const frameWin = { postMessage: (message, origin) => posted.push([message, origin]) };
  const frame = { style: {}, setAttribute() {}, remove() { removed = true; }, get contentWindow() { return frameWin; } };
  const p = { sheetsGet() {}, googleSessionAvailable: () => true, location: { origin: 'https://x.test', href: 'https://x.test/pos/index.html' },
    document: { createElement: () => frame, body: { append: f => { appended = f; } } },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); }, removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
  const w = { parent: p, location: { origin: 'https://x.test' }, localStorage: memoryStorage(), navigator: { userAgent: '' } };
  const env = K.environment(w);
  assert.equal(env.kind, 'web'); assert.equal(env.pdfRefresh, false);
  const request = { v: 1, sessionId: 'abcdefgh', txn: { txnId: 'T' } };
  const pending = env.editSession(request);
  assert.equal(frame.src, 'https://x.test/pos/index.html?mpeEditSession=1'); assert.equal(appended, frame);
  const say = (source, origin, data) => listeners.slice().forEach(fn => fn({ source, origin, data }));
  say({}, 'https://x.test', { type: 'edit-ready' });                 // some other window
  say(frameWin, 'https://evil.test', { type: 'edit-ready' });        // the right window, the wrong origin
  assert.equal(posted.length, 0);
  say(frameWin, 'https://x.test', { type: 'edit-ready' });
  assert.deepEqual(posted, [[{ type: 'edit-session', request }, 'https://x.test']]);
  say(frameWin, 'https://x.test', { type: 'edit-result', result: { sessionId: 'someone-else', ok: true } });   // another session's answer
  assert.equal(removed, false);
  say(frameWin, 'https://x.test', { type: 'edit-result', result: { v: 1, sessionId: 'abcdefgh', ok: true, verified: true } });
  assert.deepEqual(await pending, { v: 1, sessionId: 'abcdefgh', ok: true, verified: true });
  assert.equal(removed, true); assert.equal(listeners.length, 0);
});

// ---- F03 item edit in History's middle column ----
const deskEmbed = (over = {}) => {
  const calls = { embed: [], rect: [], command: [] }, subs = {};
  const d = { role: 'ledger', google: { getStatus: async () => ({ connected: true }) }, editCapabilities: { silentEdit: 1, embedEdit: 1 },
    editEmbed: req => { calls.embed.push(req); return new Promise(ok => { calls.finish = ok; }); },
    editRect: m => calls.rect.push(m), editCommand: m => calls.command.push(m),
    onEditState: cb => { subs.state = cb; return () => { subs.state = null; }; }, onEditClose: cb => { subs.close = cb; return () => { subs.close = null; }; }, ...over };
  return { d, calls, subs };
};
const EMBED_RECORD = { txnId: 'TX-Q', date: '2026-11-04', time: '9:00 AM', name: 'JO', company: '', phone: '', email: '', addr: '', total: 300, kind: 'quote', number: 'Q21001',
  deposit: 100, fromQuote: '', po: '', fingerprint: '["fp"]', items: [{ pn: 'A', desc: 'Saw', qty: '1', ea: 300, sub: 300, serials: [] }] };
test('app editEmbed: one embedded envelope with the RAW record (no deposit note), the card-fee hint and the fingerprint; History writes no Transactions', async () => {
  const { d, calls, subs } = deskEmbed();
  const sheet = fakeSheet({ payments: true });
  const env = K.environment({ mpeDesktop: d, navigator: { userAgent: 'Macintosh' } });
  const host = K.createHost({ ...env, get: sheet.get, append: async (range, rows) => { sheet.calls.ranges = (sheet.calls.ranges || []).concat(range); return sheet.append(range, rows); } }, {});
  const states = [], closes = [];
  const s = host.editEmbed(EMBED_RECORD, { cardFee: true }, { onState: m => states.push(m), onClose: m => closes.push(m) });
  await Promise.resolve();
  const req = calls.embed[0];
  assert.deepEqual([req.v, req.kind, req.mode, req.sessionId], [1, 'edit', 'embedded', s.sessionId]);
  assert.equal(req.patch, undefined, 'no patch in embedded mode');
  assert.equal(req.txn.cardFee, true); assert.equal(req.loaded.fingerprint, '["fp"]');
  assert.deepEqual(req.txn.items.map(i => i.pn), ['A'], 'raw record: no "Deposit paid" note (R11)');
  assert.deepEqual(req.txn, { ...K.toHistory(EMBED_RECORD), cardFee: true });
  { const two = deskEmbed(), h2 = K.createHost({ ...K.environment({ mpeDesktop: two.d, navigator: { userAgent: 'Macintosh' } }), get: sheet.get, append: sheet.append }, {});
    h2.editEmbed(EMBED_RECORD, { cardFee: true, storeCredit: 40 }, {}); await Promise.resolve();
    assert.equal(two.calls.embed[0].txn.storeCredit, 40, 'the receipt\'s store credit used goes to the register next to the card fee'); }
  assert.equal(K.toHistory({ ...EMBED_RECORD, storeCredit: 12.5 }).storeCredit, 12.5, 'a reopened sale carries it too');
  assert.equal('storeCredit' in K.toHistory(EMBED_RECORD), false, 'no credit: no key');
  // Reopen in a new sale tab: the card fee and store credit must survive saleRequest (the register has no local copy on another computer).
  { const req2 = K.saleRequest('edit', { ...EMBED_RECORD, cardFee: true, storeCredit: 12.5 });
    assert.equal(req2.txn.cardFee, true, 'saleRequest carries the card fee');
    assert.equal(req2.txn.storeCredit, 12.5, 'saleRequest keeps store credit');
    assert.equal('cardFee' in K.toHistory(EMBED_RECORD), false, 'no fee: no key'); }
  if (typeof ledgerEditRequest === 'function') assert.ok(ledgerEditRequest(req), 'main accepts the embedded shape');
  s.rect({ v: 1, sessionId: s.sessionId, seq: 1, rect: { x: 1, y: 2, width: 3, height: 4 } });
  s.command({ v: 1, sessionId: s.sessionId, cmd: 'cancel' });
  assert.deepEqual(calls.rect, [{ v: 1, sessionId: s.sessionId, seq: 1, rect: { x: 1, y: 2, width: 3, height: 4 } }]);
  assert.deepEqual(calls.command, [{ v: 1, sessionId: s.sessionId, cmd: 'cancel' }]);
  subs.state({ v: 1, sessionId: s.sessionId, seq: 1, ready: true });
  subs.close({ v: 1, sessionId: s.sessionId, cmd: 'cancel-request' });
  assert.equal(states.length, 1); assert.equal(closes.length, 1);
  calls.finish({ v: 1, sessionId: s.sessionId, ok: true, cancelled: true, unchanged: true });
  assert.deepEqual(await s.result, { v: 1, sessionId: s.sessionId, ok: true, cancelled: true, unchanged: true });
  assert.equal(subs.state, null, 'listeners are removed after the result'); assert.equal(subs.close, null);
  assert.ok(!(sheet.calls.ranges || []).some(r => /^Transactions/.test(r)), 'History never writes Transactions');
  const src = fs.readFileSync(path.join(__dirname, 'ledger-host.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'ledger.js'), 'utf8');
  assert.deepEqual(src.match(/(sheetsAppend|sheetsUpdate|append)\(\s*['`]Transactions[^'`]*/g), ['sheetsUpdate(`Transactions!O${at + 1}'], 'the only Transactions write is Change type\'s one checked cell');
});
test('app editEmbed: missing without the capability or a method; no fingerprint answers open_sale_screen without opening anything; a broken answer is "closed"', async () => {
  assert.equal(K.createHost(K.environment({ mpeDesktop: deskEmbed({ editCapabilities: { silentEdit: 1 } }).d, navigator: {} }), {}).editEmbed, undefined);
  assert.equal(K.createHost(K.environment({ mpeDesktop: deskEmbed({ editRect: undefined }).d, navigator: {} }), {}).editEmbed, undefined);
  const { d, calls } = deskEmbed();
  const host = K.createHost(K.environment({ mpeDesktop: d, navigator: {} }), {});
  const none = host.editEmbed({ ...EMBED_RECORD, fingerprint: '' }, {}, {});
  assert.equal((await none.result).code, 'open_sale_screen'); assert.equal(calls.embed.length, 0);
  const bad = host.editEmbed(EMBED_RECORD, {}, {});
  await Promise.resolve(); calls.finish(null);
  assert.equal((await bad.result).code, 'closed');
  const busy = host.editEmbed(EMBED_RECORD, {}, {});
  await Promise.resolve(); calls.finish({ v: 1, sessionId: busy.sessionId, ok: false, code: 'busy', message: 'Another edit is open.' });
  assert.equal((await busy.result).code, 'busy');
});

// A fake register window with one visible edit frame, for webEmbedSession.
function webEmbedFixture() {
  const listeners = { message: [], resize: [] }, hListeners = {}, posted = [];
  let removed = 0, appended = null, focused = 0;
  const frameWin = { postMessage: (message, origin) => posted.push([message, origin]) };
  const frame = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() { removed += 1; }, focus() { focused += 1; }, get contentWindow() { return frameWin; } };
  const p = { location: { origin: 'https://x.test', href: 'https://x.test/pos/index.html' },
    document: { createElement: () => frame, body: { append: f => { appended = f; } } },
    addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn), removeEventListener: (t, fn) => { const l = listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  const w = { frameElement: { getBoundingClientRect: () => ({ left: 0, top: 54 }) },
    addEventListener: (t, fn) => { hListeners[t] = fn; }, removeEventListener: (t, fn) => { if (hListeners[t] === fn) delete hListeners[t]; } };
  const say = (source, origin, data) => listeners.message.slice().forEach(fn => fn({ source, origin, data }));
  return { p, w, frame, frameWin, posted, listeners, hListeners, say, removed: () => removed, appended: () => appended, focused: () => focused };
}
const REQ = { v: 1, kind: 'edit', mode: 'embedded', sessionId: 'abcdefgh', txn: { txnId: 'T', docNumber: 'L21001' }, loaded: { fingerprint: 'x' } };
test('website embed: a visible same-origin frame (data-mpe-embed) at History frame + slot, re-placed on rect and resize; newest rect wins', () => {
  const f = webEmbedFixture(), states = [];
  const s = K.webEmbedSession(f.p, f.w, REQ, { onState: m => states.push(m) });
  assert.equal(f.appended(), f.frame);
  assert.equal(f.frame.attrs['data-mpe-embed'], '1');
  assert.equal(f.frame.src, 'https://x.test/pos/index.html?mpeEditSession=1&mpeEmbedded=1');
  assert.match(f.frame.style.cssText, /position:fixed/); assert.match(f.frame.style.cssText, /z-index:20/);
  assert.equal(f.frame.style.visibility, undefined, 'hidden until History says where (cssText)');
  s.rect({ v: 1, sessionId: 'abcdefgh', seq: 2, rect: { x: 400.4, y: 60, width: 700, height: 600.6 } });
  assert.deepEqual([f.frame.style.left, f.frame.style.top, f.frame.style.width, f.frame.style.height, f.frame.style.visibility], ['400px', '114px', '700px', '601px', 'visible']);
  s.rect({ v: 1, sessionId: 'abcdefgh', seq: 1, rect: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(f.frame.style.left, '400px', 'an older seq is dropped');
  f.w.frameElement.getBoundingClientRect = () => ({ left: 10, top: 60 });
  f.listeners.resize.forEach(fn => fn());
  assert.deepEqual([f.frame.style.left, f.frame.style.top], ['410px', '120px'], 'window resize re-places it');
  s.rect({ v: 1, sessionId: 'abcdefgh', seq: 3, hidden: true });
  assert.equal(f.frame.style.visibility, 'hidden');
});
test('website embed: messages checked by source, origin and session; focus after the first ready state; removed on the one result', async () => {
  const f = webEmbedFixture(), states = [];
  const s = K.webEmbedSession(f.p, f.w, REQ, { onState: m => states.push(m) });
  f.say({}, 'https://x.test', { type: 'edit-ready' });
  f.say(f.frameWin, 'https://evil.test', { type: 'edit-ready' });
  assert.equal(f.posted.length, 0);
  f.say(f.frameWin, 'https://x.test', { type: 'edit-ready' });
  assert.deepEqual(f.posted, [[{ type: 'edit-session', request: REQ }, 'https://x.test']]);
  f.say(f.frameWin, 'https://x.test', { type: 'edit-state', state: { v: 1, sessionId: 'other', seq: 1, ready: true } });
  f.say({}, 'https://x.test', { type: 'edit-state', state: { v: 1, sessionId: 'abcdefgh', seq: 1, ready: true } });
  assert.equal(states.length, 0); assert.equal(f.focused(), 0);
  f.say(f.frameWin, 'https://x.test', { type: 'edit-state', state: { v: 1, sessionId: 'abcdefgh', seq: 1, ready: true } });
  f.say(f.frameWin, 'https://x.test', { type: 'edit-state', state: { v: 1, sessionId: 'abcdefgh', seq: 2, ready: true } });
  assert.equal(states.length, 2); assert.equal(f.focused(), 1, 'focused once, after the first ready state');
  s.command({ v: 1, sessionId: 'abcdefgh', cmd: 'save', updateInfo: false });
  assert.deepEqual(f.posted[1], [{ type: 'edit-command', command: { v: 1, sessionId: 'abcdefgh', cmd: 'save', updateInfo: false } }, 'https://x.test']);
  f.say(f.frameWin, 'https://x.test', { type: 'edit-result', result: { sessionId: 'other', ok: true } });
  assert.equal(f.removed(), 0);
  f.say(f.frameWin, 'https://x.test', { type: 'edit-result', result: { v: 1, sessionId: 'abcdefgh', ok: true, verified: true } });
  assert.deepEqual(await s.result, { v: 1, sessionId: 'abcdefgh', ok: true, verified: true });
  assert.equal(f.removed(), 1);
  assert.deepEqual([f.listeners.message.length, f.listeners.resize.length, Object.keys(f.hListeners).length], [0, 0, 0], 'every listener is gone');
});
test('website embed: History going away (pagehide) removes the frame and answers closed (A4); 60 s to the first ready state, then no timeout', async () => {
  const f = webEmbedFixture();
  const s = K.webEmbedSession(f.p, f.w, REQ, {});
  f.hListeners.pagehide();
  assert.equal((await s.result).code, 'closed'); assert.equal(f.removed(), 1);
  assert.equal(K.EMBED_READY_MS, 60000);
  const realSet = global.setTimeout, realClear = global.clearTimeout, timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms, on: true }); return timers.length - 1; };
  global.clearTimeout = i => { if (timers[i]) timers[i].on = false; };
  try {
    const g = webEmbedFixture(), late = K.webEmbedSession(g.p, g.w, REQ, {});
    assert.equal(timers[0].ms, 60000);
    timers[0].fn();
    assert.equal((await late.result).code, 'timeout'); assert.equal(g.removed(), 1);
    const h = webEmbedFixture(), live = K.webEmbedSession(h.p, h.w, REQ, {});
    h.say(h.frameWin, 'https://x.test', { type: 'edit-state', state: { v: 1, sessionId: 'abcdefgh', seq: 1, ready: true } });
    assert.equal(timers[1].on, false, 'the timer stops once the sale screen is ready');
    h.say(h.frameWin, 'https://x.test', { type: 'edit-result', result: { v: 1, sessionId: 'abcdefgh', ok: true, cancelled: true } });
    assert.equal((await live.result).cancelled, true);
  } finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
});
test('website environment offers embedEdit through webEmbedSession', () => {
  const p = { sheetsGet() {}, googleSessionAvailable: () => true, localStorage: memoryStorage() };
  const env = K.environment({ parent: p, location: { origin: 'https://x.test' }, localStorage: memoryStorage(), navigator: {} });
  assert.equal(typeof env.embedEdit, 'function');
  assert.equal(typeof K.createHost(env, {}).editEmbed, 'function');
});

test('one Edit: the host says whether the save carries the customer (app 0.3.67 saveCustomer, website always); 0.3.66 says no', async () => {
  const old = K.createHost(K.environment({ mpeDesktop: deskEmbed().d, navigator: {} }), {}).editEmbed(EMBED_RECORD, {}, {});
  assert.equal(old.saveCustomer, false, 'app 0.3.66: History saves the customer after, through the silent session');
  const { d, calls } = deskEmbed({ editCapabilities: { silentEdit: 1, embedEdit: 1, saveCustomer: 1 } });
  const s = K.createHost(K.environment({ mpeDesktop: d, navigator: {} }), {}).editEmbed(EMBED_RECORD, {}, {});
  assert.equal(s.saveCustomer, true);
  s.command({ v: 1, sessionId: s.sessionId, cmd: 'save', updateInfo: true, customer: { phone: '808' } });
  assert.deepEqual(calls.command.pop(), { v: 1, sessionId: s.sessionId, cmd: 'save', updateInfo: true, customer: { phone: '808' } }, 'passed through as is; the preload and main check it');
  const p = { sheetsGet() {}, googleSessionAvailable: () => true, localStorage: memoryStorage() };
  const env = K.environment({ parent: p, location: { origin: 'https://x.test' }, localStorage: memoryStorage(), navigator: {} });
  const f = webEmbedFixture(), web = K.webEmbedSession(f.p, f.w, REQ, {});
  assert.equal(web.saveCustomer, true); assert.equal(typeof env.embedEdit, 'function');
  web.command({ v: 1, sessionId: 'abcdefgh', cmd: 'save', updateInfo: false, customer: { email: 'a@b.example' } });
  assert.deepEqual(f.posted.pop(), [{ type: 'edit-command', command: { v: 1, sessionId: 'abcdefgh', cmd: 'save', updateInfo: false, customer: { email: 'a@b.example' } } }, 'https://x.test'], 'the website frame gets the whole command');
});
test('T6a: the host says whether the save may carry customer.customerRef (app: editCapabilities.customerRef; website always)', () => {
  const old = K.createHost(K.environment({ mpeDesktop: deskEmbed({ editCapabilities: { silentEdit: 1, embedEdit: 1, saveCustomer: 1 } }).d, navigator: {} }), {}).editEmbed(EMBED_RECORD, {}, {});
  assert.equal(old.customerRef, false, 'an app without the flag');
  const { d, calls } = deskEmbed({ editCapabilities: { silentEdit: 1, embedEdit: 1, saveCustomer: 1, customerRef: 1 } });
  const s = K.createHost(K.environment({ mpeDesktop: d, navigator: {} }), {}).editEmbed(EMBED_RECORD, {}, {});
  assert.equal(s.customerRef, true);
  const cmd = { v: 1, sessionId: s.sessionId, cmd: 'save', updateInfo: true, customer: { name: 'Sue', customerRef: 'q:4417' } };
  s.command(cmd); assert.deepEqual(calls.command.pop(), cmd, 'passed through as is');
  const f = webEmbedFixture(), web = K.webEmbedSession(f.p, f.w, REQ, {});
  assert.equal(web.customerRef, true);
  assert.equal(K.createHost({ kind: 'web', embedEdit: () => web }, {}).editEmbed(EMBED_RECORD, {}, {}).customerRef, true, 'createHost passes the flag through');
});
test('one Edit (website): a scan History caught in its customer box goes to the edit frame as edit-scan, never after the end', async () => {
  const f = webEmbedFixture(), s = K.webEmbedSession(f.p, f.w, REQ, {});
  s.scan('0000131');
  assert.deepEqual(f.posted.pop(), [{ type: 'edit-scan', value: '0000131' }, 'https://x.test']);
  s.scan('x'.repeat(700)); assert.equal(f.posted.pop()[0].value.length, 512);
  f.hListeners.pagehide(); await s.result;
  s.scan('0000131'); assert.equal(f.posted.length, 0, 'the frame is gone');
  assert.equal(K.createHost({ kind: 'web', embedEdit: () => ({ result: new Promise(() => {}), rect() {}, command() {}, saveCustomer: true, scan: () => 'x' }) }, {}).editEmbed(EMBED_RECORD, {}, {}).scan(), 'x', 'createHost passes scan through');
});
test('an app that refuses Payments A:K: reads A:J, keeps working, and reports credit off', async () => {
  const sheet = fakeSheet({ payments: true });
  const get = range => { if (range === 'Payments!A:K') return Promise.reject(new Error('Google Sheet range is not allowed for Ledger')); return sheet.get(range); };
  const store = K.createPaymentsStore({ get, append: sheet.append, storage: memoryStorage() });
  assert.equal(store.wide(), true);
  await store.appendRows([pay('pay_old')]);
  assert.equal(store.wide(), false);
  assert.equal((await store.readAll()).filter(r => r[0] === 'pay_old').length, 1);
});

test('Review QR: the app host reads Settings!A:D, appends Settings!A1 and adds only the Settings tab through the preload; the website through the register', async () => {
  globalThis.MPEShopSettings = require('./shop-settings.js');
  try {
    const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
    const sheet = fakeSheet(), calls = [];
    const desktop = { role: 'ledger', google: {
      getStatus: async () => ({ connected: true }),
      sheetsGet: r => { calls.push(['get', r]); return sheet.get(r); },
      sheetsAppend: (r, rows) => { calls.push(['append', r]); return sheet.append(r, rows); },
      addSettingsTab: () => { calls.push(['addTab']); return sheet.batchUpdate([{ addSheet: { properties: { title: 'Settings' } } }]); },
    } };
    const store = mem(); store.setItem('mpeRegisterDigitV1', '2');
    const app = K.createHost(K.environment({ mpeDesktop: desktop, navigator: { userAgent: 'Windows' }, localStorage: store }), {});
    assert.equal(await app.shopSettings.refresh({ force: true }), 'ok');
    assert.equal(app.shopSettings.get('review_qr'), 'off', 'no tab = off');
    await app.shopSettings.set('review_qr', 'on');
    assert.deepEqual(sheet.tabs.Settings.map(r => r.slice(0, 2)), [['key', 'value'], ['review_qr', 'on']]);
    assert.equal(sheet.tabs.Settings[1][3], 'PC Left');
    assert.deepEqual([...new Set(calls.map(c => c.join(' ')))].sort(), ['addTab', 'append Settings!A1', 'get Settings!A:D']);
    // An app 0.3.70 refuses the range: old_app, the update text, nothing thrown at load.
    const old = K.createHost(K.environment({ mpeDesktop: { role: 'ledger', google: { getStatus: async () => ({ connected: true }),
      sheetsGet: async () => { throw new Error('Google Sheet range is not allowed for Ledger'); }, sheetsAppend: async () => { throw new Error('not allowed'); } } }, navigator: {}, localStorage: mem() }), {});
    assert.equal(await old.shopSettings.refresh({ force: true }), 'old_app');
    // Website: the register's own sheet calls; the tab is added with the exact addSheet through its batchUpdate.
    const web = fakeSheet(), parent = { sheetsGet: r => web.get(r), sheetsAppend: (r, rows) => web.append(r, rows), sheetsBatchUpdate: q => web.batchUpdate(q),
      googleSessionAvailable: () => true, localStorage: mem() };
    const site = K.createHost(K.environment({ parent, localStorage: mem() }), {});
    await site.shopSettings.set('review_qr', 'on');
    assert.deepEqual(web.calls.batch, [[{ addSheet: { properties: { title: 'Settings' } } }]]);
    assert.equal(web.tabs.Settings[1][3], 'browser');
  } finally { delete globalThis.MPEShopSettings; }
});

test('documentTools (the register\'s website Print, Save PDF and Email): fills the template once, one page per copy, and a template that will not load is an error the caller turns into the page layout', async () => {
  const TEMPLATE = fs.readFileSync(path.join(__dirname, 'document-template.html'), 'utf8');
  const renderer = require('../POSDesktop/src/document-renderer.js');
  let fetches = 0;
  const win = (status) => ({ MPEDocumentRenderer: renderer, XMLHttpRequest: function () {
    this.open = () => {}; this.send = () => { fetches += 1; setTimeout(() => { this.status = status; this.responseText = TEMPLATE; (status === 200 ? this.onload : this.onerror)(); }, 0); };
  } });
  const request = { type: 'receipt', number: 'R21050', completionAt: '2026-11-06T20:00:00.000Z', warranty: true, signature: true,
    customer: { name: 'KEONI', company: '', phone: '8085550142', email: '', address: '' },
    lines: [{ kind: 'item', part_number: 'MS 271', description: 'Saw', quantity: '1', serials: ['A1'], original_unit_amount: '100.00', discount_amount: '0.00', unit_amount: '100.00', line_total: '100.00' }],
    totals: { subtotal: '100.00', card_fee: '0.00', tax: '4.71', rounding: '0.00', total: '104.71' } };
  const tools = K.documentTools(win(200));
  const first = await tools.pages(request);
  await tools.pages(request);
  assert.equal(fetches, 1, 'the template is fetched once');
  assert.equal(first.length, 2);
  assert.match(first[0], /Customer copy/);
  assert.match(first[1], /Shop copy[\s\S]*Warranty Registration/);
  assert.match(first[1], /Received by:/);
  await assert.rejects(K.documentTools(win(500)).pages(request), /template/);
});
