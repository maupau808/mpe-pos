import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';

const html = Object.fromEntries(['index','scan'].map(name => [name, readFileSync(new URL(`./${name}.html`, import.meta.url),'utf8')]));
function fn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  // Top-level functions end at column zero; template strings may contain braces.
  const end = start + source.slice(start).search(/\n\}(?=\n|$)/) + 2;
  return (source.slice(Math.max(0,start-6),start)==='async ' ? 'async ' : '') + source.slice(start,end);
}
const shared = ['reconcileLearnedProductCodes','maruyamaSerialNumber','serialForPart','maruyamaSerialScan'];
for (const name of shared) assert.equal(fn(html.index,name),fn(html.scan,name),`${name} stays in step`);
const parts = [
  {pn:'364846',desc:'BT230L (HI)',make:'Maruyama',warranty:true,list:305},
  {pn:'364852',desc:'B270L TURBO (HI)',make:'Maruyama',warranty:true,list:445},
  {pn:'364855',desc:'B300L TURBO (HI)',make:'Maruyama',warranty:true,list:485},
  {pn:'OTHER',desc:'Other brand',make:'ECHO',warranty:true,list:100}
];
const codes = {'00818364002642':'364846','00818364002703':'364852','00818364002734':'364855',
  '@UNIT-MANUAL:A100499X':'364846','@UNIT-MANUAL:A100079R':'364852',
  '@UNIT-MANUAL:A100399W':'364855','A102999/':'364855','A100899.':'364855'};
function harness(kind) {
  const stored = new Map();
  const c=vm.createContext({console,Blob,Response,DecompressionStream,Date,performance,
    partsArray:parts,partCodeMap:{},partCodeCustomMap:{},serialNumberMap:{},
    unitSerialPrefixRules:[],unitSerialCandidateRules:[],partCodeLearned:{},partCodePending:[],learnedCodes:{},pendingCodes:[],
    K_LEARNED:'learned',feedStamp:'',loaded:true,scanExactIndex:null,bindMode:false,
    document:{getElementById:()=>({style:{},textContent:''})},
    localStorage:{setItem:(key,value)=>stored.set(key,value)},
    save:(key,value)=>stored.set(key,JSON.stringify(value)),
    persistLearnedPartCodes:()=>stored.set('learned',JSON.stringify(c.partCodeLearned)),
    normalizePN:v=>String(v||'').replace(/[\s.-]/g,'').toUpperCase(),
    uniqueScanParts:items=>[...new Map(items.map(p=>[p.pn,p])).values()],
    exactScanParts:pn=>c.partsArray.filter(p=>p.pn===pn),
    stihlUnitDataMatrix:()=>null,toroUnitQr:()=>null,structuredScanParts:()=>[],distributorPartCandidates:()=>[],exactWarrantyModelParts:()=>[],
    isOtherPart:p=>p.pn==='OTHER',normalizeSaleRules:x=>x||[],rebuildCustomCodeMap(){},buildWarrantyModelMap(){},
    overlayPendingSerialMatches(){},warmUpSearch(){},flushPendingCatalogScans(){},refreshStatusUI(){},setFeedState(){},renderBindPool(){},
  });
  for(const name of [...shared,'canonicalScannedCode','canonicalSerialNumber','loadUnitSerialRules','unitSerialCandidates','resolveScannedValue','loadPosJsonBytes'])
    vm.runInContext(fn(html[kind],name),c);
  return {c,stored,run:src=>vm.runInContext(src,c),async load(){const b=gzipSync(JSON.stringify({parts,codes}));c.bytes=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);await c.loadPosJsonBytes(c.bytes,'fixture');}};
}
let checks=0;
for (const kind of ['index','scan']) {
  const t=harness(kind),c=t.c;
  const learned=kind==='index'?'partCodeLearned':'learnedCodes',pending=kind==='index'?'partCodePending':'pendingCodes';
  c[learned]={'00818364002642':'364852','00818364002703':'364846','00818364002734':'364846'};
  await t.load();
  for(const [code,pn] of Object.entries(codes).slice(0,3)) {
    for(const input of [code,code.slice(1),code.slice(2)]) {
      const result=c.resolveScannedValue(input);
      assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].pn,pn);checks++;
    }
    assert.equal(JSON.parse(t.stored.get('learned'))[code],pn);checks++;
  }
  // A second catalog refresh cannot restore the bad device mapping.
  await t.load();assert.equal(c.resolveScannedValue('818364002642').candidates[0].pn,'364846');checks++;
  c[pending]=[{code:'818364002642',pn:'364852'}];await t.load();
  assert.equal(c.resolveScannedValue('818364002642').candidates[0].pn,'364852');checks++;
  c[pending]=[{code:'818364002642',pn:'',remove:true,source:'scan-phone-unbind'}];await t.load();
  assert.equal(c.resolveScannedValue('818364002642').candidates.length,0);checks++;
  c[pending]=[];await t.load();
  for(const [raw,base,pn] of [['A100499X','A100499','364846'],['A100079R','A100079','364852'],['A100399W','A100399','364855'],['A102999/','A102999','364855'],['A100899.','A100899','364855']]) {
    for(const value of [raw,base]) {
      const result=c.resolveScannedValue(value);
      assert.equal(result.via,'maruyama-serial');assert.equal(result.serial,base);assert.equal(result.candidates[0].pn,pn);assert.equal(result.bindCode,'');checks++;
    }
  }
  assert.equal(c.maruyamaSerialNumber('A100499Q'),'');
  assert.equal(c.maruyamaSerialNumber('A102999!'),'');
  assert.equal(c.serialForPart('A100499X',parts[3]),'A100499X');checks+=3;
  c.serialNumberMap['A100499']='364852';
  assert.equal(c.resolveScannedValue('A100499X').candidates.length,2);checks++;
  c.serialNumberMap={'A100499X':'OTHER'};c.partCodeMap={};
  assert.equal(c.maruyamaSerialScan('A100499'),null);checks++;
  if(kind==='scan') {
    // The actual phone accept path handles an unknown checksum serial after a UPC.
    Object.assign(c,{scannerMode:'pos',SCANNER_MODES:{pos:{}},claimScannedValue:()=>true,
      list:[{...parts[0],serial:'',price:305}],persistList(){},showHero(){},beep(){},buzz(){},scanActive:false,
      ignorableScanCode:()=>false,addUnknown(){throw Error('serial became an unknown UPC');},openSearch(){},setCamStatus(){}});
    vm.runInContext(fn(html.scan,'looksLikeSerial')+'\n'+fn(html.scan,'acceptScan'),c);
    c.serialNumberMap={};c.acceptScan('A100299V','code_39');
    assert.equal(c.list[0].serial,'A100299');checks++;
    Object.assign(c,{pricing:part=>({price:part.list,was:0,onSale:false})});
    vm.runInContext(fn(html.scan,'entryFromPart')+'\n'+fn(html.scan,'addToList'),c);
    c.list=[{...parts[0],serial:'',qty:1}];
    c.serialNumberMap={A100499X:'364846'};
    c.acceptScan('A100499X','code_39');
    assert.equal(c.list.length,1);assert.equal(c.list[0].serial,'A100499');assert.equal(c.list[0].qty,1);checks++;

    Object.assign(c,{serialModel:()=>parts[0],serialDraft:{pn:'364846',scans:[]},serialNote(){},
      saveSerialDraft:d=>(c.serialDraft=d,true),renderSerialWork(){}});
    vm.runInContext(fn(html.scan,'scanSerialMatch'),c);
    c.scanSerialMatch('A102999/','code_39');assert.equal(c.serialDraft.scans[0].serial,'A102999');checks++;
    c.serialNumberMap={'A100499X':'364852'};
    c.scanSerialMatch('A100499','code_39');assert.equal(c.serialDraft.scans.length,1);checks++;
  }
  console.log('PASS',kind,'published UPCs, persistent cache repair, pending edits, checksummed serials, legacy matches, ambiguity');
}
// The counter's Bridge refresh must replace old learned matches, respect an
// unmatch, ignore serial namespaces and keep a deliberate pending local change.
{
  const t=harness('index'),c=t.c;
  Object.assign(c,{googleSessionAvailable:()=>true,ensurePartCodesSheet:async()=>{},PART_CODES_SHEET:'Codes',
    sheetsGet:async()=>[['818364002642','364846'],['818364002703','364852'],['818364002703','','','scan-phone-unbind'],['@UNIT-MANUAL:A100499','364846']],
    persistPendingPartCodes(){},sheetsAppend:async()=>null});
  c.partCodeLearned={'00818364002642':'364852'};
  vm.runInContext(fn(html.index,'_flushPendingPartCodes'),c);await c._flushPendingPartCodes();
  assert.equal(c.partCodeLearned['00818364002642'],'364846');
  assert.equal(c.partCodeMap['00818364002703'],undefined);
  assert.equal(c.partCodeMap['@UNIT-MANUAL:A100499'],undefined);checks+=3;
}
console.log(`${checks} scanner identity checks passed`);
