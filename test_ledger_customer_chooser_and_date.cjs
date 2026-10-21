'use strict';
// C3 chooser ("New customer") at the Finalize Invoice seam, with the page's own code in a stub world.
// The Sale date button is gone (Trevor, 2026-10-20): a late paper receipt goes in as today and its date is fixed in Ledger.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('const ledgerDesktopHas'), html.indexOf('let _saveFeedbackTimer'));

function world({ replies, advertised = { saleDate: true, customerChooser: true } }) {
  const sent = [], statuses = [], nodes = {};
  const el = (id, value = '') => (nodes[id] ||= { id, value, hidden: false, children: [],
    replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); }, setAttribute() {}, removeAttribute() {} });
  el('finalizeInvoiceBtn'); el('ledgerCustomerChooser'); el('custName', 'John');
  const sandbox = {
    document: { getElementById: id => nodes[id] || null, createElement: () => ({ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) },
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
    ['John', 'John', 'New customer']);
  assert.deepEqual(chooser.children.map(b => b.attrs['data-provider-id']), ['12', '345', undefined]);
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
  const w = world({ replies: [{ ok: false, error_code: 'customer_ambiguous', error_candidates: john }], advertised: {} });
  await w.sandbox.finalize();
  assert.deepEqual(Object.keys(w.sent[0]).sort(), ['billing_address', 'customer', 'provider_id']);
  assert.equal(w.nodes.ledgerCustomerChooser.children.length, 0);
  assert.match(w.statuses.at(-1), /Pick the right one in Ledger/);
});

test('no sale date is sent, even to a Desktop that accepts one (Desktop then uses today)', async () => {
  const w = world({ replies: [resolved] });
  await w.sandbox.finalize();
  assert.deepEqual(Object.keys(w.sent[0]).sort(), ['billing_address', 'customer', 'provider_id']);
});

test('customer_name_reused offers only New customer, with the typed name in the sentence', async () => {
  const w = world({ replies: [{ ok: false, error_code: 'customer_name_reused' }] });
  await w.sandbox.finalize();
  assert.deepEqual(w.nodes.ledgerCustomerChooser.children.map(b => b.textContent), ['New customer']);
  assert.equal(w.nodes.ledgerCustomerChooser.hidden, false);
  assert.equal(w.statuses.at(-1), 'A different customer named John was already made on this register. Choose New customer to make a separate one, or retype the phone and address to match.');
});

test('the Sale date button and its code are gone from the page', () => {
  assert.doesNotMatch(html, /saleDate|sale-date|shownDocDate|sale_date_/);
});
