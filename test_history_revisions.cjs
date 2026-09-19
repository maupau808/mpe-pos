const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(process.env.POS_HISTORY_PAGE || __dirname + '/index.html', 'utf8');
function setup() {
  const storage = new Map();
  const sent = new Map();
  const s = {
    _docType: 'quote', _reprintSource: null, _currentTxnId: null, _currentTxnDate: null,
    _pendingTxnDate: null, _lastPrintedOrder: null, _lastPushStatus: null,
    _ledgerOutputCoordinator: null, HISTORY_KEY: 'history', HISTORY_MAX: 1000,
    captureOrder: () => JSON.parse(JSON.stringify(s.draft)),
    maybeSaveNewCustomer() {}, updatePrintBanner() {},
    googleSessionAvailable: () => true,
    pushTransactionToSheet: async order => {
      if (!sent.has(order.txnId)) sent.set(order.txnId, JSON.parse(JSON.stringify(order)));
    },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => { storage.set(key, value); },
    },
    getHistory: () => JSON.parse(storage.get('history') || '[]'),
    formatDocNumber: d => String(Math.floor(d.getTime() / 60000)),
    docDateOrNull: () => s._reprintSource ? new Date(s._reprintSource.date)
      : s._currentTxnDate ? new Date(s._currentTxnDate) : s._pendingTxnDate,
    activeDocNumber: () => s.formatDocNumber(s.docDateOrNull() || new Date()),
  };
  s.draft = {customer: {company: 'TEST LANDFILL'}, items: [
    {pn: 'UNIT-A', desc: 'Unit A', qty: 1, ea: 100, sub: 100},
  ], total: '100.00', toggles: {cardFee: false}};
  vm.createContext(s);
  const start = html.indexOf('// Only identical document contents');
  vm.runInContext(html.slice(start, html.indexOf('function showPrintBanner()', start)), s);
  const reserve = html.indexOf('function reserveDocDate()');
  vm.runInContext(html.slice(reserve, html.indexOf('function updateScreenDocTitle()', reserve)), s);
  return {s, storage, sent, save() {
    vm.runInContext('reserveDocDate()', s);
    return vm.runInContext('saveToHistory()', s);
  }};
}
test('missing unit added after first output persists as latest version locally and in Drive queue', () => {
  const {s, sent, save} = setup();
  assert.equal(save(), true);
  const original = s.getHistory()[0];
  assert.equal(save(), true);
  assert.equal(s.getHistory().length, 1);
  s.draft.items.push({pn: 'UNIT-B', desc: 'Unit B', qty: 1, ea: 75, sub: 75});
  s.draft.total = '175.00';
  assert.equal(save(), true);
  const revised = s.getHistory()[0];
  assert.notEqual(revised.txnId, original.txnId);
  assert.equal(revised.items.length, 2);
  assert.equal(s.getHistory()[1].items.length, 1);
  assert.equal(sent.get(revised.txnId).items.length, 2);
  assert.equal(save(), true);
  assert.equal(s.getHistory().length, 2);
  assert.equal(sent.size, 2);
});
for (const [name, edit] of Object.entries({
  quantity: d => { d.items[0].qty = 2; },
  serial: d => { d.items[0].sn = ['NEW-SERIAL']; },
  description: d => { d.items[0].desc = 'Corrected'; },
  customer: d => { d.customer.company = 'OTHER CUSTOMER'; },
  price: d => { d.items[0].ea = 99; },
  discount: d => { d.items[0].discountPerUnit = 1; },
})) test(`${name} edits cannot be mistaken for a duplicate even with unchanged total`, () => {
  const {s, save} = setup(); save(); edit(s.draft); save();
  assert.equal(s.getHistory().length, 2);
});
test('loaded history retains identity across repeated output; an edit gets a new identity', () => {
  const {s, save} = setup(); save();
  const original = s.getHistory()[0];
  s._currentTxnId = null; s._currentTxnDate = null;
  s._reprintSource = {txnId: original.txnId, date: original.date};
  vm.runInContext('_historyContentBaseline = historyContentFingerprint(captureOrder())', s);
  save(); save();
  assert.equal(s.getHistory().length, 1);
  s.draft.items[0].qty = 2;
  save(); save();
  assert.equal(s.getHistory().length, 2);
  assert.equal(s.getHistory()[0].items[0].qty, 2);
});
test('print money formatting and presentation toggles do not create revisions', () => {
  const {s, save} = setup(); save();
  s.draft.total = '$100.00'; s.draft.toggles.warranty = true;
  save(); assert.equal(s.getHistory().length, 1);
});
test('failed local persistence is reported and remains retryable', () => {
  const {s, save} = setup();
  const setItem = s.localStorage.setItem;
  s.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(save(), false);
  assert.equal(s._currentTxnId, null);
  s.localStorage.setItem = setItem;
  assert.equal(save(), true);
  assert.equal(s.getHistory().length, 1);
});
test('both local and Drive history loaders establish comparison after restoring rows', () => {
  for (const name of ['loadTxnIntoPOS', 'reprintOrder']) {
    const start = html.indexOf(`function ${name}(`);
    const end = html.indexOf('\n}\n', start);
    const body = html.slice(start, end);
    assert.ok(body.indexOf('_historyContentBaseline = historyContentFingerprint(captureOrder())')
      > body.lastIndexOf('updateSummary()'));
  }
});
test('Drive cleanup preserves revised lines and separate transactions, removing only exact duplicate blocks', async () => {
  const header = ['TXN', 'TX-ORIGINAL', '9/18/2026', '10:00', 'TEST', '', '', '', '', '', '', '', '100.00'];
  const item = ['item', 'TX-ORIGINAL', '', '', '', '', '', '', 'UNIT-A', 'Unit A', '1', '100', '100'];
  const edited = [...item]; edited[10] = '2';
  const otherHeader = [...header]; otherHeader[1] = 'TX-OTHER';
  const otherItem = [...item]; otherItem[1] = 'TX-OTHER';
  const rows = [header, item, header, edited, otherHeader, otherItem, header, item];
  let requests = [];
  const s = {
    document: {getElementById: () => ({textContent: 'Clean'})}, TXN_SHEET: 'Transactions',
    googleSessionAvailable: () => true, sheetsGet: async () => rows,
    getSheetNumericId: async () => 7, alert() {}, confirm: () => true,
    sheetsBatchUpdate: async value => { requests = value; },
  };
  vm.createContext(s);
  const start = html.indexOf('async function cleanTransactionDuplicates()');
  vm.runInContext(html.slice(start, html.indexOf('async function sheetsAppend(', start)), s);
  await vm.runInContext('cleanTransactionDuplicates()', s);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].deleteDimension.range.startIndex, 6);
  assert.equal(requests[0].deleteDimension.range.endIndex, 8);
});
test('all inline application scripts parse', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
});
