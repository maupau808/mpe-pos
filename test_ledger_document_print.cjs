'use strict';

// Invoices and quotes print through Desktop's Ledger template: the page hands over the sale on screen, and falls back to its
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

const build = (docType, screen = {}) => {
  const sandbox = {
    _docType: docType,
    document: { getElementById: (id) => (id === 'docPO' && screen.po !== undefined ? { value: screen.po }
      : id === 'docReceivedBy' && screen.receivedBy !== undefined ? { value: screen.receivedBy }
      : id === 'signatureBtn' && screen.signature ? { classList: { contains: (c) => c === 'active' } } : null) },
    tbody: { querySelectorAll: () => (screen.serialTyped ? [{ value: ' ' }, { value: 'SN123' }] : [{ value: '' }]) },   // the typed serial boxes
    regCreditApplied: () => screen.creditCents || 0, window: { MPELedgerData: require('./ledger-data.js') },
    captureOrder: () => screen.order || null, activeDocNumber: () => screen.number || null,
    ledgerBillingAddress: () => screen.billing || { lines: [], city: '', region: '', postal_code: '', country: '' },
    _currentTxnDate: screen.date || null, _pendingTxnDate: null, Intl, Date, Math, String, Number,
    shopReviewOn: () => !!screen.review, // the shop-wide Review QR switch (a local cache read in the page)
  };
  vm.createContext(sandbox);
  vm.runInContext(page.slice(page.indexOf('const TAX_RATE'), page.indexOf('const CARD_FEE_RATE') + 30) + ';\n' + page.slice(page.indexOf('function checkoutTotals'), page.indexOf('let discountControlsEnabled')), sandbox);
  vm.runInContext(page.slice(start, end), sandbox);
  return vm.runInContext('ledgerDocumentRequest()', sandbox);
};

test('Auto Print offers Desktop the template first and keeps the page layout as the fallback', () => {
  const auto = page.slice(page.indexOf('async function autoPrint()'), page.indexOf("window.addEventListener('beforeprint'"));
  const document = auto.indexOf('mpeDesktop.printDocument(documentRequest)');
  const legacy = auto.indexOf('mpeDesktop.printReceipt(');
  assert.ok(document > 0 && legacy > document);
  assert.match(auto, /documentResult && !documentResult\.fallback/);
});

test('an invoice and a quote print from the sale screen with the new L/Q numbers and the screen totals', () => {
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
  const invoice = build('invoice', screen('L21001'));
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
  const quote = build('quote', screen('Q91002', true));
  assert.equal(quote.po, '');
  assert.equal(quote.dueDate, null);
  assert.equal(quote.totals.card_fee, '6.85');
  assert.equal(quote.totals.total, '235.12');
  assert.equal(factsFromRequest(JSON.parse(JSON.stringify(quote))).issued.document_number, 'Q91002');
  assert.equal(build('receipt', screen('R21003')).type, 'receipt');
  assert.equal(build('internal', screen('L21001')), null);
  assert.equal(build('invoice', {}), null, 'no sale on screen: nothing to print');
  assert.equal(build('invoice', { ...screen('L21001'), billing: undefined }).customer.address, '');
});

test('a printed invoice stays an invoice while it is on screen; Quote and Internal still fall back to Receipt after a print', () => {
  const at = page.indexOf('function resetOneOffDocTypeAfterPrint()');
  assert.ok(at > 0, 'cleanupPrint resets the document type through resetOneOffDocTypeAfterPrint');
  assert.match(page.slice(page.indexOf('function cleanupPrint()'), page.indexOf('function readTenderSelection')), /resetOneOffDocTypeAfterPrint\(\);/);
  const after = (docType, state = {}) => {
    const sandbox = { _docType: docType,
      _currentTxnId: state.saved ? 'TX-1031-0900-00-1' : null, _reprintSource: state.reprint ? { txnId: 'TX-1' } : null };
    sandbox.setDocType = (type) => { sandbox._docType = type; };
    vm.createContext(sandbox);
    vm.runInContext(page.slice(at, page.indexOf('\n}\n', at) + 3) + '\nresetOneOffDocTypeAfterPrint();', sandbox);
    return sandbox._docType;
  };
  // A saved invoice keeps its number: Save or Print again must not rewrite it as a receipt.
  assert.equal(after('invoice', { saved: true }), 'invoice');
  assert.equal(after('invoice', { reprint: true }), 'invoice');
  assert.equal(after('quote', { saved: true }), 'receipt');
  assert.equal(after('internal', { saved: true }), 'receipt');
  assert.equal(after('receipt', { saved: true }), 'receipt');
});

test('Review QR: the invoice request carries review only when the shop switch is on; quotes never', () => {
  const order = { customer: { name: 'TEST', company: '', phone: '', email: '' }, toggles: { cardFee: false },
    items: [{ pn: 'TST1', desc: 'Test part', qty: 1, ea: 10, sub: 10, sn: [] }] };
  const screen = { order, number: 'L21001', date: '2026-11-05T20:00:00.000Z' };
  assert.equal(build('invoice', { ...screen, review: true }).review, true);
  assert.equal('review' in build('invoice', screen), false);
  assert.equal('review' in build('quote', { ...screen, number: 'Q21001', review: true }), false);
  assert.equal(build('receipt', { ...screen, number: 'R21001', review: true }).review, true, 'receipts carry it too (customer copy)');
  assert.equal('review' in build('receipt', { ...screen, number: 'R21001' }), false);
});

// Register receipts print with the shared template (History's layout), not the old POS page.
const receiptScreen = (extra = {}) => ({ number: 'R21050', date: '2026-11-06T20:00:00.000Z',
  order: { customer: { name: 'KEONI', company: '', phone: '8085550142', email: '' }, toggles: { cardFee: false },
    items: [{ pn: 'MS 271', desc: 'Saw', qty: 1, ea: 100, sub: 100, sn: ['A1'] }] },
  billing: { lines: ['PO Box 1'], city: 'Kahului', region: 'HI', postal_code: '96732', country: '' }, ...extra });

test('a receipt gets a request (Internal never): warranty only when a serial was typed, signature only when the toggle is on', () => {
  const plain = build('receipt', receiptScreen());
  assert.equal(plain.type, 'receipt');
  assert.equal('warranty' in plain, false);
  assert.equal('signature' in plain, false);
  assert.equal(build('receipt', receiptScreen({ serialTyped: true })).warranty, true);
  assert.equal(build('receipt', receiptScreen({ signature: true })).signature, true);
  assert.equal(build('quote', receiptScreen({ number: 'Q21050', signature: true })).signature, true);
  assert.equal('signature' in build('invoice', receiptScreen({ number: 'L21050', signature: true })), false, 'an invoice has its own signature box');
  assert.equal('warranty' in build('invoice', receiptScreen({ number: 'L21050', serialTyped: true })), false);
  assert.equal(build('internal', receiptScreen({ serialTyped: true, signature: true })), null);
  assert.equal(build('receipt', { ...receiptScreen(), order: null }), null);
});

test('store credit on a receipt: History\'s note line, a card fee only on what the card pays, totals unchanged', () => {
  const none = build('receipt', receiptScreen());
  const used = build('receipt', receiptScreen({ creditCents: 3000 }));
  const note = used.lines[used.lines.length - 1];
  assert.equal(note.kind, 'note');
  assert.equal(note.description, 'Store credit \u2212$30.00. Amount paid $74.71.');
  assert.equal(used.lines.length, none.lines.length + 1);
  assert.equal(used.totals.total, '104.71');
  const history = require('./ledger.js').withDeposit({ kind: 'receipt', creditUsed: 30, total: 104.71, items: [] });
  assert.equal(history.items[0].desc, note.description, 'the register and History say the same words');
  const withFee = build('receipt', receiptScreen({ creditCents: 3000, order: { ...receiptScreen().order, toggles: { cardFee: true } } }));
  assert.equal(withFee.totals.card_fee, '2.24');   // 3% of (100 + 4.71 - 30)
  assert.equal(build('quote', receiptScreen({ number: 'Q21050', creditCents: 3000 })).lines.length, none.lines.length, 'credit is a receipt thing');
  assert.deepEqual(factsFromRequest(JSON.parse(JSON.stringify(used))).totals.total, '104.71');
});

test('the Print button, Manual print, Save PDF and Email try the template first and keep the page layout as the fallback', () => {
  const auto = page.slice(page.indexOf('async function autoPrint()'), page.indexOf("window.addEventListener('beforeprint'"));
  assert.match(auto, /!window\.mpeDesktop\) \{[\s\S]*printDocumentInBrowser\(ledgerDocumentRequest\(\)\)/, 'website Print');
  assert.ok(auto.indexOf('printDocumentInBrowser') < auto.indexOf('Preserve the existing unconfigured/legacy till behavior'));
  assert.match(auto, /fetch\(POS_PRINT_URL/, 'the localhost helper stays');
  const manual = page.slice(page.indexOf('async function manualPrint()'), page.indexOf('const AUTO_PRINT_REPEAT_GUARD_MS'));
  assert.match(manual, /!window\.mpeDesktop && await printDocumentInBrowser\(ledgerDocumentRequest\(\)\)/);
  assert.match(manual, /window\.print\(\)/);
  assert.match(page, /const templatePdf = await templatePdfBlob\(ledgerDocumentRequest\(\)\)/);
  assert.match(page, /const templatePage = \(await documentPagesFor\(ledgerDocumentRequest\(\)\)\)\?\.\[0\] \|\| null/);
  // Quick print: nothing the Desktop Print button runs waits on the network for the template.
  const tools = page.slice(page.indexOf('let _docTools = null;'), page.indexOf('let _printMoneySnapshot'));
  assert.match(tools, /if \(!window\.mpeDesktop\) setTimeout\(/, 'the website fetches the template shortly after load, not at Print');
  assert.doesNotMatch(auto.slice(0, auto.indexOf('mpeDesktop.printDocument')), /documentPagesFor|templatePdfBlob|readTemplate/);
});

test('the shared printed heading uses the saved Hawaii time, including register and History copies', () => {
  const L = require('./ledger-data.js');
  const P = require('./ledger.js');
  const R = require('./document-renderer.js');
  const template = R.parseTemplate(fs.readFileSync(path.join(__dirname,'document-template.html'),'utf8'));
  const order = {customer:{name:'TEST CUSTOMER'},toggles:{},items:[{pn:'TEST',desc:'Test part',qty:1,ea:10,sub:10,sn:[]}]};
  const request = build('invoice',{order,number:'L21001',date:'2026-11-13T05:03:00Z'});
  const desktop = factsFromRequest(request), website = L.factsFromRequest(request);
  assert.equal(desktop.issued.document_date,'2026-11-12');
  assert.equal(desktop.issued.document_time,'7:03 PM');
  assert.deepEqual(JSON.parse(JSON.stringify(website)),JSON.parse(JSON.stringify(desktop)));
  for(const type of ['invoice','receipt','quote']) {
    const rec={kind:type,date:'2026-11-12',time:'19:03:00',number:'L21001',name:'TEST CUSTOMER',items:[{pn:'TEST',desc:'Test part',qty:1,ea:10,sub:10,serials:[],off:0}],total:10.47};
    const q=P.requestFromRecord(rec);
    const pages=L.documentPages(q,R,template,R.DEFAULT_SETTINGS);
    assert(pages.length>0);
    for(const page of pages) assert.match(page.html || page, /class="date">November 12, 2026 · 7:03 PM<\/span>/);
    assert.equal(factsFromRequest(q).issued.document_time,'7:03 PM');
    rec.time='';const noTime=P.requestFromRecord(rec);
    assert.equal(factsFromRequest(noTime).issued.document_time,'');
    for(const page of L.documentPages(noTime,R,template,R.DEFAULT_SETTINGS)) assert.doesNotMatch(page.html || page,/12:00 PM/);
  }
});

// Received by (K5, Trevor 2026-11-13): the name typed on the sale screen prints on the Print line above the signature, on the
// invoice's merchant copy and on a receipt or quote with Signature. An older cached template (no '.received' pieces) prints the blank line.
test('Received by fills the signature Print line on the app and the website; an older template still prints', () => {
  const L = require('./ledger-data.js');
  const R = require('./document-renderer.js');
  const { extrasFromRequest } = require('../POSDesktop/src/document-print');
  const text = fs.readFileSync(path.join(__dirname, 'document-template.html'), 'utf8');
  const template = R.parseTemplate(text);
  const order = { customer: { name: 'TEST CUSTOMER' }, toggles: {}, items: [{ pn: 'TEST', desc: 'Test part', qty: 1, ea: 10, sub: 10, sn: [] }] };
  const named = (type, extra = {}) => ({ ...build(type, { order, number: type === 'invoice' ? 'L21001' : 'R21001', date: '2026-11-13T05:03:00Z' }), received_by: 'KEONI <K>', ...extra });
  const line = /Print: <span class="sig-underline">KEONI &lt;K&gt;<\/span>/;
  const invoice = L.documentPages(named('invoice'), R, template, R.DEFAULT_SETTINGS);
  assert.doesNotMatch(invoice[0], line, 'customer copy has no signature box');
  assert.match(invoice[1], line, 'merchant copy prints the name');
  assert.match(L.documentPages(named('receipt', { signature: true }), R, template, R.DEFAULT_SETTINGS)[0], line);
  assert.doesNotMatch(L.documentPages(named('receipt'), R, template, R.DEFAULT_SETTINGS)[0], /Print:/, 'no Signature toggle: no box');
  assert.deepEqual(extrasFromRequest(named('invoice')).received_by, 'KEONI <K>', 'the app passes it to the renderer');
  assert.equal(extrasFromRequest({ type: 'invoice' }).received_by, undefined);
  assert.equal(build('receipt', { order, number: 'R21001', receivedBy: ' keoni ' }).received_by, 'KEONI', 'the register sends the typed name, uppercase');
  assert.equal('received_by' in build('receipt', { order, number: 'R21001', receivedBy: '  ' }), false, 'blank: not sent');
  const old = R.parseTemplate(text.replace(/<template data-name="counter\.sig?n?\.received">[\s\S]*?<\/template>\n/g, ''));
  assert.equal(old.has('counter.sig.received') || old.has('counter.sign.received'), false);
  assert.match(L.documentPages(named('invoice'), R, old, R.DEFAULT_SETTINGS)[1], /Print: <span class="sig-underline"><\/span>/);
  // An older renderer fills the unchanged pieces: they carry no new slot.
  assert.doesNotMatch(template.get('counter.sig') + template.get('counter.sign'), /\{\{received\}\}/);
});
