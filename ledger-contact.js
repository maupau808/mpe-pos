/* Exact, append-only customer completion for existing Bridge transactions.
 * No pricing, transaction-row replacement, QBO, customer-directory or print owner.
 * Shared pure contract is exercised from Node and the real POS page. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MPETransactionContact = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const SCHEMA = 'mpe-pos-contact-update-v1';
  const HANDOFF = 'mpe-ledger-pos-contact-v1';
  const HASH = /^[0-9a-f]{64}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const LIMITS = [200, 200, 500, 100, 100, 30, 100, 254];
  const fail = message => { throw new Error(message); };
  function cells(row) {
    if (!Array.isArray(row) || row.slice(16).some(v => v != null && v !== '')) fail('Unsupported transaction columns.');
    return Array.from({ length: 16 }, (_, i) => {
      const value = row[i] == null ? '' : row[i];
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail('Invalid transaction cells.');
      return String(value);
    });
  }
  async function hash(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  function validContact(value) {
    if (!Array.isArray(value) || value.length !== 8 || value.some((v,i) => typeof v !== 'string' || v !== v.trim() || v.length > LIMITS[i] || /[\u0000-\u001f\u007f]/.test(v))) fail('Check the customer fields.');
    if (!value[0] && !value[1]) fail('Enter a name or company.');
    if (!value[2] && !value[6] && !value[7]) fail('Enter an address, phone or email.');
    return value.slice();
  }
  function visibleContact(contact) {
    return [[contact[0],contact[1]].filter(Boolean).join(' / '),contact[6],contact[7],contact.slice(2,6).filter(Boolean).join(', ')];
  }
  function baseContact(header, customer = []) {
    if (customer.some(Boolean)) return [...customer, header[5], header[6]];
    const name = header[4].split(' / ');
    return [name[0],name.slice(1).join(' / '),header[7],'','','',header[5],header[6]];
  }
  function group(rows, txnId) {
    if (typeof txnId !== 'string' || !txnId || txnId.length > 200 || /[\u0000-\u001f\u007f]/.test(txnId)) fail('Invalid transaction identity.');
    const starts = [];
    rows.forEach((r,i) => { if (String(r[0] || '').trim().toUpperCase() === 'TXN' && String(r[1] || '') === txnId) starts.push(i); });
    if (starts.length !== 1) fail(starts.length ? 'Duplicate transaction IDs need review.' : 'Transaction was not found.');
    const start = starts[0]; let end = start + 1;
    while (end < rows.length && String(rows[end][0] || '').trim().toUpperCase() === 'ITEM' && String(rows[end][1] || '') === txnId) end++;
    if (end - start > 501) fail('Transaction is too large for customer completion.');
    // Q–V repeat the customer unjoined. Ledger hashes A:P only, so they stay outside the hash.
    const head = rows[start];
    if (!Array.isArray(head) || head.slice(22).some(v => v != null && v !== '')) fail('Unsupported transaction columns.');
    const raw = [cells(head.slice(0,16)), ...rows.slice(start + 1,end).map(cells)];
    if (!['receipt','invoice','quote'].includes(raw[0][14].toLowerCase())) fail('This transaction type needs review.');
    const customer = Array.from({ length: 6 }, (_, i) => String(head[16 + i] ?? '').trim());
    return { start, end, rows: raw, customer };
  }
  function event(row) {
    const r = cells(row);
    if (r[0] !== 'CUSTOMER_UPDATE' || !UUID.test(r[2]) || !HASH.test(r[3]) || !HASH.test(r[4]) || r[7] !== SCHEMA || r.slice(8).some(Boolean)
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r[6]) || !Number.isFinite(Date.parse(r[6]))) fail('Customer update needs review.');
    let contact; try { contact = JSON.parse(r[5]); } catch { fail('Customer update needs review.'); }
    validContact(contact);
    if (JSON.stringify(contact) !== r[5]) fail('Customer update encoding needs review.');
    return { row: r, id: r[2], source: r[3], base: r[4], contact };
  }
  async function resolve(rows, txnId, expectedHash = null) {
    const found = group(rows,txnId), sourceHash = await hash(found.rows);
    if (expectedHash !== null && expectedHash !== sourceHash) fail('Transaction changed. Refresh Ledger and open it again.');
    let contact = baseContact(found.rows[0], found.customer);
    let contactHash = await hash(found.rows[0].slice(4,8));
    const updates = rows.filter(r => r[0] === 'CUSTOMER_UPDATE' && String(r[1] || '') === txnId).map(event);
    if (updates.length > 1000) fail('Customer update history needs review.');
    const ids = new Map(), edges = new Map();
    for (const update of updates) {
      const raw = JSON.stringify(update.row);
      if (ids.has(update.id) && ids.get(update.id) !== raw) fail('Conflicting customer update identity.');
      ids.set(update.id, raw);
      if (update.source !== sourceHash) fail('Customer update belongs to an older transaction. Review is needed.');
      update.next = await hash(visibleContact(update.contact));
      const prior = edges.get(update.base);
      if (prior && JSON.stringify(prior.contact) !== JSON.stringify(update.contact)) fail('Two customer changes conflict. Review is needed.');
      edges.set(update.base, update);
    }
    const visited = new Set(); let applied = false;
    while (edges.has(contactHash)) {
      if (visited.has(contactHash)) fail('Customer update history contains a cycle.');
      visited.add(contactHash);
      const update = edges.get(contactHash); contact = update.contact; applied = true;
      if (update.next === contactHash) break;
      contactHash = update.next;
    }
    if ([...edges.keys()].some(base => !visited.has(base))) fail('Customer update history has a missing or conflicting predecessor.');
    return { ...found, txnId, sourceHash, contact, contactHash, applied, eventIds: [...ids.keys()] };
  }
  async function makeEvent(state, contact, eventId, occurredAt) {
    validContact(contact);
    if (await hash(visibleContact(contact)) === state.contactHash) fail('Customer details have not changed.');
    const row = ['CUSTOMER_UPDATE',state.txnId,eventId,state.sourceHash,state.contactHash,JSON.stringify(contact),occurredAt,SCHEMA];
    return event(row).row;
  }
  async function displayRows(rows) {
    const changed = new Set(rows.filter(r => r[0] === 'CUSTOMER_UPDATE').map(r => String(r[1] || '')));
    const result = rows.map(r => r.slice()), states = new Map();
    for (const id of changed) {
      try {
        const state = await resolve(rows,id);
        result[state.start] = state.rows[0].slice();
        result[state.start].splice(4,4,...visibleContact(state.contact));
        states.set(id,state);
      } catch (error) { states.set(id,{ conflict: true }); }
    }
    return { rows: result, states };
  }
  return Object.freeze({ SCHEMA, HANDOFF, cells, hash, validContact, visibleContact, baseContact, group, event, resolve, makeEvent, displayRows });
});
