'use strict';
// C3 chooser ("New customer") and C6 sale date at the Finalize Invoice seam, with the page's own code in a stub world.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('const LEDGER_SALE_DATE_MAX_DAYS_BACK'), html.indexOf('let _saveFeedbackTimer'));

const hst = offsetDays => new Date(Date.now() - 10 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);   // Hawaii day, relative to now
const TODAY = hst(0), THREE_DAYS_AGO = hst(3);
function world({ replies, saleDate = TODAY, advertised = { saleDate: true, customerChooser: true } }) {
  const sent = [], statuses = [], nodes = {};
  const el = (id, value = '') => (nodes[id] ||= { id, value, hidden: false, children: [],
    replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); }, setAttribute() {}, removeAttribute() {} });
  el('saleDate', saleDate); el('finalizeInvoiceBtn'); el('ledgerCustomerChooser'); el('custName', 'John');
  const sandbox = {
    document: { getElementById: id => nodes[id] || null, createElement: () => ({ style: {} }) },
    window: { mpeDesktop: { numbering: { invoiceFinalization: true, ...advertised, resolveCustomer: async r => { sent.push(r); return replies.shift(); } } } },
    _docType: 'invoice', _ledgerInvoiceFinalizing: false, _reprintSource: null, _currentTxnId: null, _ledgerAdoptedCustomer: null,
    _ledgerStructuredAddress: false, _ledgerOutputCoordinator: { current: () => null },
    captureOrder: () => true, lockLedgerOutputUi() {}, releaseLedgerOutputUi() {}, ledgerBillingAddress: () => ({}),
    setLedgerInvoiceStatus: m => statuses.push(m), updateScreenDocTitle() {}, freezeLedgerInvoiceControls() {},
    refreshLedgerInvoiceStatus: async () => {}, prepareAndSaveForPrint: async () => ({ mode: 'c06' }),
    ledgerRefusalError: c => Object.assign(new Error(c), { code: c }), ledgerErrorCode: e => e.code,
  };
  vm.runInNewContext(code + ';this.finalize = finalizeLedgerInvoice; this.show = showLedgerCustomerChooser;', sandbox);
  return { sandbox, sent, statuses, nodes };
}
const john = [{ provider_id: '12', display_name: 'John' }, { provider_id: '345', display_name: 'John' }];
const ambiguous = { ok: false, error_code: 'customer_ambiguous', error_candidates: john };
const resolved = { ok: true, result: { customer_id: 'c', identity_kind: 'native', adoption_proof: null } };

test('several matches show each candidate plus New customer; each choice is one more request', async () => {
  const w = world({ replies: [ambiguous, resolved, ambiguous, resolved, ambiguous, { ...resolved }] });
  await w.sandbox.finalize();
  const chooser = w.nodes.ledgerCustomerChooser;
  assert.equal(chooser.hidden, false);
  assert.deepEqual(chooser.children.map(b => b.textContent),
    ['John (QuickBooks #12)', 'John (QuickBooks #345)', 'New customer']);
  assert.match(w.statuses.at(-1), /Pick the right one below/);
  await chooser.children[1].onclick();           // second John
  assert.equal(w.sent[1].provider_id, '345');
  assert.equal('new_customer' in w.sent[1], false);
  assert.equal(chooser.hidden, true);
  await w.sandbox.finalize();                      // ambiguous again
  w.sandbox._ledgerInvoiceFinalizing = false;
  await w.nodes.ledgerCustomerChooser.children[2].onclick();   // New customer
  assert.equal(w.sent.at(-1).new_customer, true);
  assert.equal(w.sent.at(-1).provider_id, null);
});

test('ambiguity without a candidate list still offers New customer, with a sentence that does not say pick below', async () => {
  const w = world({ replies: [{ ok: false, error_code: 'customer_ambiguous' }] });
  await w.sandbox.finalize();
  assert.deepEqual(w.nodes.ledgerCustomerChooser.children.map(b => b.textContent), ['New customer']);
  assert.equal(w.nodes.ledgerCustomerChooser.hidden, false);
  assert.doesNotMatch(w.statuses.at(-1), /below/);
});

test('a Desktop that does not advertise support is sent exactly the old request and gets the old message', async () => {
  const w = world({ replies: [{ ok: false, error_code: 'customer_ambiguous', error_candidates: john }], advertised: {}, saleDate: THREE_DAYS_AGO });
  await w.sandbox.finalize();
  assert.deepEqual(Object.keys(w.sent[0]).sort(), ['billing_address', 'customer', 'provider_id']);
  assert.equal(w.nodes.ledgerCustomerChooser.children.length, 0);
  assert.match(w.statuses.at(-1), /Pick the right one in Ledger/);
});

test('the sale date rides the customer request; blank is null (trusted clock); no new_customer by default', async () => {
  const w = world({ replies: [resolved, resolved], saleDate: THREE_DAYS_AGO });
  await w.sandbox.finalize();
  assert.equal(w.sent[0].sale_date, THREE_DAYS_AGO);
  assert.equal('new_customer' in w.sent[0], false);
  const blank = world({ replies: [resolved], saleDate: '' });
  await blank.sandbox.finalize();
  assert.equal(blank.sent[0].sale_date, null);
});

test('a future, too old, or impossible date stops before Ledger is asked', async () => {
  const bounds = vm.runInNewContext(code + ';ledgerSaleDateBounds(Date.parse("2026-10-16T20:00:00Z"))', {});
  assert.deepEqual({ ...bounds }, { min: '2026-07-18', max: '2026-10-16' });
  const problem = vm.runInNewContext(code + ';ledgerSaleDateProblem', {});
  assert.equal(problem('2026-10-16', bounds), '');
  assert.equal(problem('2026-07-18', bounds), '');
  assert.equal(problem('2026-07-17', bounds), 'sale_date_out_of_range');
  assert.equal(problem('2026-10-17', bounds), 'sale_date_out_of_range');
  assert.equal(problem('', bounds), '');
  assert.equal(problem('2026-02-30', bounds), 'sale_date_invalid');
  assert.equal(problem('2026-13-01', bounds), 'sale_date_invalid');
  assert.equal(problem('10/01/2026', bounds), 'sale_date_invalid');
  for (const saleDate of ['2999-01-01', '2000-01-01', '2026-02-30']) {
    const w = world({ replies: [resolved], saleDate });
    await w.sandbox.finalize();
    assert.equal(w.sent.length, 0);
    assert.match(w.statuses.at(-1), /sale date/i);
  }
});

test('receipts: a past day replaces the date at the real time of day; today, blank or a saved document keep the real clock', () => {
  const state = { row: { hidden: false }, input: { value: '' }, current: null, saved: null };
  const sandbox = { document: { getElementById: id => id === 'saleDateRow' ? state.row : state.input },
    get _ledgerOutputCoordinator() { return { current: () => state.current }; }, _reprintSource: null,
    get _currentTxnDate() { return state.saved; } };
  vm.runInNewContext(code + ';this.shown = shownDocDate; this.bounds = ledgerSaleDateBounds;', sandbox);
  const real = new Date();
  const { max } = sandbox.bounds();
  const earlier = new Date(Date.now() - 3 * 86400000 - 10 * 3600000).toISOString().slice(0, 10);   // 3 Hawaii days back
  state.input.value = earlier;
  const shown = sandbox.shown(real);
  assert.equal(shown.getFullYear() * 10000 + (shown.getMonth() + 1) * 100 + shown.getDate(), Number(earlier.replaceAll('-', '')));
  assert.deepEqual([shown.getHours(), shown.getMinutes(), shown.getSeconds()], [real.getHours(), real.getMinutes(), real.getSeconds()]);
  for (const keep of [() => { state.input.value = ''; }, () => { state.input.value = max; }, () => { state.input.value = '2000-01-01'; },
    () => { state.input.value = earlier; state.saved = '2026-01-01T00:00:00.000Z'; }, () => { state.saved = null; state.row.hidden = true; }]) {
    keep();
    assert.equal(sandbox.shown(real), real);
  }
  state.row.hidden = false; state.current = { document_number: '1' };
  assert.equal(sandbox.shown(real), real);   // a Ledger-finalized invoice takes completion_at instead
});
