'use strict';
// Ledger tab in the browser register. Run: node POS/test_ledger_tab.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LedgerTab = require('./ledger-tab');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Just enough DOM for the tab row: elements with children, classes, dataset, hidden.
class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.innerHTML = '';
    this.offsetHeight = 54; this.contentWindow = tag === 'iframe' ? { frame: true } : undefined;
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  }
  set className(v) { for (const c of v.split(' ')) this.classList.add(c); }
  append(child) { this.children.push(child); }
  prepend(child) { this.children.unshift(child); }
}
function fixture() {
  const listeners = {};
  const window = { location: { origin: 'https://maupau808.github.io' }, addEventListener: (t, f) => { listeners[t] = f; } };
  const document = { createElement: (tag) => new El(tag) };
  const tabs = new El('div'); tabs.append(new El('button'));   // Sale 1 already there
  const host = new El('section'); host.clientHeight = 768;
  const opened = [];
  let shows = 0;
  const api = LedgerTab.install({ document, window, tabs, header: new El('header'), host,
    onShow: () => { shows += 1; }, onOpenSale: (sale) => opened.push(sale) });
  return { api, tabs, host, opened, listeners, window, shows: () => shows };
}

test('Ledger is the first tab, labelled, with no close button and no count', () => {
  const { api, tabs } = fixture();
  assert.equal(tabs.children[0], api.button);
  assert.match(api.button.innerHTML, /<svg[\s\S]*<span>History<\/span>$/);
  assert.equal(api.button.innerHTML.split('</svg>')[1], '<span>History</span>', 'no count, no ×');
  assert.equal(api.button.dataset.cvTab, undefined, 'not a sale: close and switch code skip it');
});

test('opening shows ledger.html over the sale area and keeps the same frame loaded', () => {
  const { api, host, shows } = fixture();
  assert.equal(host.children.length, 0, 'not loaded until opened');
  api.button.onclick();
  const frame = host.children[0];
  assert.equal(frame.src, 'ledger.html');
  assert.equal(frame.style.top, '54px');
  assert.equal(frame.style.height, '714px', 'fills the sale area (an iframe ignores top+bottom)');
  assert.equal(api.isShown(), true);
  assert.equal(api.button.classList.contains('active'), true);
  assert.equal(shows(), 1, 'sale tabs are told to look inactive');
  api.hide();
  assert.equal(frame.hidden, true);
  assert.equal(api.button.classList.contains('active'), false);
  api.show();
  assert.equal(host.children.length, 1, 'same frame: search, selection and scroll survive');
  assert.equal(frame.hidden, false);
});

test('only the Ledger frame, from this origin, with a valid shape, opens a sale', () => {
  const { api, host, opened, listeners } = fixture();
  const send = (e) => listeners.message(e);
  send({ source: {}, origin: 'https://maupau808.github.io', data: { kind: 'edit', txn: { txnId: 'T1' } } });
  assert.equal(opened.length, 0, 'before the frame exists nothing is heard');
  api.show();
  const source = host.children[0].contentWindow;
  send({ source: {}, origin: 'https://maupau808.github.io', data: { kind: 'edit', txn: { txnId: 'T1' } } });
  send({ source, origin: 'https://evil.example', data: { kind: 'edit', txn: { txnId: 'T1' } } });
  send({ source, origin: 'https://maupau808.github.io', data: { kind: 'delete', txn: { txnId: 'T1' } } });
  send({ source, origin: 'https://maupau808.github.io', data: { kind: 'edit', txn: {} } });
  assert.equal(opened.length, 0);
  send({ source, origin: 'https://maupau808.github.io', data: { kind: 'quote-to-sale', txn: { txnId: 'TX-Q', items: [{ pn: 'A' }] }, extra: 1 } });
  assert.deepEqual(opened, [{ kind: 'quote-to-sale', txn: { txnId: 'TX-Q', items: [{ pn: 'A' }] } }]);
});

test('message shape: four kinds, plain bounded txn, txnId except for a new invoice', () => {
  assert.deepEqual(LedgerTab.KINDS, ['quote-to-sale', 'copy-sale', 'new-invoice', 'edit']);
  assert.deepEqual(LedgerTab.saleMessage({ kind: 'new-invoice', txn: { customer: ['A'] } }), { kind: 'new-invoice', txn: { customer: ['A'] } });
  for (const bad of [null, [], 'edit', { kind: 'edit', txn: null }, { kind: 'copy-sale', txn: [] },
    { kind: 'copy-sale', txn: { txnId: '' } }, { kind: 'edit', txn: { txnId: 'T', x: 'y'.repeat(200001) } }]) {
    assert.equal(LedgerTab.saleMessage(bad), null);
  }
});

test('register: History button gone, Ledger loads in the tab row, sale tabs unchanged', () => {
  assert.doesNotMatch(html, /id="txnHistoryBtn"/);
  assert.doesNotMatch(html, /q\('#txnHistoryBtn'\)/, 'counter view no longer looks it up');
  assert.match(html, /<script src="ledger-tab\.js"><\/script>/);
  // The browser row adds Sale 1 first, then Ledger is prepended; the app keeps its native strip.
  assert.match(html, /if\(window\.mpeDesktop\)\{q\('#cvTabs'\)\.hidden=true;q\('#cvNew'\)\.hidden=true;window\.mpeDesktop\.onLedgerSale\?\.\(openLedgerSale\);\}else\{nextTab=1;addTab\(\);q\('#cvNew'\)\.onclick=addTab;ledgerTab=window\.MPELedgerTab\?\.install\(/);
  assert.match(html, /function activateTab\(id\)\{ledgerTab\?\.hide\(\);commitFocused\(\);/, 'any sale tab returns to that sale');
  assert.match(html, /const ids=qa\('#cvTabs \.cv-tab\[data-cv-tab\]'\)/, 'closing a sale never picks Ledger');
  assert.match(html, /if\(hasContent&&!confirm\('Close Sale '\+id/, 'sale tabs still warn before closing');
  assert.match(html, /onOpenSale:sale=>\{addTab\(\);openLedgerSale\(sale\);\}/, 'a NEW tab first, then the fill');
});

test('register: the fill runs only on an empty tab and edit keeps the record identity', () => {
  const start = html.indexOf('function openLedgerSale(');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assert.match(body, /if \(!ledgerDraftTabIsEmpty\(\)\) throw/);
  assert.match(body, /kind === 'edit'\) \{ fillTxnIntoPOS\(txn\);/, 'Load into POS path: same txnId and number');
  assert.match(body, /kind === 'quote-to-sale'\) fillTxnIntoPOS\(txn, 'receipt'\);/);
  assert.doesNotMatch(body, /clearAll\(/, 'never clears a sale');
});
