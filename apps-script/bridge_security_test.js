'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cache = new Map();
const properties = new Map();
const context = vm.createContext({
  console,
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: key => properties.get(key) || null }),
  },
  CacheService: {
    getScriptCache: () => ({
      get: key => cache.get(key) || null,
      put: (key, value) => cache.set(key, value),
    }),
  },
  Utilities: {
    Charset: { UTF_8: 'utf8' },
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (_algorithm, value) => [...crypto.createHash('sha256').update(value, 'utf8').digest()].map(n => n > 127 ? n - 256 : n),
    computeHmacSha256Signature: (value, secret) => [...crypto.createHmac('sha256', secret).update(value).digest()].map(n => n > 127 ? n - 256 : n),
    newBlob: value => {
      const bytes = Array.isArray(value) ? Buffer.from(value.map(n => n & 255)) : Buffer.from(String(value), 'utf8');
      return { getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8') };
    },
    base64Encode: bytes => Buffer.from(bytes.map(n => n & 255)).toString('base64'),
    base64EncodeWebSafe: bytes => Buffer.from(bytes.map(n => n & 255)).toString('base64url'),
    base64DecodeWebSafe: value => [...Buffer.from(value, 'base64url')].map(n => n > 127 ? n - 256 : n),
    getUuid: () => crypto.randomUUID(),
  },
  ContentService: { MimeType: { TEXT: 'text', JAVASCRIPT: 'javascript' } }, ScriptApp: {}, UrlFetchApp: {},
});

const source = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
vm.runInContext(source, context, { filename: 'Code.gs' });
const evaluate = expression => vm.runInContext(expression, context);
const rejects = (expression, pattern) => assert.throws(() => evaluate(expression), pattern);

const key = `mpe1_${'A'.repeat(43)}`;
properties.set('DEVICE_KEY_SHA256', crypto.createHash('sha256').update(key).digest('hex'));
context.__key = key;

assert.doesNotThrow(() => evaluate('verifyDeviceKey_(__key)'));
context.__badKey = `mpe1_${'B'.repeat(43)}`;
rejects('verifyDeviceKey_(__badKey)', /not connected/);

assert.equal(evaluate("validRequest_({method:'getStatus',args:[]}).method"), 'getStatus');
rejects("validRequest_({method:'driveFile',args:[]})", /not allowed/);
rejects("validRequest_({method:'sheetsGet',args:['Transactions!A1:B2']}) && validReadRange_('Transactions!A1:B2')", /tab is not allowed/);
rejects("validReadRange_('Codes!A1:E2')", /only rows it just wrote/);

cache.set('readback:Codes!A1:E2', '1');
assert.equal(evaluate("validReadRange_('Codes!A1:E2')"), 'Codes!A1:E2');
assert.equal(evaluate("validReadRange_('Lists!B:B')"), 'Lists!B:B');
assert.equal(evaluate("validReadRange_(\"'New Items'!A1:H1\")"), "'New Items'!A1:H1");
rejects("validReadRange_('Codes!A1:F2')", /not allowed/);
rejects("validReadRange_('Lists!A1:J1002')", /not allowed/);

context.__codeRows = [['123', "'00009302535", 'upc_a', 'scan-phone', '2026-08-18']];
assert.equal(evaluate("validRows_('Codes', __codeRows).length"), 1);
context.__shortRows = [['123', 'PN']];
rejects("validRows_('Codes', __shortRows)", /Invalid Codes row/);
context.__badHeader = [['Captured', 'UPC', 'Item', 'Make', 'Price note', 'Other note', 'Source', 'Wrong']];
rejects("sheetsUpdate_(\"'New Items'!A1:H1\", __badHeader)", /only the New Items header/);
rejects("validRange_('Customers!A1')", /tab is not allowed/);
rejects("validReadRange_('Codes!A1:ZZ2')", /not allowed/);

context.__sid = `S${'a'.repeat(42)}`;
context.__secret = 'temporary-session-secret';
cache.set(`session:${context.__sid}`, context.__secret);
context.__id = '0123456789abcdef0123456789abcdef';
context.__payload = Buffer.from(JSON.stringify(['Lists!B:B'])).toString('base64url');
context.__canonical = `GET\n${context.__id}\nsheetsGet\n${context.__payload}`;
context.__sig = crypto.createHmac('sha256', context.__secret).update(context.__canonical).digest('base64url');
assert.equal(evaluate("verifySignedCall_('GET',{sid:__sid,id:__id,method:'sheetsGet',payload:__payload,sig:__sig}).args[0]"), 'Lists!B:B');
context.__wrongSig = crypto.createHmac('sha256', 'wrong').update(context.__canonical).digest('base64url');
rejects("verifySignedCall_('GET',{sid:__sid,id:__id,method:'sheetsGet',payload:__payload,sig:__wrongSig})", /signature is invalid/);
cache.delete(`session:${context.__sid}`);
rejects("verifySignedCall_('GET',{sid:__sid,id:__id,method:'sheetsGet',payload:__payload,sig:__sig})", /session expired/);

assert.match(source, /verifyDeviceKey_\(form\.key\)/);
assert.match(source, /\['getStatus', 'sheetsGet', 'sheetId', 'catalogInfo', 'catalogChunk'\]/);
assert.match(source, /\['sheetsUpdate', 'sheetsAppend', 'sheetsBatchUpdate'\]/);

console.log('PASS — scan bridge security contract');
