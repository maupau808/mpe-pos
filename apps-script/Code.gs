/*
 * MPE Scan Bridge
 *
 * Runs as info@mauipowerequipment.com. The public web app exposes no Google
 * token and no general Drive/Sheets API. A phone exchanges its device key for
 * a short-lived signing session. Only the key hash is stored permanently.
 */

const BRIDGE_VERSION = 1;
const SHOP_ACCOUNT = 'info@mauipowerequipment.com';
const SHEETS_ID = '18muyvVxMXRp1gSo0TikijL2SyKOqt7qVIL886vbKZrA';
const POS_JSON_FILE_ID = '1I4pT1MUWAm2cIkch2T7JW_hKt3wcLIyd';
const MAX_CATALOG_BYTES = 30 * 1024 * 1024;
const MAX_CHUNK_BYTES = 384 * 1024;
const MAX_ROWS = 1000;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const SESSION_SECONDS = 6 * 60 * 60;
const RESULT_SECONDS = 10 * 60;
const ID_PATTERN = /^[a-f0-9]{32}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{32,100}$/;
const CALLBACK_PATTERN = /^__mpeScanBridge_[A-Za-z0-9_]{12,80}$/;

const TAB_COLUMNS = Object.freeze({
  Codes: 5,
  Lists: 10,
  Prices: 6,
  'New Items': 8,
});
const NEW_ITEMS_HEADER = Object.freeze(['Captured', 'UPC', 'Item', 'Make', 'Price note', 'Other note', 'Source', 'Filed']);

function doGet(event) {
  const query = event && event.parameter || {};
  const callback = String(query.callback || '');
  if (!CALLBACK_PATTERN.test(callback)) return javascriptResponse_('/* invalid scanner callback */');
  let envelope;
  try {
    if (query.action === 'bootstrapResult') {
      const id = validId_(query.id);
      const cached = CacheService.getScriptCache().get(`bootstrap:${id}`);
      envelope = cached ? JSON.parse(cached) : { pending: true };
    } else if (query.action === 'call') {
      envelope = { ok: true, result: signedGetCall_(query) };
    } else {
      throw new Error('Scanner request is not allowed');
    }
  } catch (error) {
    envelope = { ok: false, error: safeError_(error) };
  }
  return javascriptResponse_(`${callback}(${JSON.stringify(envelope)});`);
}

function doPost(event) {
  const form = event && event.parameter || {};
  try {
    if (form.action === 'bootstrap') {
      createSession_(form);
    } else if (form.action === 'call') {
      signedPostCall_(form);
    }
  } catch (error) {
    const id = String(form.id || '');
    if (ID_PATTERN.test(id)) {
      const prefix = form.action === 'bootstrap' ? 'bootstrap' : `result:${String(form.sid || '')}`;
      CacheService.getScriptCache().put(`${prefix}:${id}`, JSON.stringify({ ok: false, error: safeError_(error) }), RESULT_SECONDS);
    }
  }
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function createSession_(form) {
  const id = validId_(form.id);
  verifyDeviceKey_(form.key);
  const sessionId = randomToken_();
  const secret = randomToken_() + randomToken_();
  const cache = CacheService.getScriptCache();
  cache.put(`session:${sessionId}`, secret, SESSION_SECONDS);
  cache.put(`bootstrap:${id}`, JSON.stringify({ ok: true, result: { sessionId, secret } }), RESULT_SECONDS);
}

function signedGetCall_(query) {
  const clean = verifySignedCall_('GET', query);
  if (clean.method === 'result') {
    const resultId = validId_(clean.args[0]);
    const cached = CacheService.getScriptCache().get(`result:${clean.sessionId}:${resultId}`);
    return cached ? { ready: true, envelope: JSON.parse(cached) } : { ready: false };
  }
  if (!['getStatus', 'sheetsGet', 'sheetId', 'catalogInfo', 'catalogChunk'].includes(clean.method)) {
    throw new Error('Scanner read method is not allowed');
  }
  return dispatchBridgeCall_(clean.method, clean.args);
}

function signedPostCall_(form) {
  const clean = verifySignedCall_('POST', form);
  if (!['sheetsUpdate', 'sheetsAppend', 'sheetsBatchUpdate'].includes(clean.method)) {
    throw new Error('Scanner write method is not allowed');
  }
  let envelope;
  try {
    envelope = { ok: true, result: dispatchBridgeCall_(clean.method, clean.args) };
  } catch (error) {
    envelope = { ok: false, error: safeError_(error) };
  }
  CacheService.getScriptCache().put(`result:${clean.sessionId}:${clean.id}`, JSON.stringify(envelope), RESULT_SECONDS);
}

function verifySignedCall_(verb, fields) {
  const sessionId = String(fields.sid || '');
  if (!SESSION_PATTERN.test(sessionId)) throw new Error('Scanner session expired');
  const id = validId_(fields.id);
  const method = String(fields.method || '');
  const payload = String(fields.payload || '');
  if (!/^[A-Za-z0-9_-]*$/.test(payload) || payload.length > MAX_REQUEST_BYTES * 2) throw new Error('Invalid scanner payload');
  const secret = CacheService.getScriptCache().get(`session:${sessionId}`);
  if (!secret) throw new Error('Scanner session expired');
  const canonical = `${verb}\n${id}\n${method}\n${payload}`;
  const expected = hmacBase64Url_(secret, canonical);
  if (!constantEqual_(expected, String(fields.sig || ''))) throw new Error('Scanner request signature is invalid');
  const decoded = payload ? Utilities.newBlob(Utilities.base64DecodeWebSafe(payload)).getDataAsString() : '[]';
  const args = JSON.parse(decoded);
  const valid = validRequest_({ method: method === 'result' ? 'getStatus' : method, args: method === 'result' ? [] : args });
  return { sessionId, id, method, args: method === 'result' ? args : valid.args };
}

function dispatchBridgeCall_(method, args) {
  switch (method) {
    case 'getStatus': return bridgeStatus_();
    case 'sheetsGet': return sheetsGet_(args[0]);
    case 'sheetsUpdate': return sheetsUpdate_(args[0], args[1]);
    case 'sheetsAppend': return sheetsAppend_(args[0], args[1]);
    case 'sheetsBatchUpdate': return sheetsBatchUpdate_(args[0]);
    case 'sheetId': return sheetId_(args[0]);
    case 'catalogInfo': return bridgeCatalogInfo_((args || [])[0]);
    case 'catalogChunk': return bridgeCatalogChunk_((args || [])[0], args[1], args[2]);
    default: throw new Error('Scanner bridge method is not allowed');
  }
}

function bridgeStatus_() {
  const response = sheetsFetch_('?fields=sheets.properties.title', { method: 'get' }, 'Scanner sheet connection failed');
  const titles = (JSON.parse(response.getContentText()).sheets || []).map(sheet => sheet && sheet.properties && sheet.properties.title);
  ['Codes', 'Lists', 'Prices'].forEach(title => {
    if (!titles.includes(title)) throw new Error(`Scanner sheet tab "${title}" not found`);
  });
  return { connected: true, accountEmail: SHOP_ACCOUNT, bridgeVersion: BRIDGE_VERSION };
}

function javascriptResponse_(javascript) {
  return ContentService.createTextOutput(javascript).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function validId_(value) {
  const id = String(value || '');
  if (!ID_PATTERN.test(id)) throw new Error('Invalid scanner request id');
  return id;
}

function randomToken_() {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${Utilities.getUuid()}|${Date.now()}|${Math.random()}`)).replace(/=+$/, '');
}

function hmacBase64Url_(secret, value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret)).replace(/=+$/, '');
}

function constantEqual_(left, right) {
  let different = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    different |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return different === 0;
}

function safeError_(error) {
  return String(error && error.message || error || 'Scanner connection failed').slice(0, 500);
}

function bridgeCall(deviceKey, request) {
  verifyDeviceKey_(deviceKey);
  const clean = validRequest_(request);
  return dispatchBridgeCall_(clean.method, clean.args);
}

function bridgeCatalogInfo_(kind) {
  if (kind !== 'json') throw new Error('Only the scanner catalog is allowed');
  const response = googleFetch_(
    `https://www.googleapis.com/drive/v3/files/${POS_JSON_FILE_ID}?fields=id,name,size,modifiedTime,trashed`,
    { method: 'get' },
    'Could not read scanner catalog information'
  );
  const data = JSON.parse(response.getContentText());
  const size = Number(data.size);
  if (data.trashed || !Number.isSafeInteger(size) || size < 1 || size > MAX_CATALOG_BYTES) {
    throw new Error('Scanner catalog size is not allowed');
  }
  return { size, modifiedTime: String(data.modifiedTime || '') };
}

function bridgeCatalogChunk_(kind, offset, length) {
  if (kind !== 'json') throw new Error('Only the scanner catalog is allowed');
  const start = Number(offset);
  const count = Number(length);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNK_BYTES) {
    throw new Error('Scanner catalog chunk is not allowed');
  }
  const end = start + count - 1;
  if (end >= MAX_CATALOG_BYTES) throw new Error('Scanner catalog chunk is too large');
  const response = googleFetch_(
    `https://www.googleapis.com/drive/v3/files/${POS_JSON_FILE_ID}?alt=media`,
    { method: 'get', headers: { Range: `bytes=${start}-${end}` } },
    'Could not download scanner catalog'
  );
  const bytes = response.getBlob().getBytes();
  if (!bytes.length || bytes.length > count) throw new Error('Scanner catalog returned an invalid chunk');
  return { offset: start, bytes: Utilities.base64Encode(bytes) };
}

function validRequest_(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid scanner request');
  const method = String(request.method || '');
  const args = request.args;
  if (!Array.isArray(args) || args.length > 3) throw new Error('Invalid scanner arguments');
  if (!['getStatus', 'sheetsGet', 'sheetsUpdate', 'sheetsAppend', 'sheetsBatchUpdate', 'sheetId', 'catalogInfo', 'catalogChunk'].includes(method)) {
    throw new Error('Scanner bridge method is not allowed');
  }
  const size = Utilities.newBlob(JSON.stringify({ method, args })).getBytes().length;
  if (size > MAX_REQUEST_BYTES) throw new Error('Scanner request is too large');
  return { method, args };
}

function verifyDeviceKey_(deviceKey) {
  const raw = String(deviceKey || '');
  if (!/^mpe1_[A-Za-z0-9_-]{40,80}$/.test(raw)) throw new Error('This phone is not connected');
  const expected = String(PropertiesService.getScriptProperties().getProperty('DEVICE_KEY_SHA256') || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Scanner bridge is not configured');
  const actual = sha256Hex_(raw);
  let different = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    different |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  if (different !== 0) throw new Error('This phone is not connected');
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(byte => (`0${(byte & 255).toString(16)}`).slice(-2)).join('');
}

function validRange_(range) {
  const value = String(range || '');
  if (value.length > 100) throw new Error('Invalid scanner sheet range');
  const match = /^(?:'([^']+)'|([^'!]+))!([A-Z]{1,2})(\d+)?(?::([A-Z]{1,2})(\d+)?)?$/.exec(value);
  if (!match) throw new Error('Scanner sheet range is not allowed');
  const tab = match[1] || match[2];
  if (!Object.prototype.hasOwnProperty.call(TAB_COLUMNS, tab)) throw new Error('Scanner sheet tab is not allowed');
  return { value, tab, startColumn: match[3], startRow: match[4], endColumn: match[5], endRow: match[6] };
}

function columnNumber_(letters) {
  return String(letters || '').split('').reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

function validReadRange_(range) {
  if (range === 'Lists!B:B') return range;
  if (range === "'New Items'!A1:H1" || range === 'New Items!A1:H1') return range;
  const parsed = validRange_(range);
  if (!parsed.startRow || !parsed.endColumn || !parsed.endRow) throw new Error('Scanner read range is not allowed');
  const maxColumn = TAB_COLUMNS[parsed.tab];
  const firstColumn = columnNumber_(parsed.startColumn);
  const lastColumn = columnNumber_(parsed.endColumn);
  const firstRow = Number(parsed.startRow);
  const lastRow = Number(parsed.endRow);
  if (firstColumn < 1 || lastColumn < firstColumn || lastColumn > maxColumn ||
      !Number.isSafeInteger(firstRow) || !Number.isSafeInteger(lastRow) || firstRow < 1 ||
      lastRow < firstRow || lastRow - firstRow + 1 > MAX_ROWS) {
    throw new Error('Scanner read range is not allowed');
  }
  if (parsed.tab === 'Lists') return parsed.value;
  const allowed = CacheService.getScriptCache().get(`readback:${parsed.value}`);
  if (allowed !== '1') throw new Error('Scanner can read only rows it just wrote');
  return parsed.value;
}

function validRows_(tab, rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) throw new Error('Invalid scanner rows');
  const expectedColumns = TAB_COLUMNS[tab];
  rows.forEach(row => {
    if (!Array.isArray(row) || row.length !== expectedColumns) throw new Error(`Invalid ${tab} row`);
    row.forEach(value => {
      const type = typeof value;
      if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') throw new Error('Invalid scanner value');
      if (type === 'number' && !Number.isFinite(value)) throw new Error('Invalid scanner number');
      if (type === 'string' && value.length > 100000) throw new Error('Scanner value is too large');
    });
  });
  if (Utilities.newBlob(JSON.stringify(rows)).getBytes().length > MAX_REQUEST_BYTES) throw new Error('Scanner rows are too large');
  return rows;
}

function sheetsGet_(range) {
  const allowedRange = validReadRange_(range);
  const response = sheetsFetch_(`values/${encodeURIComponent(allowedRange)}`, { method: 'get' }, 'Scanner sheet read failed');
  return (JSON.parse(response.getContentText()).values || []);
}

function sheetsUpdate_(range, rows) {
  const allowed = range === "'New Items'!A1:H1" || range === 'New Items!A1:H1';
  if (!allowed) throw new Error('Scanner sheet update range is not allowed');
  validRows_('New Items', rows);
  if (rows.length !== 1 || JSON.stringify(rows[0]) !== JSON.stringify(NEW_ITEMS_HEADER)) {
    throw new Error('Scanner may update only the New Items header');
  }
  sheetsFetch_(`values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'put', contentType: 'application/json', payload: JSON.stringify({ values: rows }),
  }, 'Scanner sheet update failed');
  const written = sheetsGetDirect_(range);
  if (JSON.stringify(written) !== JSON.stringify(rows)) throw new Error('Scanner sheet update did not verify');
  return true;
}

function sheetsAppend_(range, rows) {
  const parsed = validRange_(range);
  if (parsed.startColumn !== 'A' || parsed.startRow !== '1' || parsed.endColumn || parsed.endRow) {
    throw new Error('Scanner append range is not allowed');
  }
  validRows_(parsed.tab, rows);
  const response = sheetsFetch_(`values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ values: rows }),
  }, 'Scanner sheet append failed');
  const data = JSON.parse(response.getContentText());
  const updatedRange = String(data && data.updates && data.updates.updatedRange || '');
  if (!updatedRange) throw new Error('Scanner append returned no verification range');
  const written = sheetsGetDirect_(updatedRange);
  if (written.length !== rows.length) throw new Error('Scanner append did not verify every row');
  CacheService.getScriptCache().put(`readback:${updatedRange}`, '1', 600);
  return data;
}

function sheetsGetDirect_(range) {
  const response = sheetsFetch_(`values/${encodeURIComponent(range)}`, { method: 'get' }, 'Scanner verification read failed');
  return (JSON.parse(response.getContentText()).values || []);
}

function sheetId_(tabName) {
  if (tabName !== 'New Items') throw new Error('Scanner sheet tab is not allowed');
  const response = sheetsFetch_('?fields=sheets.properties', { method: 'get' }, 'Scanner sheet metadata failed');
  const sheets = JSON.parse(response.getContentText()).sheets || [];
  const match = sheets.find(sheet => sheet && sheet.properties && sheet.properties.title === tabName);
  if (!match) throw new Error(`Sheet tab "${tabName}" not found`);
  return match.properties.sheetId;
}

function sheetsBatchUpdate_(requests) {
  const exact = Array.isArray(requests) && requests.length === 1 &&
    JSON.stringify(requests[0]) === JSON.stringify({ addSheet: { properties: { title: 'New Items' } } });
  if (!exact) throw new Error('Scanner sheet setup request is not allowed');
  sheetsFetch_(':batchUpdate', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ requests }),
  }, 'Scanner sheet setup failed');
  if (!sheetId_('New Items')) throw new Error('Scanner sheet setup did not verify');
  return true;
}

function sheetsFetch_(suffix, options, fallback) {
  const separator = String(suffix).startsWith(':') || String(suffix).startsWith('?') ? '' : '/';
  return googleFetch_(`https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}${separator}${suffix}`, options, fallback);
}

function googleFetch_(url, options, fallback) {
  const request = Object.assign({}, options || {}, {
    muteHttpExceptions: true,
    headers: Object.assign({}, (options && options.headers) || {}, { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }),
  });
  const response = UrlFetchApp.fetch(url, request);
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    let detail = '';
    try {
      const body = JSON.parse(response.getContentText());
      detail = body.error && (body.error.message || body.error.status) || '';
    } catch (error) {}
    throw new Error(`${fallback} (${status})${detail ? `: ${detail}` : ''}`);
  }
  return response;
}
