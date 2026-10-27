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
    { kind: 'item', part_number: 'MS 271', description: 'Saw', quantity: '1', serials: ['A1'], original_unit_amount: '100.00', discount_amount: '0.00', unit_amount: '100.00', line_total: '100.00' },
    { kind: 'note', part_number: '', description: 'Thanks', quantity: null, serials: [], original_unit_amount: null, discount_amount: null, unit_amount: null, line_total: null },
  ],
  totals: { currency: 'USD', subtotal: '100.00', card_fee: '0.00', tax: '4.71', rounding: '0.00', total: '104.71' },
});
const build = (docType, finalized) => {
  const sandbox = { _docType: docType, _ledgerOutputCoordinator: { current: () => finalized } };
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
  assert.equal(build('invoice', null), null);
  assert.equal(build('invoice', finalized('quote')), null);
});

test('Auto Print offers Desktop the template first and keeps the page layout as the fallback', () => {
  const auto = page.slice(page.indexOf('async function autoPrint()'), page.indexOf("window.addEventListener('beforeprint'"));
  const document = auto.indexOf('mpeDesktop.printDocument(documentRequest)');
  const legacy = auto.indexOf('mpeDesktop.printReceipt(');
  assert.ok(document > 0 && legacy > document);
  assert.match(auto, /documentResult && !documentResult\.fallback/);
});
