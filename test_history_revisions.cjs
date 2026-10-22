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
    HISTORY_KEY: 'history', HISTORY_MAX: 1000, PUSHED_TXNIDS_KEY: 'pushed',
    SHEETS_ID: 'test', TXN_SHEET: 'Transactions', DOC_TITLES: {quote:'Quote',receipt:'Receipt',invoice:'Invoice'},
    _txns: null, _txnsLoadedAt: 0, _txnShown: [], _txnRefreshWarning: '', _txnRefreshPromise: null,
    captureOrder: () => clone(s.draft), maybeSaveNewCustomer() {}, updatePrintBanner() {},
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
      const match=range.match(/A(\d+):[PVW](\d+)/);assert.ok(match,range);
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
test('register numbers are 7 plain digits starting with the register digit and never repeat',()=>{
 const unset=setup();unset.save();const plain=unset.s.getHistory()[0];
 assert.match(plain.txnId,/^TX-\d{4}-\d{4}-\d{2}$/);assert.match(plain.docNumber,/^\d{7}$/);
 const c=setup();c.storage.set('mpeRegisterDigitV1','2');
 assert.equal(vm.runInContext('reserveDocDate(), activeDocNumber()',c.s),'2500001');
 c.save();const first=c.s.getHistory()[0];
 assert.equal(first.docNumber,'2500001');assert.match(first.txnId,/^TX-\d{4}-\d{4}-\d{2}-2$/);
 assert.equal(vm.runInContext('activeDocNumber()',c.s),'2500001');
 c.s.draft.items[0].qty=2;c.save();assert.equal(c.s.getHistory()[0].docNumber,'2500001');
 vm.runInContext('_currentTxnId=null;_currentTxnDate=null;_currentDocNumber=null;_historyContentBaseline=null',c.s);
 c.save();assert.equal(c.s.getHistory()[0].docNumber,'2500002');
 c.storage.delete('mpeLocalDocNumberV1');
 vm.runInContext('_currentTxnId=null;_currentTxnDate=null;_currentDocNumber=null;_historyContentBaseline=null',c.s);
 c.save();assert.equal(c.s.getHistory()[0].docNumber,'2500003','history guards against a lost counter');
 const other=setup();other.storage.set('mpeRegisterDigitV1','3');other.save();
 assert.equal(other.s.getHistory()[0].docNumber,'3500001');
 const old=setup();old.storage.set('mpeRegisterDigitV1','2');
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
test('a quote marked Subtract from inventory count saves PRESELL in column W, and unmarking it re-saves',async()=>{
 const c=setup();c.connect();c.s.draft.presell=true;c.save();await c.sync();
 assert.equal(c.sheet().find(r=>r[0]==='TXN')[22],'PRESELL');
 c.s.draft.presell=undefined;c.save();assert.equal(c.s.getHistory()[0].historySyncPending,true);await c.sync();
 assert.equal(c.sheet().find(r=>r[0]==='TXN')[22]||'','');
 const r=setup();r.connect();r.s._docType='receipt';r.s.draft.presell=true;r.save();await r.sync();
 assert.equal(r.sheet().find(row=>row[0]==='TXN')[22]||'','');
});

function nextTransactionHarness() {
 const c=setup(),s=c.s;s._docType='receipt';s._nextTransactionBusy=false;s._clearedSale=null;
 s.lines=[{pn:'0000131',desc:'FS 131',qty:1,ea:529.99}];s.messages=[];s.clears=0;s.saves=0;
 s.captureSaleLines=()=>clone(s.lines);s.flashScanCommand=(...args)=>s.messages.push(args);
 s.lockLedgerOutputUi=()=>{s.locked=true;};s.releaseLedgerOutputUi=()=>{s.locked=false;};
 s.commitActiveBridgeDraft=()=>{};s.noteToolFailure=()=>{};
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
 c.s.document={getElementById:()=>({classList:{contains:()=>true}})};c.s.window={};
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
