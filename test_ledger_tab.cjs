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
function fixture(extra = {}) {
  const listeners = {};
  const window = { location: { origin: 'https://maupau808.github.io' }, addEventListener: (t, f) => { listeners[t] = f; } };
  const document = { createElement: (tag) => new El(tag) };
  const tabs = new El('div'); tabs.append(new El('button'));   // Sale 1 already there
  const host = new El('section'); host.clientHeight = 768;
  const opened = [];
  let shows = 0;
  const api = LedgerTab.install({ document, window, tabs, header: new El('header'), host,
    onShow: () => { shows += 1; }, onOpenSale: (sale) => opened.push(sale), ...extra });
  return { api, tabs, host, opened, listeners, window, shows: () => shows };
}

test('Ledger is the first tab of the row it is given, labelled, with no close button and no count', () => {
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
  // An app shell with mpeDesktop.tabs lets the page draw the row (K5, Trevor 2026-11-13); an older shell or an edit page hides it.
  assert.match(html, /if\(window\.mpeDesktop\)\{if\(MPE_EDIT_SESSION_PAGE\|\|!desktopTabRow\(\)\)\{q\('#cvTabs'\)\.hidden=true;q\('#cvNew'\)\.hidden=true;q\('#cvFixedTabs'\)\.hidden=true;\}window\.mpeDesktop\.onLedgerSale\?\.\(openLedgerSale\);window\.mpeDesktop\.onEditSession\?\.\(runEditSessionAndReport\);\}else\{if\(MPE_EDIT_SESSION_PAGE\)\{.*?\}nextTab=1;addTab\(\);q\('#cvNew'\)\.onclick=addTab;ledgerTab=MPE_EDIT_SESSION_PAGE\?null:window\.MPELedgerTab\?\.install\(\{document,window,tabs:q\('#cvFixedTabs'\),/);
  assert.match(html, /fx\.prepend\(pt\);if\(ledgerTab\)fx\.append\(ledgerTab\.button\);/, 'History is the last tab of the fixed group, after Parts');
  assert.match(html, /id="cvFixedTabs"/, 'fixed group sits in the header');
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
  assert.match(body, /kind === 'quote-to-sale'\) fillTxnIntoPOS\(txn, 'invoice'\);/);
  assert.doesNotMatch(body, /clearAll\(/, 'never clears a sale');
});

test('register: Presold is captured, shown and restored for every document type except internal', () => {
  assert.match(html, /presell: \(_docType !== 'internal' && document\.getElementById\('presellChk'\)\?\.checked\) \|\| undefined/, 'captureOrder');
  assert.match(fs.readFileSync(path.join(__dirname, 'ledger-data.js'), 'utf8'), /\['quote', 'receipt', 'invoice'\]\.includes\(savedDocType\) && order\.presell \? 'PRESELL' : ''/, 'column W of the TXN row (the one writer lives in ledger-data.js)');
  assert.match(html, /presellChk\.checked = t\.docType !== 'internal' && !!t\.presell;/, 'fillTxnIntoPOS reopens it checked');
  assert.match(html, /presellWrap\.hidden = t === 'internal';/, 'checkbox visible on quote, receipt and invoice');
  assert.match(html, /id="presellChk"> Presold<\/label>/);
});

test('A1: while History has an item edit open, a key History is not using goes to the edit frame (edit-key), the frame is focused, and no sale tab is shown', () => {
  let keydown = null, frame = null, scans = 0, shown = 0, focused = 0;
  const posted = [];
  const win = { addEventListener: (type, fn) => { if (type === 'keydown') keydown = fn; }, document: { activeElement: null }, Event: class {} };
  LedgerTab.forwardScans(win, (e) => { scans += 1; e.defaultPrevented = true; }, () => { shown += 1; }, () => frame, 'https://x.test');
  const key = (k, o = {}) => ({ key: k, code: 'Key' + k, defaultPrevented: false, target: { tagName: 'BODY' }, preventDefault() { this.defaultPrevented = true; }, ...o });
  keydown(key('1')); keydown(key('Enter'));
  assert.equal(scans, 2, 'no edit: every key passes the register scanner test');
  assert.equal(shown, 1, 'a proven scan shows the sale tab');
  frame = { focus: () => { focused += 1; }, contentWindow: { postMessage: (m, o) => posted.push([m, o]) } };
  const first = key('2', { shiftKey: true });
  keydown(first); keydown(key('Enter'));
  assert.equal(scans, 2, 'edit open: the History copy of the scanner test is skipped');
  assert.equal(shown, 1, 'edit open: activateTab is never called');
  assert.equal(focused, 2, 'the edit frame gets the focus');
  assert.equal(first.defaultPrevented, true, 'History does not also act on it');
  assert.deepEqual(posted, [
    [{ type: 'edit-key', key: '2', code: 'Key2', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }, 'https://x.test'],
    [{ type: 'edit-key', key: 'Enter', code: 'KeyEnter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, 'https://x.test'],
  ], 'the first key of a burst is not lost; target origin is the register origin');
  posted.length = 0;
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) keydown(key('x', { target: { tagName } }));
  keydown(key('w', { metaKey: true })); keydown(key('w', { ctrlKey: true })); keydown(key('a', { altKey: true }));
  keydown(key('z', { target: { tagName: 'DIV', isContentEditable: true } }));
  assert.deepEqual(posted, [], 'typing in a field, a button key and shortcuts stay in History');
  assert.equal(scans, 2); assert.equal(shown, 1);
});

test('one Edit: typing in History\'s customer fields during an edit stays there and never moves focus to the edit frame; a checkbox or button key still does', () => {
  let keydown = null, focused = 0;
  const posted = [], win = { addEventListener: (type, fn) => { if (type === 'keydown') keydown = fn; }, document: { activeElement: null }, Event: class {} };
  const frame = { focus: () => { focused += 1; }, contentWindow: { postMessage: (m, o) => posted.push([m, o]) } };
  LedgerTab.forwardScans(win, () => { throw new Error('no register scanner test while an edit is open'); }, () => {}, () => frame, 'https://x.test');
  const key = (k, target) => ({ key: k, code: 'Key' + k, defaultPrevented: false, target, preventDefault() { this.defaultPrevented = true; } });
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    const e = key('S', target); keydown(e);
    assert.equal(e.defaultPrevented, false, 'the letter is typed in the box');
  }
  assert.equal(focused, 0, 'the caret stays in the customer box'); assert.deepEqual(posted, []);
  keydown(key(' ', { tagName: 'INPUT', type: 'checkbox' })); keydown(key('x', { tagName: 'BUTTON' }));
  assert.equal(focused, 2, 'a key on the info box or a button lets the edit take the burst'); assert.deepEqual(posted, []);
});

test('A1: install looks for the edit frame in the register document (iframe[data-mpe-embed]) and posts with the register origin', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ledger-tab.js'), 'utf8');
  assert.match(src, /forwardScans\(frame\.contentWindow, scanKeydown, onScan, \(\) => document\.querySelector\('iframe\[data-mpe-embed\]'\), window\.location\.origin\)/);
});

test('A1: the edit-key listener is created in the register window, so the frame sees event.source === its window.parent', () => {
  // postMessage stamps event.source with the window whose code calls it (the incumbent). forwardScans is loaded by index.html
  // (this script) and only attaches its listener to History's window, so the poster is the register window = the frame's parent.
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /<script src="ledger-tab\.js"><\/script>/, 'ledger-tab.js runs in the register document');
  const ledger = fs.readFileSync(path.join(__dirname, 'ledger.html'), 'utf8');
  assert.doesNotMatch(ledger, /ledger-tab\.js/, 'History never loads it, so the poster is never History');
});

test('showing History again tells the page once a minute at most (a hidden frame never fires visibilitychange)', () => {
  let clock = 1000000;
  const { api, host } = fixture({ now: () => clock });
  const events = [];
  class FakeEvent { constructor(type) { this.type = type; } }
  const toldFrame = () => { const w = host.children[0].contentWindow; w.Event = FakeEvent; w.dispatchEvent = e => events.push(e.type); };
  api.show();
  toldFrame();
  api.hide(); clock += 5000; api.show();
  assert.deepEqual(events, [], 'the page just loaded: nothing to refresh');
  api.hide(); clock += 60000; api.show();
  assert.deepEqual(events, ['mpe-ledger-host']);
  api.hide(); clock += 10000; api.show();
  api.hide(); clock += 49000; api.show();
  assert.deepEqual(events, ['mpe-ledger-host'], 'not again within 60 s');
  api.hide(); clock += 2000; api.show();
  assert.deepEqual(events, ['mpe-ledger-host', 'mpe-ledger-host']);
  api.show();
  assert.equal(events.length, 2, 'clicking the tab it is already on does nothing more');
});

test('a frame that cannot take the event never breaks showing History', () => {
  let clock = 0;
  const { api, host } = fixture({ now: () => clock });
  api.show(); api.hide(); clock += 120000;
  assert.doesNotThrow(() => api.show());
  assert.equal(host.children[0].hidden, false);
});
