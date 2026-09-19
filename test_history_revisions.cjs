const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(process.env.POS_HISTORY_PAGE || __dirname + '/index.html', 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
function setup() {
  const storage = new Map();
  let sheet = [], batches = 0, connected = false, corruptRead = false, failWrite = false;
  const s = {
    console: {log() {}, warn() {}}, _docType: 'quote', _reprintSource: null,
    _currentTxnId: null, _currentTxnDate: null, _pendingTxnDate: null,
    _lastPrintedOrder: null, _lastPushStatus: null, _ledgerOutputCoordinator: null,
    HISTORY_KEY: 'history', HISTORY_MAX: 1000, PUSHED_TXNIDS_KEY: 'pushed',
    SHEETS_ID: 'test', TXN_SHEET: 'Transactions', DOC_TITLES: {quote:'Quote',receipt:'Receipt',invoice:'Invoice'},
    _txns: null, _txnsLoadedAt: 0, _txnShown: [],
    captureOrder: () => clone(s.draft), maybeSaveNewCustomer() {}, updatePrintBanner() {},
    updatePriceChangesBadge() {}, _idbPut: async () => {},
    googleSessionAvailable: () => connected,
    sheetText: value => value == null || value === '' ? '' : "'" + String(value),
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value)},
    getHistory: () => JSON.parse(storage.get('history') || '[]'),
    countUnpushedTxns: () => s.getHistory().filter(o=>!vm.runInContext('getPushedTxnIds()',s).has(o.txnId)).length,
    formatDocNumber: d => String(Math.floor(d.getTime()/60000)),
    docDateOrNull: () => s._reprintSource ? new Date(s._reprintSource.date)
      : s._currentTxnDate ? new Date(s._currentTxnDate) : s._pendingTxnDate,
    getSheetNumericId: async () => 7,
    sheetsGet: async range => {
      if(range === 'Transactions') return clone(sheet);
      const match=range.match(/A(\d+):P(\d+)/);assert.ok(match,range);
      const result=clone(sheet.slice(Number(match[1])-1, Number(match[2])));
      if(corruptRead && result[1]) result[1][10]='999';
      return result;
    },
    sheetsAppend: async (range,rows) => {if(failWrite)throw Error('offline');const at=sheet.length;sheet.push(...entered(rows));return {updates:{updatedRange:`Transactions!A${at+1}:P${sheet.length}`}};},
    sheetsUpdate: async (range,rows) => {if(failWrite)throw Error('offline');const at=Number(range.match(/A(\d+)/)[1])-1;sheet.splice(at,rows.length,...entered(rows));},
    sheetsBatchUpdate: async requests => {
      if(failWrite) throw Error('offline');batches++;
      for(const req of requests){
        if(req.insertDimension){const r=req.insertDimension.range;sheet.splice(r.startIndex,0,...Array.from({length:r.endIndex-r.startIndex},()=>[]));}
        else if(req.deleteDimension){const r=req.deleteDimension.range;sheet.splice(r.startIndex,r.endIndex-r.startIndex);}
        else if(req.updateCells){const u=req.updateCells;assert.equal(u.fields,'userEnteredValue');const rows=u.rows.map(row=>row.values.map(c=>c.userEnteredValue.numberValue??c.userEnteredValue.stringValue));sheet.splice(u.range.startRowIndex,rows.length,...rows);}
        else throw Error('Unexpected request');
      }
    },
  };
  const entered = rows=>rows.map(row=>row.map(v=>typeof v==='string'?v.replace(/^'/,''):v));
  s.draft={customer:{company:'TEST LANDFILL'},items:[{pn:'0000131',desc:'FS 131',qty:1,ea:529.99,sub:529.99}],total:'554.96',toggles:{cardFee:false}};
  vm.createContext(s);
  const start=html.indexOf('// A document keeps its identity;');
  vm.runInContext(html.slice(start,html.indexOf('function showPrintBanner()',start)),s);
  const pushed=html.indexOf('function getPushedTxnIds()');
  vm.runInContext(html.slice(pushed,html.indexOf('function upperText',pushed)),s);
  const sync=html.indexOf('const AUTO_TXN_PUSH_LIMIT');
  vm.runInContext(html.slice(sync,html.indexOf('// ─── TRANSACTION HISTORY LOOKUP',sync)),s);
  const reserve=html.indexOf('function reserveDocDate()');
  vm.runInContext(html.slice(reserve,html.indexOf('function updateScreenDocTitle()',reserve)),s);
  return {s,storage,save(){vm.runInContext('reserveDocDate()',s);return vm.runInContext('saveToHistory()',s);},
    sync:()=>vm.runInContext('pushTransactionToSheet(getHistory()[0])',s),
    flush:()=>vm.runInContext('flushUnpushedTxns()',s),
    sheet:()=>clone(sheet),setSheet:rows=>{sheet=clone(rows);},batches:()=>batches,
    connect:()=>{connected=true;},corrupt:value=>{corruptRead=value;},fail:value=>{failWrite=value;}};
}
test('second FS 131 updates one quote with same number, date and transaction ID locally and in Drive',async()=>{
 const c=setup();assert.equal(c.save(),true);await c.sync();const original=c.s.getHistory()[0];
 c.s.draft.items[0].qty=2;c.s.draft.items[0].sub=1059.98;c.s.draft.total='1109.93';
 assert.equal(c.save(),true);assert.equal(c.s.getHistory().length,1);
 const changed=c.s.getHistory()[0];for(const key of ['txnId','date','docNumber'])assert.equal(changed[key],original[key]);
 await c.sync();assert.equal(c.sheet().filter(r=>r[0]==='TXN').length,1);
 assert.equal(c.sheet()[1][10],2);assert.equal(c.sheet()[1][8],'0000131');
 assert.equal(c.s.getHistory()[0].historySyncPending,false);
 const writes=c.batches();c.save();await c.sync();assert.equal(c.batches(),writes);
});
test('adding then removing lines resizes the existing block and preserves neighboring transactions',async()=>{
 const c=setup();c.save();await c.sync();
 const neighbor=[['TXN','OTHER','1/1/2020','10:00 AM','Other'],['item','OTHER','','','','','','','NEIGHBOR','Keep',1,'$1.00','$1.00']];
 c.setSheet([...c.sheet(),...neighbor]);
 c.s.draft.items.push({pn:'B',desc:'Added',qty:1,ea:10,sub:10});c.save();await c.sync();
 assert.equal(c.sheet().length,5);assert.deepEqual(c.sheet().slice(-2),neighbor);
 c.s.draft.items.pop();c.save();await c.sync();assert.equal(c.sheet().length,4);assert.deepEqual(c.sheet().slice(-2),neighbor);
});
test('offline edit remains pending despite an old pushed ID, then sign-in updates existing Drive contents',async()=>{
 const c=setup();c.save();await c.sync();c.s.draft.items[0].qty=2;c.save();
 assert.equal(c.s.countUnpushedTxns(),1);assert.equal(c.s.getHistory()[0].historySyncPending,true);
 c.connect();await c.flush();assert.equal(c.sheet()[1][10],2);assert.equal(c.s.countUnpushedTxns(),0);
});
test('failed write and mismatched read-back never acknowledge the edit; retry updates once',async()=>{
 const c=setup();c.save();await c.sync();c.s.draft.items[0].sn=['SERIAL-2'];c.save();
 c.fail(true);await assert.rejects(c.sync(),/offline/);assert.equal(c.s.countUnpushedTxns(),1);
 c.fail(false);c.corrupt(true);await assert.rejects(c.sync(),/could not be verified/);assert.equal(c.s.countUnpushedTxns(),1);
 c.corrupt(false);await c.sync();assert.equal(c.s.countUnpushedTxns(),0);assert.equal(c.sheet().length,2);
});
test('rapid saves and overlapping pushes finish with latest contents and one transaction',async()=>{
 const c=setup();c.save();const first=c.sync();c.s.draft.items[0].qty=2;c.save();const second=c.sync();
 c.s.draft.items[0].qty=3;c.save();const third=c.sync();await Promise.all([first,second,third]);
 assert.equal(c.sheet().length,2);assert.equal(Number(c.sheet()[1][10]),3);assert.equal(c.s.getHistory()[0].items[0].qty,3);
});
test('old in-flight acknowledgement cannot clear a newer pending edit',async()=>{
 const c=setup();c.save();const old=c.s.getHistory()[0];c.s.draft.items[0].qty=2;c.save();
 c.s.oldSnapshot=old;vm.runInContext('acknowledgeTransactionSnapshot(oldSnapshot)',c.s);
 assert.equal(c.s.getHistory()[0].historySyncPending,true);
});
test('loaded Drive quote is updated under its original identity even when absent from local history',async()=>{
 const c=setup();c.save();await c.sync();const original=c.s.getHistory()[0];c.storage.set('history','[]');
 c.s._currentTxnId=null;c.s._currentTxnDate=null;c.s._reprintSource={txnId:original.txnId,date:original.date,docNumber:original.docNumber};
 vm.runInContext('_historyContentBaseline = historyContentFingerprint(captureOrder())',c.s);
 c.s.draft.items[0].qty=2;c.save();await c.sync();assert.equal(c.s.getHistory().length,1);assert.equal(c.sheet().length,2);
 assert.equal(c.s.getHistory()[0].txnId,original.txnId);assert.equal(c.sheet()[1][10],2);
});
for(const [name,edit] of Object.entries({serial:d=>d.items[0].sn=['NEW'],description:d=>d.items[0].desc='Fixed',customer:d=>d.customer.company='Corrected',price:d=>d.items[0].ea=499,discount:d=>d.items[0].discountPerUnit=1}))test(`${name} changes replace the local record`,()=>{
 const c=setup();c.save();const id=c.s.getHistory()[0].txnId;edit(c.s.draft);c.save();assert.equal(c.s.getHistory().length,1);assert.equal(c.s.getHistory()[0].txnId,id);
});
test('money formatting and presentation toggles do not schedule another Drive write',async()=>{
 const c=setup();c.save();await c.sync();c.s.draft.total='$554.96';c.s.draft.toggles.warranty=true;c.save();
 assert.equal(c.s.getHistory()[0].historySyncPending,false);assert.equal(c.s.getHistory().length,1);
});
test('failed local persistence leaves existing quote and identity intact for retry',()=>{
 const c=setup();c.save();const original=c.s.getHistory()[0];const set=c.s.localStorage.setItem;
 c.s.draft.items[0].qty=2;c.s.localStorage.setItem=()=>{throw Error('quota');};assert.equal(c.save(),false);
 assert.deepEqual(c.s.getHistory()[0],original);assert.equal(c.s._currentTxnId,original.txnId);
 c.s.localStorage.setItem=set;assert.equal(c.save(),true);assert.equal(c.s.getHistory().length,1);
});
test('stale legacy history during sign-in does not overwrite corrected Drive quote',async()=>{
 const c=setup();c.save();await c.sync();const sheet=c.sheet();sheet[1][10]=2;c.setSheet(sheet);
 c.storage.set('pushed','[]');c.connect();await c.flush();assert.equal(c.sheet()[1][10],2);assert.equal(c.batches(),0);
});
test('all application scripts parse',()=>{for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);});
test('history view replaces cached original with pending edited contents, without a second entry',async()=>{
 const c=setup();c.save();await c.sync();const cached=c.sheet();c.s.draft.items[0].qty=2;c.save();
 const elements={txnSearch:{value:''},txnList:{innerHTML:''}};
 Object.assign(c.s,{document:{getElementById:id=>elements[id]},_setTxnStatus(){},_txnRowHtml:t=>String(t.items[0].qty)});
 const p=html.indexOf('function _parseTxnRows(');vm.runInContext(html.slice(p,html.indexOf('function _setTxnStatus',p)),c.s);
 const r=html.indexOf('function renderTxnResults()');vm.runInContext(html.slice(r,html.indexOf('function _txnRowHtml',r)),c.s);
 c.s.cached=cached;vm.runInContext('_txns = _parseTxnRows(cached); renderTxnResults()',c.s);
 assert.equal(c.s._txnShown.length,1);assert.equal(Number(c.s._txnShown[0].items[0].qty),2);
});
test('a reload preserves the offline edit and replays it under the same transaction ID',async()=>{
 const c=setup();c.save();await c.sync();c.s.draft.items[0].qty=2;c.save();
 const reloaded=setup();for(const [key,value]of c.storage)reloaded.storage.set(key,value);
 reloaded.setSheet(c.sheet());reloaded.connect();await reloaded.flush();
 assert.equal(reloaded.sheet().length,2);assert.equal(reloaded.sheet()[1][10],2);assert.equal(reloaded.s.countUnpushedTxns(),0);
});
test('Auto repeat protection checks document contents so an immediate correction is allowed',()=>{
 const source=html.slice(html.indexOf('async function autoPrint()'),html.indexOf('async function autoPrint()')+1000);
 assert.match(source,/historyContentFingerprint\(captureOrder\(\)\) === _lastDirectPrintFingerprint/);
});
