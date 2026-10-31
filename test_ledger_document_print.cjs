'use strict';

// Invoices and quotes print through Desktop's Ledger template: the page hands over only finalized facts, and falls back to its
// own layout when Desktop says so or does not have the call. Run: node POS/test_ledger_document_print.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { factsFromRequest } = require('../POSDesktop/src/document-print');

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = page.indexOf('function ledgerDocumentRequest()');
const end = page.indexOf('function buildInvoiceSig()');
assert.ok(start > 0 && end > start);

const source = (type) => ({
  document: { type, due_date: type === 'invoice' ? '2026-11-26' : null },
  customer: { name: 'Keoni', company: 'Island LLC', phone: '808', email: '', billing_address: { lines: ['PO Box 1'], city: 'Kahului', region: 'HI', postal_code: '96732', country: '' } },
  lines: [
    { kind: 'item', line_id: 'L1', part_number: 'MS 271', description: 'Saw', quantity: '1', serials: ['A1'], original_unit_amount: '100.00', discount_amount: '0.00', unit_amount: '100.00', line_total: '100.00' },
    { kind: 'note', line_id: 'L2', part_number: '', description: 'Thanks', quantity: null, serials: [], original_unit_amount: null, discount_amount: null, unit_amount: null, line_total: null },
  ],
  totals: { currency: 'USD', subtotal: '100.00', card_fee: '0.00', tax: '4.71', rounding: '0.00', total: '104.71' },
});
const build = (docType, finalized, screen = {}) => {
  const sandbox = {
    _docType: docType, _ledgerOutputCoordinator: { current: () => finalized },
    tbody: { children: screen.rows || [] }, _ledgerLineIds: screen.ids || new WeakMap(),
    printMake: screen.make || (() => ''), document: { getElementById: (id) => (id === 'docPO' && screen.po !== undefined ? { value: screen.po } : null) },
    // The sale on screen (used when there is no Oldger finalization).
    captureOrder: () => screen.order || null, activeDocNumber: () => screen.number || null,
    ledgerBillingAddress: () => screen.billing || { lines: [], city: '', region: '', postal_code: '', country: '' },
    _currentTxnDate: screen.date || null, _pendingTxnDate: null, Intl, Date, Math, String, Number,
  };
  vm.runInContext(page.slice(page.indexOf('const TAX_RATE'), page.indexOf('let _ledgerOutputCoordinator')) + ';\n' + page.slice(page.indexOf('function checkoutTotals'), page.indexOf('let discountControlsEnabled')), vm.createContext(sandbox));
  vm.createContext(sandbox);
  vm.runInContext(page.slice(start, end), sandbox);
  return vm.runInContext('ledgerDocumentRequest()', sandbox);
};
const finalized = (type) => ({ source_facts: source(type), document_number: '2-0042', completion_at: '2026-10-27T01:30:00.000Z' });

test('an invoice and a quote become requests Desktop accepts; receipts and unfinalized sales stay on the page layout', () => {
  for (const type of ['invoice', 'quote']) {
    const request = build(type, finalized(type));
    assert.equal(request.type, type);
    assert.equal(request.number, '2-0042');
    const facts = factsFromRequest(JSON.parse(JSON.stringify(request)));
    assert.equal(facts.issued.document_date, '2026-10-26');
    assert.equal(facts.lines.length, 2);
  }
  assert.equal(build('receipt', finalized('receipt')), null);
  assert.equal(build('internal', finalized('invoice')), null);
  assert.equal(build('invoice', null), null, 'no sale on screen and no Oldger sale: nothing to print');
  assert.equal(build('invoice', finalized('quote')), null);
});

test('Auto Print offers Desktop the template first and keeps the page layout as the fallback', () => {
  const auto = page.slice(page.indexOf('async function autoPrint()'), page.indexOf("window.addEventListener('beforeprint'"));
  const document = auto.indexOf('mpeDesktop.printDocument(documentRequest)');
  const legacy = auto.indexOf('mpeDesktop.printReceipt(');
  assert.ok(document > 0 && legacy > document);
  assert.match(auto, /documentResult && !documentResult\.fallback/);
});

test('the PO number and each row\'s brand ride along as print-only extras; a quote carries no PO', () => {
  const row = { hasAttribute: () => false, dataset: { row: '0' } };
  const screen = { rows: [row], ids: new WeakMap([[row, 'L1']]), make: (i) => (i === '0' ? 'STIHL' : ''), po: ' PO-9 ' };
  const invoice = build('invoice', finalized('invoice'), screen);
  assert.equal(invoice.po, 'PO-9');
  assert.equal(invoice.lines[0].make, 'STIHL');
  const facts = factsFromRequest(JSON.parse(JSON.stringify(invoice)));
  assert.equal(facts.lines[0].make, 'STIHL');
  assert.equal(build('quote', finalized('quote'), screen).po, '');
  assert.equal(build('invoice', finalized('invoice')).lines[0].make, '');
  assert.equal('make' in factsFromRequest(JSON.parse(JSON.stringify(build('invoice', finalized('invoice'))))).lines[0], false);
});

test('without Oldger an invoice and a quote print from the sale screen with the new L/Q numbers and the screen totals', () => {
  const order = (cardFee) => ({
    customer: { name: 'KEONI', company: 'ISLAND LLC', phone: '808', email: '' },
    toggles: { cardFee },
    items: [
      { pn: 'MS 271', desc: 'Saw', make: 'STIHL', qty: 2, ea: 100, sub: 200, sn: ['A1'] },
      { pn: 'CHAIN', desc: 'Chain', qty: 1, ea: 18, sub: 18, originalEa: 20, discountPerUnit: 2 },
      { pn: 'Note', desc: 'Thanks', qty: 1, ea: 0, sub: 0 },
    ],
  });
  const screen = (number, cardFee = false) => ({ order: order(cardFee), number, date: '2026-10-31T01:30:00.000Z', po: ' PO-5 ',
    billing: { lines: ['PO Box 1'], city: 'Kahului', region: 'HI', postal_code: '96732', country: '' } });
  const invoice = build('invoice', null, screen('L21001'));
  assert.equal(invoice.number, 'L21001');
  assert.equal(invoice.po, 'PO-5');
  assert.equal(invoice.dueDate, '2026-11-29');
  assert.deepEqual(JSON.parse(JSON.stringify(invoice.totals)), { subtotal: '218.00', card_fee: '0.00', tax: '10.27', rounding: '0.00', total: '228.27' });
  assert.equal(invoice.lines[0].make, 'STIHL');
  assert.equal(invoice.lines[1].discount_amount, '2.00');
  assert.equal(invoice.lines[1].original_unit_amount, '20.00');
  assert.equal(invoice.lines[2].kind, 'note');
  const facts = factsFromRequest(JSON.parse(JSON.stringify(invoice)));
  assert.equal(facts.issued.document_number, 'L21001');
  assert.equal(facts.issued.document_date, '2026-10-30');
  assert.equal(facts.totals.total, '228.27');
  const quote = build('quote', null, screen('Q91002', true));
  assert.equal(quote.po, '');
  assert.equal(quote.dueDate, null);
  assert.equal(quote.totals.card_fee, '6.85');
  assert.equal(quote.totals.total, '235.12');
  assert.equal(factsFromRequest(JSON.parse(JSON.stringify(quote))).issued.document_number, 'Q91002');
  assert.equal(build('receipt', null, screen('R21003')), null);
  assert.equal(build('invoice', null, { ...screen('L21001'), billing: undefined }).customer.address, '');
});

test('a printed invoice stays an invoice while it is on screen; Quote and Internal still fall back to Receipt after a print', () => {
  const at = page.indexOf('function resetOneOffDocTypeAfterPrint()');
  assert.ok(at > 0, 'cleanupPrint resets the document type through resetOneOffDocTypeAfterPrint');
  assert.match(page.slice(page.indexOf('function cleanupPrint()'), page.indexOf('function ledgerMoneyText')), /resetOneOffDocTypeAfterPrint\(\);/);
  const after = (docType, state = {}) => {
    const sandbox = { _docType: docType, _ledgerOutputCoordinator: state.finalized ? { current: () => ({}) } : null,
      _currentTxnId: state.saved ? 'TX-1031-0900-00-1' : null, _reprintSource: state.reprint ? { txnId: 'TX-1' } : null };
    sandbox.setDocType = (type) => { sandbox._docType = type; };
    vm.createContext(sandbox);
    vm.runInContext(page.slice(at, page.indexOf('\n}\n', at) + 3) + '\nresetOneOffDocTypeAfterPrint();', sandbox);
    return sandbox._docType;
  };
  // Without Oldger a saved invoice has no finalization: Save or Print again must not rewrite it as a receipt.
  assert.equal(after('invoice', { saved: true }), 'invoice');
  assert.equal(after('invoice', { reprint: true }), 'invoice');
  assert.equal(after('invoice', { finalized: true }), 'invoice');
  assert.equal(after('quote', { saved: true }), 'receipt');
  assert.equal(after('internal', { saved: true }), 'receipt');
  assert.equal(after('receipt', { saved: true }), 'receipt');
});
