'use strict';
// Every Ledger refusal code at the counter maps to one plain sentence; unknown codes name themselves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('const LEDGER_FIELD_MESSAGES');
const end = html.indexOf('async function finalizeLedgerInvoice(');
const sandbox = {};
vm.runInNewContext(html.slice(start, end) + ';this.m = ledgerFinalizeMessage;', sandbox);
const message = sandbox.m;

test('each known code has its own plain sentence', () => {
  const codes = ['pos_context_unavailable', 'ledger_unavailable', 'authentication_required', 'not_configured', 'invalid_request',
    'shape_invalid', 'customer_not_found', 'customer_not_adopted', 'customer_ambiguous', 'identity_invalid', 'formal_ineligible',
    'source_binding', 'release_unattested', 'local_integrity_uncertain', 'integrity_conflict',
    'csrf_failed', 'replay_collision', 'device_revoked', 'device_scope', 'device_not_set_up', 'unauthenticated', 'too_many_requests', 'too_many_attempts', 'forbidden_origin', 'untrusted_context'];
  const seen = new Set(codes.map(code => message(code)));
  assert.equal(seen.size, codes.length);   // invalid_credentials deliberately shares unauthenticated's sentence
  assert.equal(message('invalid_credentials'), message('unauthenticated'));
  assert.match(message('device_revoked'), /shut off in Ledger/);
  for (const code of codes) assert.doesNotMatch(message(code), /not confirmed|^Finalize failed/);
});

test('invalid_request names the failing field when Ledger supplies it', () => {
  assert.match(message('invalid_request', 'name_missing'), /name is empty/);
  for (const field of ['field_too_long', 'bad_character', 'bad_address', 'bad_provider_id'])
    assert.notEqual(message('invalid_request', field), message('invalid_request'));
});

test('unknown code appears in the sentence; copy warning only where a document may exist', () => {
  assert.match(message('weird_new_code'), /"weird_new_code"/);
  assert.doesNotMatch(message('pos_context_unavailable'), /another copy/);
  assert.doesNotMatch(message('customer_ambiguous'), /another copy/);
  assert.match(message('integrity_conflict'), /Do not press Finalize again/);
  assert.match(message('authentication_required'), /Set up this computer/);
  for (const c of ['csrf_failed', 'replay_collision', 'customer_name_reused']) assert.doesNotMatch(message(c), /^Finalize failed/);
});
