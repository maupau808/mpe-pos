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
    _pendingDocNumber: null, _currentDocNumber: null,
    _lastPrintedOrder: null, _lastPushStatus: null, _ledgerOutputCoordinator: null,
    MPELedgerNumbering: require('./ledger-numbering'), window: {MPELedgerData: require('./ledger-data')}, sheetsGet: async () => [],
    HISTORY_KEY: 'history', HISTORY_MAX: 1000, PUSHED_TXNIDS_KEY: 'pushed',
    SHEETS_ID: 'test', TXN_SHEET: 'Transactions', DOC_TITLES: {quote:'Quote',receipt:'Receipt',invoice:'Invoice'},
    _txns: null, _txnsLoadedAt: 0, _txnShown: [], _txnRefreshWarning: '', _txnRefreshPromise: null,
    captureOrder: () => clone(s.draft), maybeSaveCustomer() {}, flashScanCommand() {}, updatePrintBanner() {},
    updatePriceChangesBadge() {}, _idbPut: async () => {},
    googleSessionAvailable: () => connected,
    sheetText: value => value == null || value === '' ? '' : "'" + String(value),
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value)},
    getHistory: () => JSON.parse(storage.get('history') || '[]'),
    countUnpushedTxns: () => s.getHistory().filter(o=>!vm.runInContext('getPushedTxnIds()',s).has(o.txnId)).length,
    DOC_EPOCH: Date.UTC(2025, 0, 1),
    docDateOrNull: () => s._reprintSource ? new Date(s._reprintSource.date)
      : s._currentTxnDate ? new Date(s._currentTxnDate) : s._pendingTxnDate,
    getSheetNumericId: async () => 7,
    sheetsGet: async range => {
      if(range === 'Transactions') return clone(sheet);
      const match=range.match(/A(\d+):[BPVWX](\d+)/);assert.ok(match,range);
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
        else throw Error('Google Sheets batch operation is not allowed');   // exactly what MPE POS Desktop refuses
      }
    },
  };
  const entered = rows=>rows.map(row=>row.map(v=>typeof v==='string'?v.replace(/^'/,''):v));
  s.draft={customer:{company:'TEST LANDFILL'},items:[{pn:'0000131',desc:'FS 131',qty:1,ea:529.99,sub:529.99}],total:'554.96',toggles:{cardFee:false}};
  s.shownDocDate = d => d;   // the sale-date picker is not part of these history tests
  vm.createContext(s);
  const start=html.indexOf('// A document keeps its identity;');
  vm.runInContext(html.slice(start,html.indexOf('function showPrintBanner()',start)),s);
  const pushed=html.indexOf('function getPushedTxnIds()');
  vm.runInContext(html.slice(pushed,html.indexOf('function upperText',pushed)),s);
  const sync=html.indexOf('const AUTO_TXN_PUSH_LIMIT');
  vm.runInContext(html.slice(sync,html.indexOf('// ─── TRANSACTION HISTORY LOOKUP',sync)),s);
  const number=html.indexOf('function formatDocNumber(');
  vm.runInContext(html.slice(number,html.indexOf('// The date this document',number)),s);
  const active=html.indexOf('function activeDocNumber()');
  vm.runInContext(html.slice(active,html.indexOf('// Reserve a date',active)),s);
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
test('summary row keeps joined E/H and adds unjoined customer Q-V',async()=>{
 const c=setup();c.s.draft.customer={name:'Jo Kai',company:'TEST LANDFILL',addr:'12 Main St',city:'Kula',state:'HI',zip:'96790'};
 c.save();await c.sync();const txn=c.sheet()[0];
 assert.equal(txn[4],'Jo Kai / TEST LANDFILL');assert.equal(txn[7],'12 Main St, Kula, HI, 96790');
 assert.deepEqual(txn.slice(16,22),['Jo Kai','TEST LANDFILL','12 Main St','Kula','HI','96790']);
 assert.equal(c.s.getHistory()[0].historySyncPending,false);
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
test('without the new numbering a sale keeps the old digits-only minute number, which can never match a lettered number',()=>{
 const unset=setup();unset.save();const plain=unset.s.getHistory()[0];
 assert.match(plain.txnId,/^TX-\d{4}-\d{4}-\d{2}$/);assert.match(plain.docNumber,/^\d{7}$/);
 const old=setup();
 old.s._reprintSource={txnId:'TX-0101-0900-00',date:'2026-01-01T19:00:00.000Z',docNumber:null};
 assert.match(vm.runInContext('activeDocNumber()',old.s),/^0\d{6}$/);
 old.save();assert.equal(old.s.getHistory()[0].txnId,'TX-0101-0900-00');assert.match(old.s.getHistory()[0].docNumber,/^0\d{6}$/);
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
test('a sale converted from a quote saves as a new transaction naming the quote in column N',async()=>{
 const c=setup();c.connect();c.s._docType='receipt';c.s._quoteSource={txnId:'TX-1013-0925-49-3',docNumber:'3500020'};
 assert.equal(c.save(),true);await c.sync();
 const saved=c.s.getHistory()[0];assert.notEqual(saved.txnId,'TX-1013-0925-49-3');
 assert.deepEqual(saved.fromQuote,{txnId:'TX-1013-0925-49-3',docNumber:'3500020'});
 const txn=c.sheet().find(r=>r[0]==='TXN');assert.equal(txn[13],'TX-1013-0925-49-3');assert.equal(txn[14],'receipt');
 // Re-saving the printed sale keeps the link; a quote never carries one.
 c.s._quoteSource=null;c.save();assert.equal(c.s.getHistory()[0].fromQuote.txnId,'TX-1013-0925-49-3');
 const q=setup();q.s._quoteSource={txnId:'TX-X',docNumber:'1'};q.save();assert.equal(q.s.getHistory()[0].fromQuote,undefined);
});
test('Presold on a quote, receipt or invoice saves PRESELL in column W, and unmarking it re-saves',async()=>{
 for(const doc of ['quote','receipt','invoice']){
  const c=setup();c.connect();c.s._docType=doc;c.s.draft.presell=true;c.save();await c.sync();
  assert.equal(c.sheet().find(r=>r[0]==='TXN')[22],'PRESELL',doc);
  c.s.draft.presell=undefined;c.save();assert.equal(c.s.getHistory()[0].historySyncPending,true);await c.sync();
  assert.equal(c.sheet().find(r=>r[0]==='TXN')[22]||'','',doc);
 }
 const i=setup();i.connect();i.s._docType='internal';i.s.draft.presell=true;i.save();await i.sync();
 const row=i.sheet().find(x=>x[0]==='TXN');assert.ok(!row||!row[22]);
});

function nextTransactionHarness() {
 const c=setup(),s=c.s;s._docType='receipt';s._nextTransactionBusy=false;s._clearedSale=null;
 s.lines=[{pn:'0000131',desc:'FS 131',qty:1,ea:529.99}];s.messages=[];s.clears=0;s.saves=0;
 s.captureSaleLines=()=>clone(s.lines);s.flashScanCommand=(...args)=>s.messages.push(args);
 s.lockLedgerOutputUi=()=>{s.locked=true;};s.releaseLedgerOutputUi=()=>{s.locked=false;};
 s.commitActiveBridgeDraft=()=>{};s.noteToolFailure=()=>{};s.editSessionRefuses=()=>false;
 s.prepareAndSaveForPrint=async(action,opts)=>{assert.equal(action,'save_snapshot');assert.equal(opts.prepareOutput,false);s.saves++;if(s.gate)await s.gate;assert.equal(c.save(),true);};
 s.clearAll=()=>{if(s.refuseClear)return false;assert.ok(s.getHistory().length,'save must precede clear');s.clears++;s.draft=null;s._currentTxnId=null;return true;};
 const at=html.indexOf('async function saveAndClearTransaction()');
 vm.runInContext(html.slice(at,html.indexOf('function runScanCommand(',at)),s);
 return {...c,next:()=>vm.runInContext('saveAndClearTransaction()',s)};
}
test('Next Transaction saves locally while offline before clearing, retaining its identity for Undo',async()=>{
 const c=nextTransactionHarness();assert.equal(await c.next(),true);assert.equal(c.s.clears,1);
 assert.equal(c.s.getHistory().length,1);assert.equal(c.s.getHistory()[0].historySyncPending,true);
 assert.equal(c.s._clearedSale.savedTxnId,c.s.getHistory()[0].txnId);
 assert.equal(c.s._nextTransactionBusy,false);assert.equal(c.s.locked,false);
});
test('failed local save leaves the sale and previous Undo snapshot intact',async()=>{
 const c=nextTransactionHarness();const before=clone(c.s.draft);c.s._clearedSale=['prior'];
 c.s.localStorage.setItem=()=>{throw Error('quota');};assert.equal(await c.next(),false);
 assert.deepEqual(c.s.draft,before);assert.equal(c.s.clears,0);assert.deepEqual(c.s._clearedSale,['prior']);assert.equal(c.s.locked,false);
});
test('repeated Next Transaction during pending save makes one save and one clear',async()=>{
 const c=nextTransactionHarness();let release;c.s.gate=new Promise(r=>release=r);
 const first=c.next();assert.equal(c.s._nextTransactionBusy,true);assert.equal(await c.next(),false);
 release();assert.equal(await first,true);assert.equal(c.s.saves,1);assert.equal(c.s.clears,1);
});
test('unpriced or partly unpriced sales stay on screen instead of silently dropping lines',async()=>{
 const c=nextTransactionHarness();c.s.lines.push({pn:'UNPRICED',qty:1});assert.equal(await c.next(),false);assert.equal(c.s.saves,0);assert.equal(c.s.clears,0);
 c.s.draft=null;assert.equal(await c.next(),false);assert.equal(c.s.clears,0);
});
test('Internal mode cannot leak into saved history and refused reset keeps Undo unchanged',async()=>{
 const c=nextTransactionHarness();c.s._docType='internal';assert.equal(await c.next(),false);assert.equal(c.s.saves,0);
 c.s._docType='receipt';c.s.refuseClear=true;c.s._clearedSale=['prior'];assert.equal(await c.next(),false);assert.equal(c.s.getHistory().length,1);assert.deepEqual(c.s._clearedSale,['prior']);
});
test('Next Transaction on an already saved sale retains one transaction',async()=>{
 const c=nextTransactionHarness();c.save();const id=c.s.getHistory()[0].txnId;assert.equal(await c.next(),true);
 assert.equal(c.s.getHistory().length,1);assert.equal(c.s._clearedSale.savedTxnId,id);
});

test('automatic retry resumes a failed upload without another sign-in',async()=>{
 const c=setup();c.save();c.connect();c.fail(true);
 c.s.document={getElementById:()=>({classList:{contains:()=>true}})};c.s.window={MPELedgerData:require('./ledger-data')};
 await vm.runInContext('retryTransactionSync()',c.s);assert.equal(c.s.countUnpushedTxns(),1);
 c.fail(false);await vm.runInContext('retryTransactionSync()',c.s);
 assert.equal(c.s.countUnpushedTxns(),0);assert.equal(c.sheet().filter(r=>r[0]==='TXN').length,1);
});
test('repeated automatic passes drain a backlog larger than ten without losing or duplicating sales',async()=>{
 const c=setup();for(let i=0;i<23;i++){c.s._currentTxnId=null;c.s._currentTxnDate=null;c.save();}
 c.connect();await c.flush();assert.equal(c.s.countUnpushedTxns(),13);
 await c.flush();assert.equal(c.s.countUnpushedTxns(),3);
 await c.flush();assert.equal(c.s.countUnpushedTxns(),0);
 const txns=c.sheet().filter(r=>r[0]==='TXN');assert.equal(txns.length,23);assert.equal(new Set(txns.map(r=>r[1])).size,23);
});
test('overlapping recovery triggers share one reconciliation and one verified transaction',async()=>{
 const c=setup();c.save();c.connect();const get=c.s.sheetsGet;let resolve,reads=0;
 const gate=new Promise(r=>resolve=r);c.s.sheetsGet=async range=>{reads++;await gate;return get(range);};
 const first=c.flush(),second=c.flush();assert.equal(first,second);assert.equal(reads,1);
 resolve();await Promise.all([first,second]);assert.equal(c.s.countUnpushedTxns(),0);assert.equal(c.sheet().length,2);
});
function installHistoryView(c) {
 const els={txnSearch:{value:''},txnList:{innerHTML:''}};let status='';
 Object.assign(c.s,{document:{getElementById:id=>els[id]},_setTxnStatus:text=>{status=text;},_txnRowHtml:t=>t.txnId});
 const parse=html.indexOf('function _parseTxnRows(');vm.runInContext(html.slice(parse,html.indexOf('function _setTxnStatus',parse)),c.s);
 c.s.parseTransactionsWithContacts=async rows=>c.s._parseTxnRows(rows);
 const refresh=html.indexOf('function refreshTxns(opts)');vm.runInContext(html.slice(refresh,html.indexOf('function _txnRowHtml',refresh)),c.s);
 return {status:()=>status,els};
}
test('history Refresh uploads local backlog before downloading the shared list',async()=>{
 const c=setup();c.save();c.connect();const view=installHistoryView(c);
 await c.s.refreshTxns();assert.equal(c.s.countUnpushedTxns(),0);assert.equal(c.s._txnShown.length,1);
 assert.ok(!view.status().includes('waiting to sync'));assert.ok(!view.status().includes('Refresh failed'));
});
test('failed history refresh keeps local-only legacy rows visible and explicitly reports stale history',async()=>{
 const c=setup();c.save();const order=c.s.getHistory()[0];delete order.historySyncPending;c.storage.set('history',JSON.stringify([order]));
 const view=installHistoryView(c);c.s.sheetsGet=async()=>{throw Error('offline');};
 await c.s.refreshTxns({silent:true});assert.equal(c.s._txnShown.length,1);
 assert.match(view.status(),/1 waiting to sync from this computer/);assert.match(view.status(),/Refresh failed/);
});
test('a sale that cannot be saved does not hold newer sales back, and History names the reason',async()=>{
 const c=setup();c.connect();c.save();await c.sync();const stuckId=c.s.getHistory()[0].txnId;
 c.setSheet([...c.sheet(),['CUSTOMER_UPDATE',stuckId,'evt-1']]);c.s.draft.items[0].qty=3;c.save();   // this edit is refused for good
 c.s._currentTxnId=null;c.s._currentTxnDate=null;c.s._historyContentBaseline=null;c.s.draft.items[0].qty=1;c.save();
 assert.equal(c.s.countUnpushedTxns(),2);await c.flush();
 assert.equal(c.s.countUnpushedTxns(),1);assert.equal(c.sheet().filter(r=>r[0]==='TXN').length,2);
 await c.flush();assert.equal(c.s.countUnpushedTxns(),1);assert.equal(c.sheet().filter(r=>r[0]==='TXN').length,2);
 const view=installHistoryView(c);c.s.googleSessionAvailable=()=>false;await c.s.refreshTxns({silent:true});
 assert.match(view.status(),/1 waiting to sync from this computer · could not save one yet: .*customer updates/);
});
test('an interrupted edit pass is completed by the next pass without duplicate or leftover lines',async()=>{
 const c=setup();c.save();await c.sync();
 const neighbor=[['TXN','OTHER','1/1/2020','10:00 AM','Other'],['item','OTHER','','','','','','','NEIGHBOR','Keep',1,'$1.00','$1.00']];
 c.setSheet([...c.sheet(),...neighbor]);
 c.s.draft.items.push({pn:'B',desc:'Added',qty:1,ea:10,sub:10});c.save();
 const update=c.s.sheetsUpdate;c.s.sheetsUpdate=async()=>{throw Error('offline');};   // rows inserted, contents not written
 await assert.rejects(c.sync(),/offline/);assert.equal(c.sheet().length,5);assert.deepEqual(c.sheet()[2],[]);   // one blank row left behind
 c.s.sheetsUpdate=update;await c.sync();assert.equal(c.sheet().length,5);assert.deepEqual(c.sheet().slice(-2),neighbor);
 c.s.draft.items.pop();c.save();
 const batch=c.s.sheetsBatchUpdate;c.s.sheetsBatchUpdate=async()=>{throw Error('offline');};   // contents written, leftover not removed
 await assert.rejects(c.sync(),/offline/);assert.equal(c.s.countUnpushedTxns(),1);
 c.s.sheetsBatchUpdate=batch;await c.sync();assert.equal(c.sheet().length,4);assert.deepEqual(c.sheet().slice(-2),neighbor);assert.equal(c.s.countUnpushedTxns(),0);
});

// ── F00 characterization (History Edit roadmap, ProjectMap/features/F00-baseline.md) ─────────────
// Records what the register's save path does TODAY for a History Edit. Cases marked KNOWN FAILURE assert
// the current (wrong) behavior so the suite stays green; F01 flips them when it repairs the cause.
// The register screen is emulated: `openForEdit` mimics fillTxnIntoPOS (index.html:7230-7312), which sets
// _reprintSource without fromQuote or the card-fee toggle and takes the baseline after loading.
const flush2 = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
function markHarness() {
 const c = setup(), pay = [];
 const baseGet = c.s.sheetsGet, baseAppend = c.s.sheetsAppend;
 const plain = rows => rows.map(r => r.map(v => typeof v === 'string' ? v.replace(/^'/, '') : v));
 c.s.sheetsGet = async (range, opts) => /^Payments/.test(range) ? clone(pay) : baseGet(range, opts);
 c.s.sheetsAppend = async (range, rows) => /^Payments/.test(range) ? (pay.push(...plain(rows)), {updates: {}}) : baseAppend(range, rows);
 c.s.window = {MPELedgerData: require('./ledger-data'), MPELedgerHostKit: require('./ledger-host')};
 const at = html.indexOf('function queueLedgerEditMark');
 vm.runInContext(html.slice(at, html.indexOf('// History\'s timeline: this sale was printed', at)), c.s);
 const marks = () => pay.filter(r => r[5] === 'edit');
 const openForEdit = (extra = {}) => {   // what openLedgerSale({kind:'edit'}) leaves on a fresh page
  const h = c.s.getHistory()[0] || extra.from;
  c.s._currentTxnId = null; c.s._currentTxnDate = null; c.s._pendingTxnDate = null;
  c.s._reprintSource = {txnId: h.txnId, date: h.date, docType: h.docType, docNumber: h.docNumber, ledgerEdit: true};
  // fillTxnIntoPOS (index.html) keeps the quote link and restores the card fee; test 'fillTxnIntoPOS source' guards the real lines.
  if (extra.fromQuote) c.s._reprintSource.fromQuote = {txnId: extra.fromQuote, docNumber: ''};
  if (extra.cardFee) c.s.draft.toggles.cardFee = true;
  c.s._quoteSource = null;
  vm.runInContext('_historyContentBaseline = historyContentFingerprint(captureOrder())', c.s);
 };
 return {...c, pay: () => clone(pay), marks, openForEdit, otherComputer: () => { c.storage.set('history', '[]'); c.storage.set('pushed', '[]'); }};
}
const rowsOf = sheet => sheet.map(r => r.map(v => String(v ?? '')));

test('F00 edit mark: a changed History Edit save leaves exactly one edit mark holding the before: rows', async () => {
 const c = markHarness(); c.connect(); c.save(); await c.sync(); const original = rowsOf(c.sheet());
 c.openForEdit(); c.s.draft.items[0].qty = 2; c.s.draft.items[0].sub = 1059.98; c.s.draft.total = '1109.93';
 assert.equal(c.save(), true); assert.equal(c.s.getHistory()[0].ledgerEdit, true);
 await c.sync(); await flush2();
 assert.equal(c.marks().length, 1); const note = c.marks()[0][6]; assert.match(note, /^before:/);
 assert.deepEqual(JSON.parse(note.slice('before:'.length)), original);
 assert.equal(c.marks()[0][2], c.s.getHistory()[0].txnId); assert.equal(c.marks()[0][1], c.s.getHistory()[0].docNumber);
 assert.equal(Number(c.sheet()[1][10]), 2);
 await c.sync(); await flush2(); assert.equal(c.marks().length, 1, 'a second push of the same snapshot adds no second mark');
});
test('F00 edit mark: Save with no change writes nothing and leaves no mark', async () => {
 const c = markHarness(); c.connect(); c.save(); await c.sync(); const before = c.sheet(), writes = c.batches();
 c.openForEdit(); assert.equal(c.save(), true); await c.sync(); await flush2();
 assert.equal(c.s.getHistory()[0].historySyncPending, false); assert.equal(c.marks().length, 0);
 assert.deepEqual(c.sheet(), before); assert.equal(c.batches(), writes);
 // Same on a computer that has no local history entry (sheet-only document).
 c.otherComputer(); c.openForEdit({from: {txnId: before[0][1], date: new Date().toISOString(), docType: 'quote', docNumber: before[0][15]}});
 assert.equal(c.save(), true); await c.sync(); await flush2(); assert.equal(c.marks().length, 0); assert.deepEqual(c.sheet(), before);
});
test('F00 edit mark: an offline edit replays after reload with ledgerEdit intact and queues exactly one mark (K5)', async () => {
 const c = markHarness(); c.connect(); c.save(); await c.sync(); const original = rowsOf(c.sheet());
 c.openForEdit(); c.s.draft.items[0].qty = 2; c.fail(true); c.save();
 assert.equal(c.s.getHistory()[0].ledgerEdit, true); assert.equal(c.s.getHistory()[0].historySyncPending, true);
 await assert.rejects(c.sync(), /offline/); await flush2(); assert.equal(c.marks().length, 0, 'no mark before the rewrite lands');
 const r = markHarness(); for (const [k, v] of c.storage) r.storage.set(k, v);
 r.setSheet(c.sheet()); r.connect();
 await r.flush(); await flush2(); await r.flush(); await flush2();
 assert.equal(Number(r.sheet()[1][10]), 2); assert.equal(r.marks().length, 1);
 assert.deepEqual(JSON.parse(r.marks()[0][6].slice(7)), original);
});
test('F00 deposited quote: loaded with History\'s synthetic note, no-change Save writes nothing; a changed Save bakes the note into the rows', async () => {
 const c = markHarness(); c.connect(); c.s._docType = 'quote'; c.save(); await c.sync(); const saved = c.sheet();
 c.openForEdit();   // History sent withDeposit(r): one extra "Deposit paid" note line is on the screen
 c.s.draft.items.push({pn: 'Note', desc: 'Deposit paid $100.00. Balance due $454.96.', qty: 1, ea: 0, sub: 0});
 vm.runInContext('_historyContentBaseline = historyContentFingerprint(captureOrder())', c.s);
 assert.equal(c.save(), true); await c.sync(); await flush2();
 assert.deepEqual(c.sheet(), saved, 'no-change Save: sheet untouched'); assert.equal(c.marks().length, 0);
 c.s.draft.items[0].qty = 2; assert.equal(c.save(), true); await c.sync(); await flush2();
 assert.ok(c.sheet().some(r => r[0] === 'item' && r[8] === 'Note' && /Deposit paid/.test(r[9])), 'ACCEPTED until F03: the item Edit in History still sends the display note, so a changed item Edit saves it as a row (the F01 customer panel sends the raw record)');
 assert.equal(c.marks().length, 1);
});
test('F01 fromQuote: a sheet-only invoice made from a quote keeps column N when edited on a computer with no local copy', async () => {
 const c = markHarness(); c.connect(); c.s._docType = 'invoice'; c.s._quoteSource = {txnId: 'TX-QUOTE-1', docNumber: 'Q21001'};
 c.save(); await c.sync(); assert.equal(c.sheet()[0][13], 'TX-QUOTE-1');
 // Same computer, local copy present: the link survives an edit (previous?.fromQuote).
 c.openForEdit(); c.s.draft.customer.phone = '808-555-0100'; c.save(); await c.sync();
 assert.equal(c.sheet()[0][13], 'TX-QUOTE-1');
 // Other computer: fillTxnIntoPOS keeps no fromQuote, there is no local entry to fall back on.
 const first = c.sheet()[0]; c.otherComputer();
 c.openForEdit({from: {txnId: first[1], date: new Date().toISOString(), docType: 'invoice', docNumber: first[15]}, fromQuote: first[13]});
 c.s.draft.customer.phone = '808-555-0199'; c.save(); await c.sync();
 assert.equal(c.sheet()[0][13], 'TX-QUOTE-1', 'F01 fix: column N survives on a computer with no local copy');
 assert.equal(c.sheet()[0][5], '808-555-0199');
});
test('F00 round trip: one customer field changed on a sheet-only document; every other column survives', async () => {
 const c = markHarness(); c.connect(); c.s._docType = 'invoice'; c.s._quoteSource = {txnId: 'TX-QUOTE-1', docNumber: 'Q21001'};
 c.s.draft = {customer: {name: 'JO KAI', company: 'TEST LANDFILL', addr: '12 MAIN ST', city: 'KULA', state: 'HI', zip: '96790', phone: '808-555-0100', email: 'A@B.CO'},
  items: [{pn: '0000131', desc: 'FS 131', qty: 2, ea: 529.99, sub: 1059.98, sn: ['S1', 'S2']},
          {pn: 'B', desc: 'Chain', qty: 1, ea: 18, sub: 17, originalEa: 20, discountPerUnit: 3},
          {pn: 'Note', desc: 'Call on arrival', qty: 1, ea: 0, sub: 0}],
  total: '1148.18', presell: true, toggles: {cardFee: true}};
 c.save(); await c.sync(); const s0 = rowsOf(c.sheet()); const id = s0[0][1];
 c.otherComputer(); c.openForEdit({from: {txnId: id, date: new Date().toISOString(), docType: 'invoice', docNumber: s0[0][15]}, fromQuote: s0[0][13], cardFee: true});
 c.s.draft.customer.phone = '808-555-0123';   // the register restores the quote link and the card fee on load, so the total stays
 assert.equal(c.save(), true); await c.sync(); await flush2();
 const s1 = rowsOf(c.sheet()); assert.equal(s1.length, s0.length);
 const diff = []; s0.forEach((row, i) => row.forEach((v, j) => { if (v !== s1[i][j]) diff.push(`r${i}c${j}`); }));
 assert.deepEqual(diff, ['r0c5'], 'only the phone differs');
 assert.equal(s1[0][14], 'invoice'); assert.equal(s1[0][15], s0[0][15]); assert.equal(s1[0][22], 'PRESELL');
 assert.equal(s1.filter(r => r[0] === 'item').length, 3); assert.equal(c.marks().length, 1);
});
const raceOther = [['TXN', 'ANOTHER', '1/1/2021', '9:00 AM', 'Another'], ['item', 'ANOTHER', '', '', '', '', '', '', 'X', 'Y', 1, '$2.00', '$2.00']];
const raceNeighbor = [['TXN', 'OTHER', '1/1/2020', '10:00 AM', 'Other'], ['item', 'OTHER', '', '', '', '', '', '', 'NEIGHBOR', 'Keep', 1, '$1.00', '$1.00']];
function assertRaceHealed(c, qty) {
 const after = rowsOf(c.sheet()), id = c.s.getHistory()[0].txnId;
 assert.equal(after.filter(r => r[1] === id && r[0] === 'TXN').length, 1, 'our document exists once');
 assert.ok(after.some(r => r[8] === 'NEIGHBOR') && after.some(r => r[8] === 'X'), 'neither neighbor lost a row');
 assert.equal(after.filter(r => r[0] === 'item' && r[1] === id).length, qty);
 assert.ok(!after.some(r => r.every(v => v === '')), 'no blank row left behind');
}
test('F01 interleaving: rows inserted above the document between the read and the write stop the save, which retries cleanly (edit with no new lines)', async () => {
 const c = markHarness(); c.connect(); c.save(); await c.sync();
 c.setSheet([...raceNeighbor, ...c.sheet()]);   // our document now starts at row 3
 c.openForEdit(); c.s.draft.items[0].qty = 2;
 const get = c.s.sheetsGet; let reads = 0;
 c.s.sheetsGet = async (range, opts) => { const rows = await get(range, opts); if (range === 'Transactions' && ++reads === 1) c.setSheet([...raceOther, ...c.sheet()]); return rows; };
 c.save(); await flush2();   // Save starts its own push, which hits the race and is left queued
 assert.ok(rowsOf(c.sheet()).some(r => r[8] === 'NEIGHBOR') && rowsOf(c.sheet()).some(r => r[8] === 'X'), 'nothing was overwritten');
 assert.equal(c.s.countUnpushedTxns(), 1, 'the save is still queued, not counted as verified');
 c.s.sheetsGet = get; await c.sync(); await flush2();
 assertRaceHealed(c, 1); assert.equal(Number(rowsOf(c.sheet()).find(r => r[0] === 'item' && r[8] === '0000131')[10]), 2);
 assert.equal(c.s.countUnpushedTxns(), 0); assert.equal(c.marks().length, 1);
});
test('F01 interleaving: rows inserted after the block was grown stop the values write; the retry reuses the blank rows', async () => {
 const c = markHarness(); c.connect(); c.save(); await c.sync();
 c.setSheet([...raceNeighbor, ...c.sheet()]);
 c.openForEdit(); c.s.draft.items.push({pn: 'B', desc: 'Added', qty: 1, ea: 10, sub: 10});
 const batch = c.s.sheetsBatchUpdate; let n = 0;
 c.s.sheetsBatchUpdate = async reqs => { await batch(reqs); if (++n === 1) c.setSheet([...raceOther, ...c.sheet()]); };   // another register inserts right after our grow
 c.save(); await flush2();
 assert.ok(rowsOf(c.sheet()).some(r => r[8] === 'NEIGHBOR') && rowsOf(c.sheet()).some(r => r[8] === 'X'), 'nothing was overwritten');
 c.s.sheetsBatchUpdate = batch; await c.sync(); await flush2();
 assertRaceHealed(c, 2); assert.equal(c.s.countUnpushedTxns(), 0); assert.equal(c.marks().length, 1);
});
test('F01 interleaving: a shrinking edit stops before the delete when rows moved', async () => {
 const c = markHarness(); c.connect(); c.s.draft.items.push({pn: 'B', desc: 'Two', qty: 1, ea: 10, sub: 10}); c.save(); await c.sync();
 c.setSheet([...raceNeighbor, ...c.sheet()]);
 c.openForEdit(); c.s.draft.items.pop();
 const update = c.s.sheetsUpdate;
 c.s.sheetsUpdate = async (r, rows) => { await update(r, rows); c.setSheet([...raceOther, ...c.sheet()]); };   // moved after the values were written
 c.save(); await flush2();
 assert.ok(rowsOf(c.sheet()).some(r => r[8] === 'NEIGHBOR') && rowsOf(c.sheet()).some(r => r[8] === 'X'), 'the delete never ran at the old offset');
 assert.equal(c.s.countUnpushedTxns(), 1);
 c.s.sheetsUpdate = update; await c.sync(); await flush2(); assertRaceHealed(c, 1); assert.equal(c.s.countUnpushedTxns(), 0);
});
test('F01 fillTxnIntoPOS source: keeps the quote link and restores the card fee before the baseline, and saveToHistory falls back to the link', () => {
 const body = html.slice(html.indexOf('function fillTxnIntoPOS('), html.indexOf('function buildRows()'));
 assert.match(body, /_reprintSource\.fromQuote = \{ txnId: quoteId/);
 assert.ok(body.indexOf('toggleCardFee(true)') > 0 && body.indexOf('toggleCardFee(true)') < body.indexOf('_historyContentBaseline = historyContentFingerprint'));
 assert.match(body, /mine \? mine\.toggles\?\.cardFee : t\.cardFee/);
 assert.match(html, /previous\?\.fromQuote \|\| \(_reprintSource && _reprintSource\.fromQuote\)/);
});
test('an invoice PO number is saved in column X, survives an edit, and is read back; other types leave X empty',async()=>{
 const c=setup();c.s._docType='invoice';c.s.draft.po='PO-7731';
 assert.equal(c.save(),true);await c.sync();
 assert.equal(c.sheet()[0][23],'PO-7731');assert.equal(c.sheet()[0].slice(0,16).join('|').includes('PO-7731'),false);
 c.s.draft.items[0].qty=3;c.save();await c.sync();assert.equal(c.sheet()[0][23],'PO-7731');
 c.s.draft.po='PO-8000';c.save();await c.sync();assert.equal(c.sheet()[0][23],'PO-8000');
 const at=html.indexOf('function _parseTxnRows(');
 vm.runInContext(html.slice(at,html.indexOf('\n}\n',at)+3),c.s);
 assert.equal(c.s._parseTxnRows(c.sheet())[0].po,'PO-8000');
 const q=setup();q.s.draft.po='IGNORED';q.save();await q.sync();assert.equal(q.sheet()[0][23],'');
});

// ── F01 silent edit session (runEditSession, the register side of History's customer panel) ─────────────────────
function sessionHarness() {
 const c = markHarness(); c.connect();
 const D = require('./ledger-data');
 const map = {custCompany: 'company', custName: 'name', custPhone: 'phone', custEmail: 'email', custAddr: 'addr', custCity: 'city', custState: 'state', custZip: 'zip'};
 const queued = [], refs = [], panel = {dataset: {customerRef: 'k:1'}};
 Object.assign(c.s, {
  partsArray: [{pn: 'x'}], ledgerDraftTabIsEmpty: () => true, ledgerErrorCode: e => e && e.code, ledgerDocumentRequest: () => ({type: 'invoice'}),
  queueCustomerFromOrder: o => { queued.push(o.txnId); refs.push(o.customerRef); }, syncCustomersFromSheet: async () => {}, setTimeout,
  document: {getElementById: id => id === 'custPanel' ? panel : {set value(v) { c.s.draft.customer[map[id]] = v; }, get value() { return c.s.draft.customer[map[id]] || ''; }}},
  fillTxnIntoPOS: t => {   // what the real one leaves on a fresh page: identity and a baseline (the draft already holds the document)
   c.s._reprintSource = {txnId: t.txnId, date: c.stored.date, docType: t.docType, docNumber: t.docNumber, fromQuote: t.fromQuote ? {txnId: t.fromQuote, docNumber: ''} : undefined};
   vm.runInContext('_historyContentBaseline = historyContentFingerprint(captureOrder())', c.s);
  },
  prepareAndSaveForPrint: async () => { vm.runInContext('reserveDocDate()', c.s); if (!vm.runInContext('saveToHistory()', c.s)) throw Object.assign(new Error('x'), {code: 'output_failed'}); },
 });
 const at = html.indexOf("// ── History's silent edit session"); vm.runInContext(html.slice(at, html.indexOf('function toggleSignature() {', at)), c.s);
 c.queued = queued; c.refs = refs; c.panel = panel; c.fp = () => D.transactionRowsFingerprint(c.sheet());
 c.request = (patch, fp) => ({v: 1, kind: 'edit', mode: 'silent', sessionId: 'sess-0001abcd', txn: {txnId: c.stored.txnId, docType: c.s._docType, docNumber: c.stored.docNumber, fromQuote: c.sheet()[0][13]}, loaded: {fingerprint: fp || c.fp()}, patch});
 return c;
}
async function savedInvoice() {
 const c = sessionHarness(); c.s._docType = 'invoice'; c.s._quoteSource = {txnId: 'TX-Q', docNumber: 'Q1'}; c.s.draft.po = 'PO-9';
 c.save(); await c.sync(); await flush2(); c.stored = c.s.getHistory()[0]; c.s._quoteSource = null; return c;
}
test('F01 session request: unknown keys, non-strings and bad ids are refused; text is trimmed and bounded', async () => {
 const c = sessionHarness(); const ok = c.s.editSessionRequest({v: 1, kind: 'edit', mode: 'silent', sessionId: 'abcdefgh', txn: {txnId: 'T', docType: 'invoice'}, loaded: {fingerprint: 'x'}, patch: {phone: '  808 \n 555 ', updateInfo: true}});
 assert.equal(ok.patch.phone, '808   555'); assert.equal(ok.patch.updateInfo, true);
 const bad = patch => c.s.editSessionRequest({v: 1, kind: 'edit', mode: 'silent', sessionId: 'abcdefgh', txn: {txnId: 'T', docType: 'invoice'}, loaded: {fingerprint: 'x'}, patch});
 assert.equal(bad({total: '1'}), null); assert.equal(bad({phone: 5}), null); assert.equal(bad([]), null);
 assert.equal(c.s.editSessionRequest({v: 1, kind: 'edit', mode: 'silent', sessionId: 'a b', txn: {txnId: 'T', docType: 'invoice'}, loaded: {fingerprint: 'x'}, patch: {}}), null);
 assert.equal(bad({phone: 'x'.repeat(500)}).patch.phone.length, 120);
});
test('F01 session: a customer change on a saved invoice rewrites it in place, keeps PO # and quote link, leaves one edit mark', async () => {
 const c = await savedInvoice(), before = rowsOf(c.sheet());
 const r = await c.s.runEditSession(c.request({phone: '808-555-0100', updateInfo: true})); await flush2();
 assert.equal(r.ok, true); assert.equal(r.verified, true); assert.equal(r.customer, 'queued'); assert.equal(r.number, before[0][15]);
 const after = rowsOf(c.sheet()); assert.equal(after[0][5], '808-555-0100'); assert.equal(after[0][13], 'TX-Q'); assert.equal(after[0][23], 'PO-9');
 assert.equal(after.length, before.length); assert.equal(c.marks().length, 1); assert.deepEqual(JSON.parse(c.marks()[0][6].slice(7)), before);
 assert.equal(c.s.getHistory()[0].historySyncPending, false); assert.deepEqual(c.queued, [c.stored.txnId]);
 assert.equal(vm.runInContext('_editSession', c.s), null);
});
test('F01 session: no change writes nothing; a sale screen that cannot reproduce the saved rows is refused with nothing changed', async () => {
 const c = await savedInvoice(), sheet = c.sheet(), writes = c.batches();
 let r = await c.s.runEditSession(c.request({company: 'TEST LANDFILL'})); assert.equal(r.unchanged, true); assert.deepEqual(c.sheet(), sheet);
 c.s.draft.items[0].qty = 5;   // the screen would save a different document than the one History showed
 r = await c.s.runEditSession(c.request({phone: '1'})); assert.equal(r.ok, false); assert.equal(r.code, 'open_sale_screen');
 assert.deepEqual(c.sheet(), sheet); assert.equal(c.batches(), writes); assert.equal(c.marks().length, 0);
});
test('F01 session: another register changed the document since History loaded it: refused, this computer\'s copy restored, nothing sent', async () => {
 const c = await savedInvoice(), loaded = c.fp(), saved = clone(c.s.getHistory()[0]);
 const theirs = c.sheet(); theirs[0][5] = '808-111-2222'; c.setSheet(theirs);
 const r = await c.s.runEditSession(c.request({phone: '808-555-0100', updateInfo: true}, loaded)); await flush2();
 assert.equal(r.ok, false); assert.equal(r.code, 'stale'); assert.match(r.message, /Changed on another register/);
 assert.equal(c.sheet()[0][5], '808-111-2222'); assert.equal(c.marks().length, 0); assert.deepEqual(c.queued, []);
 assert.deepEqual(c.s.getHistory()[0], saved); assert.equal(c.s.countUnpushedTxns(), 0);
});
test('F01 session: offline it saves here and reports pending; the replay writes once, leaves one mark and then updates the customer', async () => {
 const c = await savedInvoice(), before = rowsOf(c.sheet()); c.fail(true);
 const r = await c.s.runEditSession(c.request({phone: '808-555-0100', updateInfo: true})); await flush2();
 assert.equal(r.ok, true); assert.equal(r.pending, true); assert.equal(r.localSaved, true); assert.equal(r.customer, 'waiting');
 assert.equal(c.s.getHistory()[0].historySyncPending, true); assert.deepEqual(rowsOf(c.sheet()), before); assert.deepEqual(c.queued, []);
 c.fail(false); await c.flush(); await flush2(); await c.flush(); await flush2();
 assert.equal(c.sheet()[0][5], '808-555-0100'); assert.equal(c.marks().length, 1); assert.deepEqual(c.queued, [c.stored.txnId]);
});
test('F01 session: a crash after the rows were verified but before the mark still leaves exactly one mark with the true original', async () => {
 const c = await savedInvoice(), before = rowsOf(c.sheet());
 const append = c.s.sheetsAppend; c.s.sheetsAppend = async (range, rows) => { if (/^Payments/.test(range)) throw Error('offline'); return append(range, rows); };
 const r = await c.s.runEditSession(c.request({phone: '808-555-0100'})); await flush2();
 assert.equal(r.verified, true); assert.equal(c.marks().length, 0); assert.ok(c.s.getHistory()[0].editBefore, 'the original is kept on this computer');
 c.s.sheetsAppend = append; await c.flush(); await flush2(); await c.flush(); await flush2();
 assert.equal(c.marks().length, 1); assert.deepEqual(JSON.parse(c.marks()[0][6].slice(7)), before); assert.equal(c.s.getHistory()[0].editBefore, undefined);
});
test('F01 session: an offline edit that the other register beat is let go at replay: sheet copy kept, nothing pending, no mark, no customer update', async () => {
 const c = await savedInvoice(); c.fail(true);
 const r = await c.s.runEditSession(c.request({phone: '808-555-0100', updateInfo: true})); await flush2();
 assert.equal(r.pending, true);
 const theirs = c.sheet(); theirs[0][5] = '808-111-2222'; c.setSheet(theirs); c.fail(false);
 await c.flush(); await flush2(); await c.flush(); await flush2();
 assert.equal(c.sheet()[0][5], '808-111-2222'); assert.equal(c.marks().length, 0); assert.deepEqual(c.queued, []);
 const e = c.s.getHistory()[0]; assert.equal(e.historySyncPending, false); assert.ok(!e.loadedFingerprint && !e.updateInfo && !e.editBefore);
 assert.equal(c.s.countUnpushedTxns(), 0);
});
test('F01 session: if the mark reached the sheet but this computer forgot to drop its held copy, the retry is the same row and no second mark appears', async () => {
 const c = await savedInvoice();
 const r = await c.s.runEditSession(c.request({phone: '808-555-0100'})); await flush2();
 assert.equal(r.verified, true); assert.equal(c.marks().length, 1);
 const history = c.s.getHistory(); history[0].editBefore = JSON.stringify('x'); history[0].editAt = new Date(Date.now() - 5000).toISOString();
 c.storage.set('history', JSON.stringify(history));
 await c.flush(); await flush2(); await c.flush(); await flush2();
 assert.equal(c.marks().length, 1, 'still one mark');
});

// ── F03 embedded edit (the register side of item changes in History's middle column) ─────────────────────
async function embeddedEdit() {
 const c = await savedInvoice(); c.results = []; c.states = [];
 Object.assign(c.s, {MPE_EDIT_SESSION_PAGE: true, clearTimeout, navigator: {userAgent: ''}, updateScreenDocTitle() {}, flashes: [], flashScanCommand: (m, k) => c.s.flashes.push(m)});
 c.s.window.mpeDesktop = {editSessionResult: r => c.results.push(r), editSessionState: s => c.states.push(clone(s))};
 c.s.document.body = {classList: {added: [], add(x) { this.added.push(x); }}};
 c.s.editScreenLines = () => c.s.draft.items.map(i => ({pn: i.pn, ea: i.ea, discountPerUnit: i.discountPerUnit || 0}));   // what the rows hold
 const req = c.request({}); delete req.patch; req.mode = 'embedded'; c.req = req;
 c.cmd = (cmd, extra) => c.s.runEditCommand({v: 1, sessionId: req.sessionId, cmd, ...extra});
 c.twoLines = () => { c.s.draft.items[0].qty = 2; c.s.draft.items[0].sub = 1059.98; c.s.draft.total = '1109.93'; };
 assert.equal(await c.s.runEditSessionAndReport(req), null, 'a loaded embedded edit reports nothing yet');
 return c;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('F03 embedded request: needs no patch; silent still needs one; the silent runner refuses an embedded request', async () => {
 const c = sessionHarness(), base = {v: 1, kind: 'edit', sessionId: 'abcdefgh', txn: {txnId: 'T', docType: 'invoice'}, loaded: {fingerprint: 'x'}};
 assert.equal(c.s.editSessionRequest({...base, mode: 'embedded'}).mode, 'embedded');
 assert.equal(c.s.editSessionRequest({...base, mode: 'silent'}), null);
 assert.equal(c.s.editSessionRequest({...base, mode: 'other'}), null);
 assert.equal((await c.s.runEditSession({...base, mode: 'embedded'})).code, 'invalid');
});
test('F03 embedded: loads and proves, marks the page, sends a ready state, then a qty change saves in place with one edit mark', async () => {
 const c = await embeddedEdit(), before = rowsOf(c.sheet());
 assert.deepEqual(c.s.document.body.classList.added, ['embedded-edit']);
 const first = c.states[0];
 assert.equal(first.v, 1); assert.equal(first.sessionId, c.req.sessionId); assert.equal(first.seq, 1); assert.equal(first.ready, true);
 assert.equal(first.dirty, false); assert.equal(first.canSave, true, 'lines complete: History adds "something changed" (lines or its panel)'); assert.equal(first.saving, false); assert.equal(first.problem, '');
 assert.equal(first.totalCents, 55496); assert.equal(first.originalTotalCents, 55496); assert.equal(first.customer.company, 'TEST LANDFILL');
 assert.deepEqual(Object.keys(first.customer), ['company', 'name', 'phone', 'email', 'street', 'city', 'region', 'zip']);
 c.twoLines(); c.s.scheduleEditState(); c.s.scheduleEditState(); await wait(260);
 assert.equal(c.states.length, 2, 'two calls inside 200 ms send one state');
 const next = c.states[1]; assert.equal(next.seq, 2); assert.equal(next.dirty, true); assert.equal(next.canSave, true); assert.equal(next.totalCents, 110993);
 assert.equal(next.originalTotalCents, 55496);
 const r = await c.cmd('save', {updateInfo: false}); await flush2();
 assert.equal(c.states.at(-1).saving, true, 'History hears saving before the write');
 assert.equal(r.ok, true); assert.equal(r.verified, true); assert.equal(r.number, before[0][15]); assert.deepEqual(c.results, [r]);
 const after = rowsOf(c.sheet()); assert.equal(after.length, before.length); assert.equal(Number(after[1][10]), 2);
 assert.equal(after.filter(row => row[0] === 'TXN').length, 1); assert.equal(c.marks().length, 1); assert.deepEqual(JSON.parse(c.marks()[0][6].slice(7)), before);
 assert.equal(vm.runInContext('_editSession', c.s), null);
 assert.equal(await c.cmd('save', {updateInfo: false}), null, 'the result is sent once'); assert.equal(c.results.length, 1);
});
test('F03 embedded: offline the save stays here and reports pending, like silent', async () => {
 const c = await embeddedEdit(), before = rowsOf(c.sheet()); c.fail(true); c.twoLines();
 const r = await c.cmd('save', {updateInfo: true}); await flush2();
 assert.equal(r.pending, true); assert.equal(r.localSaved, true); assert.equal(r.customer, 'waiting');
 assert.deepEqual(rowsOf(c.sheet()), before); assert.equal(c.s.getHistory()[0].historySyncPending, true);
});
test('F03 embedded: Cancel answers at once, writes nothing and leaves this computer\'s history as it was', async () => {
 const c = await embeddedEdit(), sheet = c.sheet(), history = clone(c.s.getHistory()), writes = c.batches(); c.twoLines();
 const r = await c.cmd('cancel');
 assert.deepEqual({ok: r.ok, cancelled: r.cancelled, unchanged: r.unchanged, sessionId: r.sessionId, txnId: r.txnId, v: r.v}, {ok: true, cancelled: true, unchanged: true, sessionId: c.req.sessionId, txnId: c.stored.txnId, v: 1});
 await flush2(); assert.deepEqual(c.sheet(), sheet); assert.equal(c.batches(), writes); assert.deepEqual(c.s.getHistory(), history); assert.equal(c.marks().length, 0);
 assert.equal(await c.cmd('save', {updateInfo: false}), null); assert.equal(c.results.length, 1);
 assert.equal(await c.s.runEditCommand({v: 1, sessionId: 'someone-else', cmd: 'cancel'}), null, 'a foreign session is ignored');
});
test('F03 embedded: Save with no change answers unchanged and writes nothing', async () => {
 const c = await embeddedEdit(), sheet = c.sheet();
 const r = await c.cmd('save', {updateInfo: false}); assert.equal(r.ok, true); assert.equal(r.unchanged, true);
 await flush2(); assert.deepEqual(c.sheet(), sheet); assert.equal(c.marks().length, 0);
});
test('F03 embedded: a line with no price is refused by name, Save stays off and nothing is written', async () => {
 const c = await embeddedEdit(), sheet = c.sheet(); c.twoLines();
 const lines = c.s.editScreenLines; c.s.editScreenLines = () => [...lines(), {pn: 'GIVEAWAY', ea: 0, blank: false, discountPerUnit: 0}, {pn: 'CUSTOM', ea: 0, blank: true, discountPerUnit: 0}, {pn: 'Note', ea: 0, blank: true, discountPerUnit: 0}, {pn: 'FREE', ea: 0, discountPerUnit: 5}];
 assert.equal(await c.cmd('save', {updateInfo: false}), null);
 const st = c.states.at(-1); assert.equal(st.problem, 'Line 3 has no price'); assert.equal(st.canSave, false); assert.equal(st.dirty, true);
 await flush2(); assert.deepEqual(c.sheet(), sheet); assert.deepEqual(c.results, []);
 c.s.editScreenLines = () => []; c.s.postEditState(); assert.equal(c.states.at(-1).problem, 'Add at least one line');
});
test('F03 embedded: a second edit while one is open is busy; a proof mismatch still opens (no new sale tab, Trevor 2026-11-07) and names the line', async () => {
 const c = await embeddedEdit();
 assert.equal((await c.s.runEditSession(c.request({phone: '1'}))).code, 'busy');
 const d = await savedInvoice(); const states = []; d.s.window.mpeDesktop = {editSessionResult() {}, editSessionState(m) { states.push(m); }}; d.s.MPE_EDIT_SESSION_PAGE = true;
 Object.assign(d.s, {updateScreenDocTitle() {}, editSaveProblem: () => ''});   // the harness has no sale-screen DOM
 const req = d.request({}); delete req.patch; req.mode = 'embedded'; d.s.draft.items[0].qty = 5;
 const r = await d.s.runEditSessionAndReport(req); assert.equal(r, null, JSON.stringify(r)); assert.ok(vm.runInContext('_embeddedEdit', d.s));
 assert.ok(vm.runInContext('_editMismatch', d.s).some(m => m.line === 1 && m.fields.some(f => f.name === 'quantity')));
 assert.match(states.at(-1).problem, /^Check before saving: line 1 .*quantity 5, saved /);
});
test('F03 embedded: hasUnsavedEdit is null-safe', () => {
 const c = sessionHarness(); vm.runInContext('_historyContentBaseline = null', c.s); c.s.draft = null;
 assert.equal(c.s.hasUnsavedEdit(), false); vm.runInContext("_historyContentBaseline = 'x'", c.s); assert.equal(c.s.hasUnsavedEdit(), true);
});
test('F03 edit-session page: Print, Ctrl/Cmd+P, Save, Auto print, PDF, email, charge, clear and the print/save/clear commands do nothing but flash', async () => {
 const fn = name => { const at = html.search(new RegExp(`\\n(async )?function ${name}\\(`)); return html.slice(at, html.indexOf('\n}\n', at) + 3); };
 const calls = [], flashes = [];
 const s = vm.createContext({MPE_EDIT_SESSION_PAGE: true, flashScanCommand: m => flashes.push(m), prepareAndSaveForPrint: async () => calls.push('save'),
  commitActiveBridgeDraft: () => calls.push('clear'), _nextTransactionBusy: false, SCAN_COMMANDS: new Map([['P', 'PRINT'], ['S', 'SAVE'], ['N', 'SAVENEW'], ['D', 'DELETE'], ['Q', 'QTY+1']]),
  autoPrint: () => calls.push('auto'), saveOnly: () => calls.push('saveOnly'), saveAndClearTransaction: () => calls.push('next'), sheetHasContent: () => true, latestScannedItemRow: () => -1});
 const at = html.indexOf('function editSessionRefuses()'); vm.runInContext(html.slice(at, html.indexOf('\n}\n', at) + 3), s);
 for (const name of ['manualPrint', 'saveOnly', 'exportPdf', 'emailDoc', 'chargeCardOnTerminal', 'saveAndClearTransaction', 'openPhoneLists']) {
  vm.runInContext(fn(name), s); assert.equal(await s[name](), undefined, name);
 }
 vm.runInContext(fn('clearAll'), s); assert.equal(s.clearAll(), false);
 vm.runInContext(fn('autoPrint'), s); await s.autoPrint();
 vm.runInContext(fn('runScanCommand'), s); for (const p of ['P', 'S', 'N', 'D']) s.runScanCommand(p);
 assert.deepEqual(calls, []); assert.equal(flashes.length, 13); assert.ok(flashes.every(m => m === 'Use Save or Cancel in History'));
 s.runScanCommand('Q'); assert.equal(flashes.at(-1), 'Scan a part first — no scanned line to change', 'quantity commands still work');
 assert.match(html, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === 'p'\) \{ e\.preventDefault\(\); manualPrint\(\); \}/, 'Ctrl/Cmd+P goes through manualPrint');
 assert.match(html, /if \(MPE_EDIT_SESSION_PAGE\) document\.addEventListener\('click', e => \{ if \(e\.target\.closest && e\.target\.closest\('#docTypeSel \.doc-type-btn'\)\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); editSessionRefuses\(\); \} \}, true\);/);
 s.MPE_EDIT_SESSION_PAGE = false; assert.equal(s.editSessionRefuses(), false, 'an ordinary register is untouched');
});
test('F03 wiring: updateSummary feeds the state hook, the page never reloads for an update, website frame and tab rules hold', () => {
 assert.match(html, /function updateSummary\(\) \{\n  scheduleEditState\(\);/);
 assert.match(html, /async function checkForPosUpdate\(\) \{\n  if \(MPE_EDIT_SESSION_PAGE\) return;/);
 assert.match(html, /posRegisterIsIdleAndEmpty=function\(\)\{if\(document\.querySelector\('iframe\[data-mpe-embed\]'\)/);
 assert.match(html, /b\.onclick=\(\)=>\{if\(!editFrameOpen\(\)\)activateTab\(id\);\};/); assert.match(html, /function addTab\(\)\{if\(editFrameOpen\(\)\)return;/);
 assert.match(html, /e\.data\.type==='edit-command'\)void runEditCommand\(e\.data\.command\)/);
 assert.match(html, /window\.mpeDesktop\.onEditCommand==='function'\)window\.mpeDesktop\.onEditCommand\(c=>void runEditCommand\(c\)\)/);
 assert.match(html, /qa\('iframe\[data-mpe-embed\]'\)\.forEach\(f=>f\.remove\(\)\)/);
 const phone = html.slice(html.indexOf(' @media(max-width:899px){'), html.indexOf('\n', html.indexOf(' @media(max-width:899px){')));
 for (const rule of phone.slice(25).match(/[^{}]+(?=\{)/g)) for (const sel of rule.split(',')) assert.match(sel, /^(body\.counter-view:where\(:not\(\.embedded-edit\)\)|:where\(body:not\(\.embedded-edit\)\) #counterView)/, sel);
});
async function embeddedReady() {   // an embedded harness that has not started its request yet
 const c = await savedInvoice(); c.results = []; c.states = [];
 Object.assign(c.s, {MPE_EDIT_SESSION_PAGE: true, clearTimeout, navigator: {userAgent: ''}, updateScreenDocTitle() {}, flashScanCommand() {}});
 c.s.window.mpeDesktop = {editSessionResult: r => c.results.push(r), editSessionState: s => c.states.push(clone(s))};
 c.s.document.body = {classList: {add() {}}};
 c.s.editScreenLines = () => c.s.draft.items.map(i => ({pn: i.pn, ea: i.ea, discountPerUnit: i.discountPerUnit || 0}));
 const fill = c.s.fillTxnIntoPOS; c.fills = 0; c.s.fillTxnIntoPOS = t => { c.fills++; return fill(t); };
 const req = c.request({}); delete req.patch; req.mode = 'embedded'; c.req = req;
 c.cancel = id => c.s.runEditCommand({v: 1, sessionId: id || req.sessionId, cmd: 'cancel'});
 return c;
}
test('F03 embedded: Cancel while the page is still loading stops the load and answers once, with nothing written', async () => {
 const c = await embeddedReady(), sheet = c.sheet(), history = clone(c.s.getHistory());
 c.s.partsArray = [];   // the page is still waiting for its catalog
 const started = Date.now(), running = c.s.runEditSessionAndReport(c.req);
 await wait(150); assert.equal(await c.cancel('someone-else'), null); assert.equal(await c.cancel(), null);
 const r = await running;
 assert.ok(Date.now() - started < 1500, 'the wait stopped early');
 assert.equal(r.cancelled, true); assert.equal(r.unchanged, true); assert.equal(r.ok, true); assert.equal(r.sessionId, c.req.sessionId); assert.equal(r.txnId, c.stored.txnId);
 assert.deepEqual(c.results, [r]); assert.equal(c.fills, 0); assert.deepEqual(c.states, []);
 assert.equal(vm.runInContext('_embeddedEdit', c.s), null); assert.equal(vm.runInContext('_embeddedLoading', c.s), null);
 await flush2(); assert.deepEqual(c.sheet(), sheet); assert.deepEqual(c.s.getHistory(), history); assert.equal(c.marks().length, 0);
});
test('F03 embedded: a Cancel that comes before its request is answered when the request arrives; a different session is not cancelled', async () => {
 const c = await embeddedReady();
 assert.equal(await c.cancel(), null); assert.deepEqual(c.results, [], 'nothing is answered before the request');
 const r = await c.s.runEditSessionAndReport(c.req);
 assert.equal(r.cancelled, true); assert.deepEqual(c.results, [r]); assert.equal(c.fills, 0);
 const d = await embeddedReady(); await d.cancel('other-session-1');
 assert.equal(await d.s.runEditSessionAndReport(d.req), null, 'a cancel for another session does not stop this one'); assert.equal(d.states.length, 1);
});
test('F03 embedded: History\'s forwarded keys reach the scanner path only, as keydown-like events, and only while an edit is open', async () => {
 const c = await embeddedReady(), keys = []; c.s.onHardwareScanKeydown = e => keys.push(e); c.s.performance = {now: () => 1234};
 assert.equal(c.s.runEditKey({type: 'edit-key', key: '1'}), false, 'no edit open yet');
 await c.s.runEditSessionAndReport(c.req);
 assert.equal(c.s.runEditKey({type: 'edit-key', key: '1', code: 'Digit1', shiftKey: false}), true);
 assert.equal(c.s.runEditKey({type: 'edit-key', key: 'Enter', code: 'Enter'}), true);
 assert.equal(c.s.runEditKey({type: 'edit-key', key: 5}), false); assert.equal(c.s.runEditKey({type: 'edit-key', key: 'x'.repeat(30)}), false);
 assert.deepEqual(keys.map(k => [k.key, k.code, k.ctrlKey, k.repeat, k.isComposing, k.timeStamp]), [['1', 'Digit1', false, false, false, 1234], ['Enter', 'Enter', false, false, false, 1234]]);
 assert.equal(keys[0].target, c.s.document.body, 'never a focused field'); keys[0].preventDefault(); keys[0].stopPropagation();
 assert.match(html, /else if\(e\.data\.type==='edit-key'\)runEditKey\(e\.data\);else if\(e\.data\.type==='edit-scan'\)runEditScan\(e\.data\);\}/, 'website: only from window.parent with the origin check');
 assert.match(html, /body\.embedded-edit #counterView #docTypeSel\{display:none!important\}/, 'type buttons hidden in an embedded edit');
 assert.match(html, /type\.textContent = '· ' \+ \(DOC_TITLES\[_docType\] \|\| ''\)/);
});

// ── The one Edit (D14): the customer typed in History's panel rides on the one save; a refused save keeps the screen open ─────────
test('one Edit: Save carries the customer: applied to the customer boxes like the silent patch, saved with the items in one write and one mark', async () => {
 const c = await embeddedEdit(), before = rowsOf(c.sheet()); c.twoLines();
 const r = await c.cmd('save', {updateInfo: true, customer: {phone: ' 808-555-0100 \n', city: 'Kahului'}}); await flush2();
 assert.equal(r.ok, true); assert.equal(r.verified, true); assert.equal(r.customer, 'queued'); assert.deepEqual(c.results, [r]);
 const after = rowsOf(c.sheet()); assert.equal(after[0][5], '808-555-0100'); assert.equal(Number(after[1][10]), 2, 'items and customer in the same save');
 assert.equal(after[0][2], before[0][2], 'a key not sent is left alone');
 assert.equal(c.marks().length, 1); assert.deepEqual(c.queued, [c.stored.txnId]);
});
test('one Edit: a customer-only Save writes; a customer that is not 8 plain keys is refused with nothing written and the screen open', async () => {
 const c = await embeddedEdit();
 assert.equal(c.states.at(-1).canSave, true, 'nothing changed on the lines, yet Save is allowed: History knows its panel changed');
 const r = await c.cmd('save', {updateInfo: false, customer: {email: 'new@x.example'}}); await flush2();
 assert.equal(r.ok, true); assert.equal(r.verified, true); assert.equal(rowsOf(c.sheet())[0][6], 'new@x.example');
 const d = await embeddedEdit(), sheet = d.sheet();
 for (const bad of [{total: '1'}, {phone: 5}, ['x'], 'x', {phone: 'x'.repeat(401)}]) {
  assert.equal(await d.cmd('save', {updateInfo: false, customer: bad}), null);
  assert.equal(d.states.at(-1).problem, 'That save was not valid. Nothing was saved.');
 }
 await flush2(); assert.deepEqual(d.sheet(), sheet); assert.deepEqual(d.results, [], 'still open');
});
test('one Edit: a refused Save writes nothing, puts the customer boxes back, keeps the screen open with the reason, and the next Save can still go', async () => {
 const c = await embeddedEdit(), saved = clone(c.s.getHistory()[0]);
 const theirs = c.sheet(); theirs[0][5] = '808-111-2222'; c.setSheet(theirs);   // another register changed it since the edit opened
 c.twoLines();
 const r = await c.cmd('save', {updateInfo: true, customer: {phone: '808-555-0100'}}); await flush2();
 assert.equal(r, null, 'no result: the edit stays open'); assert.deepEqual(c.results, []);
 assert.equal(c.sheet()[0][5], '808-111-2222'); assert.equal(c.marks().length, 0); assert.deepEqual(c.queued, []);
 assert.deepEqual(c.s.getHistory()[0], saved, 'this computer\'s copy as it was');
 assert.equal(c.s.draft.customer.phone || '', '', 'the box went back to what it held');
 const st = c.states.at(-1); assert.equal(st.saving, false); assert.match(st.problem, /Changed on another register/); assert.equal(st.canSave, true);
 assert.equal(vm.runInContext('_embeddedEdit.done', c.s), false);
 c.s.scheduleEditState(); await wait(260); assert.equal(c.states.at(-1).problem, '', 'the next change clears the reason');
});
test('T6a picked customer: Save carries customer.customerRef; the customer write uses it (q: dropped, k: kept); no ref keeps the loaded buyer', async () => {
 for (const [sent, used] of [['q:4417', '4417'], ['4417', '4417'], ['k:p:8085550100|sue example', 'k:p:8085550100|sue example'], ['k:|sue example', 'k:|sue example'], ['k:p:2441234|bob kahale', 'k:p:2441234|bob kahale'], ['k:p:808555010012|acme', 'k:p:808555010012|acme'], ['k:p:80855501008085550200|acme', 'k:p:80855501008085550200|acme']]) {
  const c = await embeddedEdit();
  const r = await c.cmd('save', {updateInfo: true, customer: {name: 'Sue Example', customerRef: sent}}); await flush2();
  assert.equal(r.ok, true, sent); assert.equal(r.customer, 'queued');
  assert.deepEqual(c.refs, [used], sent); assert.match(rowsOf(c.sheet())[0][4], /^Sue Example/);
 }
 const plain = await embeddedEdit();
 const r = await plain.cmd('save', {updateInfo: true, customer: {phone: '808-555-0100'}}); await flush2();
 assert.equal(r.ok, true); assert.deepEqual(plain.refs, ['k:1'], 'no customerRef: the loaded buyer, as before');
});
test('T6a picked customer: a junk customerRef is refused by reason, nothing is written and the loaded ref stays', async () => {
 const d = await embeddedEdit(), sheet = d.sheet();
 for (const bad of ['', 'q:', 'q:12a', '12'.repeat(11), 'k:', 'k:nopipe', 'k:|', 'k:|a\nb', 'k:|' + 'x'.repeat(220), 7, null, {}, ['k:|a']]) {
  assert.equal(await d.cmd('save', {updateInfo: true, customer: {name: 'X', customerRef: bad}}), null, JSON.stringify(bad));
  assert.equal(d.states.at(-1).problem, 'That save was not valid. Nothing was saved.');
  assert.equal(d.panel.dataset.customerRef, 'k:1');
 }
 await flush2(); assert.deepEqual(d.sheet(), sheet); assert.deepEqual(d.results, []); assert.deepEqual(d.refs, []); assert.equal(d.marks().length, 0);
});
test('T6a picked customer: a refused save puts the loaded ref back with the boxes', async () => {
 const c = await embeddedEdit();
 const theirs = c.sheet(); theirs[0][5] = '808-111-2222'; c.setSheet(theirs); c.twoLines();
 assert.equal(await c.cmd('save', {updateInfo: true, customer: {name: 'Sue Example', customerRef: 'q:4417'}}), null); await flush2();
 assert.equal(c.panel.dataset.customerRef, 'k:1'); assert.deepEqual(c.refs, []); assert.equal(c.marks().length, 0);
});
test('one Edit: a scan History caught in its customer box (website) is added to the lines like a hardware scan, only while the edit is open', async () => {
 const c = await embeddedReady(), seen = [];
 Object.assign(c.s, {closeAllDropdowns() {}, acceptDecodedScan: (v, how) => seen.push([v, how])});
 assert.equal(c.s.runEditScan({type: 'edit-scan', value: '0000131'}), false, 'no edit yet');
 await c.s.runEditSessionAndReport(c.req);
 assert.equal(c.s.runEditScan({type: 'edit-scan', value: ' 0000131 '}), true);
 assert.equal(c.s.runEditScan({type: 'edit-scan', value: ''}), false); assert.equal(c.s.runEditScan({type: 'edit-scan', value: 'x'.repeat(600)}), false);
 assert.deepEqual(seen, [['0000131', 'hardware']]);
});
test('one Edit layout: only the lines and a slim strip show; header, customer boxes and checkout column are hidden; discount and card fee stay', () => {
 const css = html.slice(html.indexOf('/* The one Edit (D14)'), html.indexOf('\n', html.indexOf('/* The one Edit (D14)') + 300));
 const E = 'body\\.embedded-edit #counterView';
 assert.match(css, new RegExp(E + ' \\.cv-top\\{display:none!important\\}'));
 assert.match(css, new RegExp(E + ' \\.cv-body\\{display:flex;flex-direction:column\\}'));
 assert.match(css, new RegExp(E + ' \\.cv-checkout\\{flex-direction:row'));
 for (const sel of ['.cv-customer-label', '#cvCustomer', '#cvLedger', '#cvFinalize', '#cvCharge', '#sumInternal']) assert.ok(css.includes('body.embedded-edit #counterView ' + sel), sel);
 for (const kept of ['.cv-order', '.cv-fee', '#cvTotals']) assert.ok(css.includes('body.embedded-edit #counterView ' + kept + '{'), kept + ' stays, placed in the strip');
 assert.ok(!/cvOrderValue|cvCardFee|cvNote|#cvPo\{display:none/.test(css), 'order discount, card fee, Add note and PO # are not hidden');
});

test('T10 edit-session greens: scoped to the embedded edit; loaded lines unmarked, a line added after load marked; normal register untouched', async () => {
 const c = await embeddedEdit();
 assert.deepEqual(c.s.document.body.classList.added, ['embedded-edit'], 'the scoping class is set only by the edit session load');
 assert.equal(c.s.editLineAdded(5), false, 'no loaded set (normal register): nothing is marked');
 vm.runInContext('_editLoadedRows = new Set([0, 1])', c.s);
 assert.equal(c.s.editLineAdded(0), false); assert.equal(c.s.editLineAdded(1), false);
 assert.equal(c.s.editLineAdded(2), true, 'a line that was not in the sale at load');
 const css = s => html.includes(s);
 assert.ok(css('body.embedded-edit #counterView .cv-article.cv-added{background:#eef6f0}'));
 assert.ok(css('body.embedded-edit #counterView #cvEntry{border-color:#9cc3a8}'));
 assert.ok(css('body.embedded-edit tr.drop-before>td{box-shadow:inset 0 3px 0 #24683a}') && css('body.embedded-edit tr.drop-after>td{box-shadow:inset 0 -3px 0 #24683a}'));
 assert.equal(html.split('cv-added{').length, html.split('body.embedded-edit #counterView .cv-article.cv-added{').length, 'no unscoped cv-added rule');
});
