'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, 'ledger-finalization.js');
const sourceText = fs.readFileSync(helperPath, 'utf8');
const entryText = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  '../Ledger/fixtures/remainder_acceptance/finalization-contract-v1.json',
), 'utf8'));
const desktop = require('../POSDesktop/src/pos-finalization');
const helper = require('./ledger-finalization');

function clone(value) {
  return structuredClone(value);
}

function extractedHtmlText(html) {
  const entities = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'],
    ['#39', "'"], ['#64', '@'], ['nbsp', ' '],
  ]);
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|#64|nbsp);/g, token => (
      entities.get(token.slice(1, -1))
    ))
    .replace(/\s+/g, ' ')
    .trim();
}

function captureFromSource(source = fixture.source_facts) {
  return {
    schema: 'mpe-pos-c06-captured-draft-v1',
    schema_version: 1,
    source_client: clone(source.source_client),
    document: clone(source.document),
    customer: clone(source.customer),
    lines: clone(source.lines),
    totals: clone(source.totals),
    tender: clone(source.tender),
  };
}

function actionProposal(overrides = {}) {
  const initial = fixture.interface_vectors.prepare_context.initial.request;
  return {
    document_type: initial.document_type,
    completion_action: initial.completion_action,
    parent_source_event_id: initial.parent_source_event_id,
    parent_source_facts_sha256: initial.parent_source_facts_sha256,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    ...clone(fixture.interface_vectors.prepare_context.initial.result),
    ...overrides,
  };
}

function trustedContext(actionContext) {
  return {
    action_context: clone(actionContext),
    release_attestation: clone(fixture.release_attestation_vector.attestation),
    device_id: fixture.trusted_context.device_id,
    actor_id: fixture.trusted_context.actor_id,
  };
}

function enabledStatus() {
  return clone(fixture.interface_vectors.status.enabled);
}

function finalizedResult(request, overrides = {}) {
  const documentNumber = overrides.document_number || fixture.history_packet.allocation.document_number;
  return {
    allocation: {
      ...clone(fixture.history_packet.allocation),
      source_event_id: request.sourceEventId,
      source_content_sha256: request.qboCommandIntent.payload.source_facts_sha256,
      document_type: request.documentType,
      document_number: documentNumber,
      ...clone(overrides.allocation || {}),
    },
    qbo_command_intent: {
      ...clone(request.qboCommandIntent),
      official_document_number: documentNumber,
      ...clone(overrides.qbo_command_intent || {}),
    },
  };
}

function finalizedSourceResult(request, overrides = {}) {
  const source = clone(overrides.source_facts || fixture.source_facts);
  const documentNumber = overrides.official_document_number
    || fixture.history_packet.allocation.document_number;
  return {
    ...clone(fixture.interface_vectors.finalized_source.pending_result),
    source_event_id: request.source_event_id,
    source_transaction_id: source.source_transaction_id,
    document_type: source.document.type,
    source_facts: source,
    source_facts_sha256: request.source_facts_sha256,
    official_document_number: documentNumber,
    ...clone(overrides.result || {}),
  };
}

function ledgerOrderFromSourceForTest(source) {
  const [addr = '', city = ''] = source.customer.address.split('\n');
  return {
    customer: {
      name: source.customer.name, company: source.customer.company,
      addr, city, state: '', zip: '', phone: source.customer.phone,
      email: source.customer.email,
    },
    items: source.lines.map(line => ({
      pn: line.kind === 'note' ? 'Note' : line.part_number,
      desc: line.description,
      qty: line.quantity,
      ea: line.unit_amount,
      sub: line.line_total,
      sn: line.serials,
      originalEa: line.original_unit_amount,
      discountPerUnit: line.discount_amount,
    })),
    toggles: { cardFee: source.totals.card_fee !== '0.00' },
    ledgerTotals: clone(source.totals),
  };
}

function coordinatorWith(overrides = {}) {
  return helper.createOutputCoordinator({
    beginOutput: async () => { throw new Error('unexpected output begin'); },
    getStatus: async () => enabledStatus(),
    getFinalizedSource: async request => finalizedSourceResult(request),
    finishOutput: async () => { throw new Error('unexpected output finish'); },
    prepareContext: async () => context(),
    finalize: async request => finalizedResult(request),
    ...overrides,
  });
}

function expectCode(callback, code) {
  assert.throws(
    callback,
    error => error instanceof helper.LedgerFinalizationError && error.code === code,
    code,
  );
}

async function expectCodeAsync(callback, code) {
  await assert.rejects(
    callback,
    error => error instanceof helper.LedgerFinalizationError && error.code === code,
    code,
  );
}

function recursivelyFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every(item => recursivelyFrozen(item, seen));
}

test('builds the exact frozen initial action-context request', () => {
  const request = helper.buildActionContextRequest(actionProposal());
  assert.deepEqual(request, fixture.interface_vectors.prepare_context.initial.request);
  assert.equal(recursivelyFrozen(request), true);
});

test('builds source, hash, intent, and five-key request accepted by the real Desktop adapter', async () => {
  const actionContext = context();
  const request = await helper.buildFinalizationRequest(captureFromSource(), actionContext);
  assert.deepEqual(request.sourceSnapshot, fixture.source_facts);
  assert.equal(
    request.qboCommandIntent.payload.source_facts_sha256,
    fixture.expected.source_facts_sha256,
  );
  assert.deepEqual(Object.keys(request), [
    'schema', 'sourceEventId', 'documentType', 'sourceSnapshot', 'qboCommandIntent',
  ]);
  const expectedIntent = clone(fixture.history_packet.qbo_command_intent);
  delete expectedIntent.official_document_number;
  assert.deepEqual(request.qboCommandIntent, expectedIntent);
  const prepared = desktop.prepareC01Finalization(request, trustedContext(actionContext));
  assert.equal(prepared.source_facts_sha256, fixture.expected.source_facts_sha256);
  assert.deepEqual(prepared.source_facts, fixture.source_facts);
  assert.equal(recursivelyFrozen(request), true);
});

test('canonical bytes and WebCrypto hash match the frozen Desktop v3 domain', async () => {
  const bytes = helper.c06DesktopV3CanonicalBytes(fixture.source_facts);
  assert.equal(
    Buffer.from(bytes).toString('base64'),
    fixture.expected.source_facts_canonical_base64,
  );
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    fixture.expected.source_facts_sha256,
  );
  assert.deepEqual(
    Buffer.from(bytes),
    desktop.c06DesktopV3CanonicalBytes(fixture.source_facts),
  );
});

test('captured input is isolated before async hashing and only money negative zero normalizes', async () => {
  const captured = captureFromSource();
  captured.lines[0].discount_amount = '-0.00';
  captured.lines[0].line_rounding = '-0.00';
  captured.totals.card_fee = '-0.00';
  captured.totals.rounding = '-0.00';
  const promise = helper.buildFinalizationRequest(captured, context());
  captured.customer.name = 'MUTATED AFTER CALL';
  captured.lines[0].serials[0] = 'MUTATED';
  const request = await promise;
  assert.equal(request.sourceSnapshot.customer.name, fixture.source_facts.customer.name);
  assert.deepEqual(request.sourceSnapshot.lines[0].serials, fixture.source_facts.lines[0].serials);
  assert.equal(request.sourceSnapshot.lines[0].discount_amount, '0.00');
  assert.equal(request.sourceSnapshot.lines[0].line_rounding, '0.00');
  assert.equal(request.sourceSnapshot.totals.card_fee, '0.00');
  assert.equal(request.sourceSnapshot.totals.rounding, '0.00');
  assert.doesNotThrow(() => desktop.prepareC01Finalization(
    request,
    trustedContext(context()),
  ));
});

test('action matrix accepts only frozen representable pairs and parent pairs are atomic', () => {
  const allowed = {
    invoice: ['save_snapshot', 'print_snapshot', 'export_snapshot', 'reprint_snapshot', 'finalize_invoice'],
    quote: ['save_snapshot', 'print_snapshot', 'export_snapshot', 'reprint_snapshot', 'finalize_quote'],
    receipt: ['print_snapshot', 'reprint_snapshot', 'complete_sale'],
  };
  for (const [documentType, actions] of Object.entries(allowed)) {
    for (const completionAction of actions) {
      assert.deepEqual(
        helper.buildActionContextRequest(actionProposal({
          document_type: documentType,
          completion_action: completionAction,
        })).completion_action,
        completionAction,
      );
    }
  }
  for (const completionAction of ['save_snapshot', 'export_snapshot', 'finalize_invoice']) {
    expectCode(() => helper.buildActionContextRequest(actionProposal({
      document_type: 'receipt',
      completion_action: completionAction,
    })), 'action_unrepresentable');
  }
  expectCode(() => helper.buildActionContextRequest(actionProposal({
    parent_source_event_id: fixture.source_facts.source_event_id,
  })), 'source_binding');
  const descendant = fixture.interface_vectors.prepare_context.descendant_new_draft.request;
  assert.deepEqual(helper.buildActionContextRequest({
    document_type: descendant.document_type,
    completion_action: descendant.completion_action,
    parent_source_event_id: descendant.parent_source_event_id,
    parent_source_facts_sha256: descendant.parent_source_facts_sha256,
  }), descendant);
});

test('extra, missing, accessor, proxy, and malformed nested inputs fail without invoking accessors', async () => {
  const extra = captureFromSource();
  extra.extra = true;
  await expectCodeAsync(() => helper.buildFinalizationRequest(extra, context()), 'shape_invalid');

  const missing = captureFromSource();
  delete missing.totals.total;
  await expectCodeAsync(() => helper.buildFinalizationRequest(missing, context()), 'shape_invalid');

  let accessorCalls = 0;
  const accessor = captureFromSource();
  Object.defineProperty(accessor.customer, 'name', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error('/private/customer');
    },
  });
  await expectCodeAsync(() => helper.buildFinalizationRequest(accessor, context()), 'shape_invalid');
  assert.equal(accessorCalls, 0);

  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('/private/proxy'); },
  });
  await expectCodeAsync(() => helper.buildFinalizationRequest(hostile, context()), 'shape_invalid');

  const badLine = captureFromSource();
  badLine.lines[0].quantity = 1.25;
  await expectCodeAsync(() => helper.buildFinalizationRequest(badLine, context()), 'shape_invalid');
});

test('context action and lineage mismatches fail before hashing a request', async () => {
  await expectCodeAsync(() => helper.buildFinalizationRequest(
    captureFromSource(),
    context({ completion_action: 'complete_sale' }),
  ), 'action_unrepresentable');
  await expectCodeAsync(() => helper.buildFinalizationRequest(
    captureFromSource(),
    context({ parent_source_event_id: fixture.source_facts.source_event_id }),
  ), 'source_binding');
  await expectCodeAsync(() => helper.buildFinalizationRequest(
    captureFromSource(),
    context({ parent_source_facts_sha256: 'g'.repeat(64) }),
  ), 'source_binding');
});

test('strict v3 bytes reject floats, unsafe integers, negative zero numbers, cycles, and lone surrogates', () => {
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, -0, '\ud800']) {
    expectCode(() => helper.c06DesktopV3CanonicalBytes(value), 'integrity_conflict');
  }
  const cyclic = {};
  cyclic.self = cyclic;
  expectCode(() => helper.c06DesktopV3CanonicalBytes(cyclic), 'integrity_conflict');
});

test('browser VM exposes one frozen helper API and no forbidden runtime capability is present', () => {
  const sandbox = vm.createContext({
    crypto: crypto.webcrypto,
    TextEncoder,
    Uint8Array,
  });
  vm.runInContext(sourceText, sandbox, { filename: 'ledger-finalization.js' });
  const api = sandbox.MPELedgerFinalization;
  assert.ok(api);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), [
    'LedgerFinalizationError', 'buildActionContextRequest',
    'buildFinalizationRequest', 'c06DesktopV3CanonicalBytes',
    'createOutputCoordinator',
  ]);
  assert.equal(Object.keys(sandbox).includes('MPELedgerFinalization'), false);
  for (const forbidden of [
    /require\s*\(/,
    /node:/,
    /window\./,
    /\bdocument\.(?:addEventListener|body|cookie|createElement|getElementById|querySelector|querySelectorAll|write)\b/,
    /fetch\s*\(/,
    /XMLHttpRequest/,
    /ipcRenderer/,
    /localStorage/,
    /sessionStorage/,
    /randomUUID/,
    /writeFile/,
  ]) assert.doesNotMatch(sourceText, forbidden);
});

test('coordinator requires exactly six inert function capabilities', () => {
  const valid = {
    beginOutput: async () => {}, finalize: async () => {}, finishOutput: async () => {},
    getFinalizedSource: async () => {}, getStatus: async () => {},
    prepareContext: async () => {},
  };
  assert.doesNotThrow(() => helper.createOutputCoordinator(valid));
  for (const key of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[key];
    expectCode(() => helper.createOutputCoordinator(missing), 'shape_invalid');
  }
  expectCode(() => helper.createOutputCoordinator({ ...valid, extra: async () => {} }), 'shape_invalid');
  expectCode(() => helper.createOutputCoordinator({ ...valid, finalize: true }), 'shape_invalid');
  let accessorCalls = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'finalize', {
    enumerable: true,
    get() { accessorCalls += 1; return async () => {}; },
  });
  expectCode(() => helper.createOutputCoordinator(accessor), 'shape_invalid');
  assert.equal(accessorCalls, 0);
});

test('disabled coordinator preserves legacy output without capture, context, or allocation', async () => {
  const calls = [];
  const coordinator = coordinatorWith({
    getStatus: async () => {
      calls.push('status');
      return clone(fixture.interface_vectors.status.disabled);
    },
    prepareContext: async () => { calls.push('context'); },
    finalize: async () => { calls.push('finalize'); },
  });
  const result = await coordinator.preflight(actionProposal(), () => {
    calls.push('capture');
    return captureFromSource();
  });
  assert.deepEqual(result, { mode: 'legacy', reused: false });
  assert.deepEqual(calls, ['status']);
  assert.equal(coordinator.mode(), 'legacy');
  assert.equal(coordinator.current(), null);
});

test('enabled coordinator orders status, context, capture, durable finalize, and bounded result', async () => {
  const calls = [];
  const coordinator = coordinatorWith({
    getStatus: async () => { calls.push('status'); return enabledStatus(); },
    prepareContext: async request => {
      calls.push('context');
      assert.deepEqual(request, fixture.interface_vectors.prepare_context.initial.request);
      return context();
    },
    finalize: async request => { calls.push('finalize'); return finalizedResult(request); },
    getFinalizedSource: async request => {
      calls.push('source');
      return finalizedSourceResult(request);
    },
  });
  const result = await coordinator.preflight(actionProposal(), actionContext => {
    calls.push('capture');
    assert.deepEqual(actionContext, context());
    return captureFromSource();
  });
  assert.deepEqual(calls, ['status', 'context', 'capture', 'finalize', 'source']);
  assert.equal(result.mode, 'c06');
  assert.equal(result.reused, false);
  assert.equal(result.document_number, fixture.history_packet.allocation.document_number);
  assert.equal(result.source_facts_sha256, fixture.expected.source_facts_sha256);
  assert.equal(result.request.sourceSnapshot.completion.action, 'print_snapshot');
  assert.equal(recursivelyFrozen(result), true);
  assert.equal(coordinator.mode(), 'c06');
  assert.deepEqual(coordinator.current().allocation, result.allocation);
});

test('double click shares one in-flight commit and never allocates twice', async () => {
  let releaseFinalize;
  let noteFinalizeStarted;
  let finalizeCalls = 0;
  const blocked = new Promise(resolve => { releaseFinalize = resolve; });
  const finalizeStarted = new Promise(resolve => { noteFinalizeStarted = resolve; });
  const coordinator = coordinatorWith({
    finalize: async request => {
      finalizeCalls += 1;
      noteFinalizeStarted();
      await blocked;
      return finalizedResult(request);
    },
  });
  const first = coordinator.preflight(actionProposal(), () => captureFromSource());
  const second = coordinator.preflight(actionProposal(), () => captureFromSource());
  await finalizeStarted;
  assert.equal(finalizeCalls, 1);
  releaseFinalize();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(finalizeCalls, 1);
});

test('Save/Print/PDF retries reuse the first action, context, facts, and number', async () => {
  let contextCalls = 0;
  let finalizeCalls = 0;
  const coordinator = coordinatorWith({
    prepareContext: async () => { contextCalls += 1; return context(); },
    finalize: async request => { finalizeCalls += 1; return finalizedResult(request); },
  });
  const first = await coordinator.preflight(actionProposal(), () => captureFromSource());
  const replay = await coordinator.preflight(actionProposal({
    completion_action: 'export_snapshot',
  }), seen => {
    assert.equal(seen.completion_action, 'print_snapshot');
    return captureFromSource();
  });
  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(replay.request.sourceSnapshot.completion.action, 'print_snapshot');
  assert.equal(replay.document_number, first.document_number);
  assert.equal(contextCalls, 1);
  assert.equal(finalizeCalls, 1);
});

test('editing any frozen fact after commit refuses before a second allocation', async () => {
  let finalizeCalls = 0;
  const coordinator = coordinatorWith({
    finalize: async request => { finalizeCalls += 1; return finalizedResult(request); },
  });
  await coordinator.preflight(actionProposal(), () => captureFromSource());
  await expectCodeAsync(() => coordinator.preflight(actionProposal(), () => {
    const changed = captureFromSource();
    changed.customer.name = 'Changed after finalization';
    return changed;
  }), 'source_binding');
  assert.equal(finalizeCalls, 1);
});

test('a lost commit response clears only in-flight state and exact retry can replay', async () => {
  let finalizeCalls = 0;
  let contextCalls = 0;
  const requests = [];
  const coordinator = coordinatorWith({
    prepareContext: async () => {
      contextCalls += 1;
      if (contextCalls > 1) return context({
        source_event_id: '12121212-1212-4212-8212-121212121212',
      });
      return context();
    },
    finalize: async request => {
      finalizeCalls += 1;
      requests.push(clone(request));
      if (finalizeCalls === 1) {
        throw Object.assign(new Error('private transport detail'), { code: 'local_integrity_uncertain' });
      }
      return finalizedResult(request);
    },
  });
  await expectCodeAsync(
    () => coordinator.preflight(actionProposal(), () => captureFromSource()),
    'local_integrity_uncertain',
  );
  assert.equal(coordinator.current(), null);
  const retried = await coordinator.preflight(actionProposal(), () => captureFromSource());
  assert.equal(retried.document_number, fixture.history_packet.allocation.document_number);
  assert.equal(contextCalls, 1);
  assert.equal(finalizeCalls, 2);
  assert.deepEqual(requests[1], requests[0]);
});

test('enabled-but-unavailable, malformed status, and malformed finalize results fail closed', async () => {
  const unavailable = coordinatorWith({
    getStatus: async () => ({ enabled: true, available: false, reason: 'not_configured', capacity: [] }),
  });
  await expectCodeAsync(
    () => unavailable.preflight(actionProposal(), () => captureFromSource()),
    'not_configured',
  );
  const malformedStatus = coordinatorWith({
    getStatus: async () => ({ enabled: true, available: true, reason: null, capacity: [], extra: true }),
  });
  await expectCodeAsync(
    () => malformedStatus.preflight(actionProposal(), () => captureFromSource()),
    'integrity_conflict',
  );
  const malformedResult = coordinatorWith({
    finalize: async request => finalizedResult(request, {
      qbo_command_intent: { official_document_number: 'DIFFERENT-0001' },
    }),
  });
  await expectCodeAsync(
    () => malformedResult.preflight(actionProposal(), () => captureFromSource()),
    'integrity_conflict',
  );
});

test('receipt Save refuses before context/allocation and configured Gmail stays provider-gated', async () => {
  let contextCalls = 0;
  let finalizeCalls = 0;
  const coordinator = coordinatorWith({
    prepareContext: async () => { contextCalls += 1; return context(); },
    finalize: async request => { finalizeCalls += 1; return finalizedResult(request); },
  });
  await expectCodeAsync(() => coordinator.preflight(actionProposal({
    document_type: 'receipt',
    completion_action: 'save_snapshot',
  }), () => captureFromSource()), 'action_unrepresentable');
  assert.equal(contextCalls, 0);
  assert.equal(finalizeCalls, 0);
  await expectCodeAsync(() => coordinator.guardArtifact(), 'ledger_unavailable');

  const legacy = coordinatorWith({
    getStatus: async () => clone(fixture.interface_vectors.status.disabled),
  });
  assert.deepEqual(await legacy.guardArtifact(), { mode: 'legacy' });
});

test('configured output appends begin before production and records one terminal result', async () => {
  const vector = fixture.interface_vectors.output;
  const calls = [];
  const coordinator = coordinatorWith({
    beginOutput: async request => {
      calls.push(['begin', clone(request)]);
      return clone(vector.begin_result);
    },
    finishOutput: async request => {
      calls.push(['finish', clone(request)]);
      return clone(vector.attempt_goldens.failed_terminal.record);
    },
  });
  await coordinator.preflight(actionProposal(), () => captureFromSource());
  const begin = await coordinator.beginOutput('print');
  assert.deepEqual(begin, vector.begin_result);
  assert.equal(coordinator.outputPending(), true);
  const terminal = await coordinator.finishOutput('failed', 'output_failed');
  assert.deepEqual(terminal, vector.attempt_goldens.failed_terminal.record);
  assert.equal(coordinator.outputPending(), false);
  assert.deepEqual(calls, [
    ['begin', vector.begin_request],
    ['finish', vector.finish_failed_request],
  ]);
  assert.equal(coordinator.current().document_number, vector.begin_result.official_document_number);
});

test('concurrent output calls share one attempt and pin exact terminal replay', async () => {
  const vector = fixture.interface_vectors.output;
  let beginCalls = 0;
  let finishCalls = 0;
  let releaseBegin;
  let releaseFinish;
  const beginBlocked = new Promise(resolve => { releaseBegin = resolve; });
  const finishBlocked = new Promise(resolve => { releaseFinish = resolve; });
  const coordinator = coordinatorWith({
    beginOutput: async () => {
      beginCalls += 1;
      await beginBlocked;
      return clone(vector.begin_result);
    },
    finishOutput: async () => {
      finishCalls += 1;
      await finishBlocked;
      return clone(vector.attempt_goldens.failed_terminal.record);
    },
  });
  await coordinator.preflight(actionProposal(), () => captureFromSource());
  const firstBegin = coordinator.beginOutput('print');
  const secondBegin = coordinator.beginOutput('print');
  assert.equal(beginCalls, 1);
  assert.equal(coordinator.outputPending(), true);
  await expectCodeAsync(() => coordinator.beginOutput('pdf'), 'replay_collision');
  expectCode(() => coordinator.reset(), 'integrity_conflict');
  releaseBegin();
  assert.deepEqual(await firstBegin, await secondBegin);

  const firstFinish = coordinator.finishOutput('failed', 'output_failed');
  const secondFinish = coordinator.finishOutput('failed', 'output_failed');
  assert.equal(finishCalls, 1);
  await expectCodeAsync(
    () => coordinator.finishOutput('ambiguous', 'output_cancelled'),
    'replay_collision',
  );
  releaseFinish();
  const terminal = await firstFinish;
  assert.deepEqual(await secondFinish, terminal);
  assert.deepEqual(await coordinator.finishOutput('failed', 'output_failed'), terminal);
  assert.equal(finishCalls, 1);
  await expectCodeAsync(
    () => coordinator.finishOutput('ambiguous', 'output_cancelled'),
    'replay_collision',
  );
  assert.equal(coordinator.outputPending(), false);
});

test('an ambiguous output begin retries the exact same kind and never changes attempts', async () => {
  const vector = fixture.interface_vectors.output;
  let beginCalls = 0;
  const coordinator = coordinatorWith({
    beginOutput: async request => {
      beginCalls += 1;
      assert.deepEqual(request, vector.begin_request);
      if (beginCalls === 1) {
        throw Object.assign(new Error('lost local reply'), {
          code: 'local_integrity_uncertain',
        });
      }
      return clone(vector.begin_result);
    },
    finishOutput: async () => clone(vector.attempt_goldens.failed_terminal.record),
  });
  await coordinator.preflight(actionProposal(), () => captureFromSource());
  await expectCodeAsync(() => coordinator.beginOutput('print'), 'local_integrity_uncertain');
  assert.equal(coordinator.outputPending(), true);
  expectCode(() => coordinator.reset(), 'integrity_conflict');
  await expectCodeAsync(() => coordinator.beginOutput('pdf'), 'replay_collision');
  assert.equal(beginCalls, 1);
  assert.deepEqual(await coordinator.beginOutput('print'), vector.begin_result);
  assert.equal(beginCalls, 2);
  await coordinator.finishOutput('failed', 'output_failed');
  assert.equal(coordinator.outputPending(), false);
});

test('restart recovery reuses the exact source, number, and packet without status or allocation', async () => {
  const sourceVector = fixture.interface_vectors.finalized_source.pending_result;
  let retrievals = 0;
  let statusCalls = 0;
  let finalizeCalls = 0;
  const coordinator = coordinatorWith({
    getStatus: async () => { statusCalls += 1; return enabledStatus(); },
    getFinalizedSource: async request => {
      retrievals += 1;
      assert.deepEqual(request, fixture.interface_vectors.finalized_source.request);
      return clone(sourceVector);
    },
    finalize: async () => { finalizeCalls += 1; throw new Error('must not allocate'); },
  });
  const recovered = await coordinator.recover({
    source_event_id: sourceVector.source_event_id,
    source_facts_sha256: sourceVector.source_facts_sha256,
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.document_number, sourceVector.official_document_number);
  assert.equal(recovered.packet_sha256, sourceVector.packet_sha256);
  const replay = await coordinator.preflight(actionProposal({
    completion_action: 'reprint_snapshot',
  }), () => captureFromSource(sourceVector.source_facts));
  assert.equal(replay.reused, true);
  assert.equal(replay.source_event_id, sourceVector.source_event_id);
  assert.equal(retrievals, 1);
  assert.equal(statusCalls, 0);
  assert.equal(finalizeCalls, 0);

  await expectCodeAsync(() => coordinator.preflight(actionProposal({
    completion_action: 'reprint_snapshot',
  }), () => {
    const changed = captureFromSource(sourceVector.source_facts);
    changed.customer.name = 'Changed after restart';
    return changed;
  }), 'source_binding');
  assert.equal(finalizeCalls, 0);
});

test('restart recovery also reuses an exact descendant version without allocation', async () => {
  const issued = fixture.interface_vectors.prepare_context.descendant_new_draft.issued;
  const parent = fixture.interface_vectors.prepare_context.descendant_new_draft.parent_state;
  const source = clone(fixture.source_facts);
  source.source_event_id = issued.source_event_id;
  source.source_transaction_id = issued.source_transaction_id;
  source.recorded_at = issued.recorded_at;
  source.completion.at = issued.completion_at;
  source.lineage = {
    parent_source_event_id: parent.source_event_id,
    parent_entity_id: parent.entity_id,
    parent_revision: parent.revision,
  };
  const sourceHash = crypto.createHash('sha256')
    .update(helper.c06DesktopV3CanonicalBytes(source)).digest('hex');
  let statusCalls = 0;
  let finalizeCalls = 0;
  const coordinator = coordinatorWith({
    getStatus: async () => { statusCalls += 1; return enabledStatus(); },
    getFinalizedSource: async request => finalizedSourceResult(request, {
      source_facts: source,
      official_document_number: 'INV-004202',
    }),
    finalize: async () => { finalizeCalls += 1; throw new Error('must not allocate'); },
  });
  const recovered = await coordinator.recover({
    source_event_id: source.source_event_id,
    source_facts_sha256: sourceHash,
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.document_number, 'INV-004202');
  assert.deepEqual(recovered.source_facts.lineage, source.lineage);
  const replay = await coordinator.preflight(actionProposal({
    completion_action: 'reprint_snapshot',
  }), () => captureFromSource(source));
  assert.equal(replay.reused, true);
  assert.equal(replay.source_event_id, source.source_event_id);
  assert.equal(statusCalls, 0);
  assert.equal(finalizeCalls, 0);
});

test('restart recovery rejects a self-hashed source with an invalid completion action', async () => {
  const source = clone(fixture.source_facts);
  source.completion.action = { hostile: true };
  const sourceHash = crypto.createHash('sha256')
    .update(helper.c06DesktopV3CanonicalBytes(source)).digest('hex');
  const coordinator = coordinatorWith({
    getFinalizedSource: async request => finalizedSourceResult(request, {
      source_facts: source,
    }),
  });
  await expectCodeAsync(() => coordinator.recover({
    source_event_id: source.source_event_id,
    source_facts_sha256: sourceHash,
  }), 'integrity_conflict');
});

test('output completion rejects a self-consistent-looking record with a forged hash', async () => {
  const vector = fixture.interface_vectors.output;
  const forged = clone(vector.attempt_goldens.failed_terminal.record);
  forged.output_attempt_sha256 = '0'.repeat(64);
  const coordinator = coordinatorWith({
    beginOutput: async () => clone(vector.begin_result),
    finishOutput: async () => forged,
  });
  await coordinator.preflight(actionProposal(), () => captureFromSource());
  await coordinator.beginOutput('print');
  await expectCodeAsync(
    () => coordinator.finishOutput('failed', 'output_failed'),
    'integrity_conflict',
  );
  assert.equal(coordinator.outputPending(), true);
  expectCode(() => coordinator.reset(), 'integrity_conflict');
});

test('actual POS capture preserves DOM order, exact displayed facts, serials, and stable row IDs', () => {
  const start = entryText.indexOf('function ledgerMoneyText');
  const end = entryText.indexOf('function ledgerActionProposal', start);
  assert.ok(start > 0 && end > start);
  const ids = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const itemRow = {
    dataset: { row: '0' },
    hasAttribute: name => name === 'data-row',
    querySelector: selector => selector === '.part-input' ? { value: ' PART-1 ' } : null,
  };
  const serialRow = {
    dataset: { snFor: '0' },
    hasAttribute: name => name === 'data-sn-for',
  };
  const noteRow = {
    dataset: { noteRow: 'note-0' },
    hasAttribute: name => name === 'data-note-row',
  };
  const priceInput = { value: '10.00' };
  const elements = {
    'desc-0': { textContent: ' Repair service ', querySelector: () => null },
    'price-0': {
      dataset: { price: '10', originalEa: '12', discountPerUnit: '2' },
      querySelector: selector => selector === '.price-edit' ? priceInput : null,
    },
    'qty-0': { value: '2' },
    'sub-0': { tagName: 'SPAN', textContent: '20.00' },
    'note-0-desc': { value: ' Call before pickup ' },
    'note-0-price': { value: '', dataset: {} },
    custName: { value: ' Kimo ' }, custCompany: { value: ' Test Co. ' },
    custPhone: { value: ' 808-555-0100 ' }, custEmail: { value: ' kimo@example.invalid ' },
    custAddr: { value: ' 123 Test Way ' }, custCity: { value: ' Wailuku ' },
    custState: { value: ' HI ' }, custZip: { value: ' 96793 ' },
    sumSubtotal: { textContent: '20.00' }, sumCardFee: { textContent: '0.00' },
    sumTax: { textContent: '0.94' }, sumTotal: { textContent: '20.94' },
    tenderType: { value: '' }, tenderReference: { value: '', disabled: true },
  };
  const sandbox = {
    Date,
    Object,
    String,
    Number,
    WeakMap,
    Array,
    globalThis: null,
    window: null,
    crypto: { randomUUID: () => ids.shift() },
    MPELedgerFinalization: helper,
    _ledgerLineIds: new WeakMap(),
    _docType: 'invoice',
    _ledgerDraftCustomerBinding: null,
    _ledgerAdoptedCustomer: null,
    _ledgerConversion: null,
    POS_RELEASE: '2026.09.05.2',
    tbody: {
      children: [itemRow, serialRow, noteRow],
      querySelector: selector => selector === 'tr[data-sn-for="0"]' ? {
        querySelectorAll: () => [{ value: ' SN-1 ' }, { value: '' }, { value: 'SN-2' }],
      } : null,
    },
    document: { getElementById: id => elements[id] || null },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(start, end), sandbox, { filename: 'POS-capture.js' });
  const actionContext = context();
  const first = sandbox.captureLedgerFinalizationDraft(actionContext);
  const second = sandbox.captureLedgerFinalizationDraft(actionContext);
  assert.deepEqual(clone(first), {
    schema: 'mpe-pos-c06-captured-draft-v1',
    schema_version: 1,
    source_client: { system: 'mpe-pos', app_version: '2026.09.05.2' },
    document: {
      type: 'invoice', due_date: '2026-10-05', linked_quote_event_id: null,
      original_source_display_number: null,
    },
    customer: {
      customer_id: null, identity_kind: 'native', adoption_proof: null,
      anonymous: false, name: 'Kimo', company: 'Test Co.', phone: '808-555-0100',
      email: 'kimo@example.invalid', address: '123 Test Way\nWailuku, HI, 96793',
    },
    lines: [{
      line_id: '33333333-3333-4333-8333-333333333333', kind: 'item',
      part_number: 'PART-1', description: 'Repair service', quantity: '2',
      original_unit_amount: '12.00', discount_amount: '2.00', unit_amount: '10.00',
      line_rounding: '0.00', line_total: '20.00', serials: ['SN-1', 'SN-2'],
    }, {
      line_id: '44444444-4444-4444-8444-444444444444', kind: 'note',
      part_number: '', description: 'Call before pickup', quantity: null,
      original_unit_amount: null, discount_amount: null, unit_amount: null,
      line_rounding: null, line_total: null, serials: [],
    }],
    totals: {
      currency: 'USD', subtotal: '20.00', card_fee: '0.00', tax: '0.94',
      rounding: '0.00', total: '20.94',
    },
    tender: { type: 'none', reference: null },
  });
  assert.equal(second.lines[0].line_id, first.lines[0].line_id);
  assert.equal(second.lines[1].line_id, first.lines[1].line_id);

  for (const id of [
    'custName', 'custCompany', 'custPhone', 'custEmail', 'custAddr',
    'custCity', 'custState', 'custZip',
  ]) elements[id].value = '';
  sandbox._docType = 'receipt';
  expectCode(() => sandbox.captureLedgerFinalizationDraft(actionContext), 'tender_invalid');
  elements.tenderType.value = 'cash';
  elements.tenderReference.value = ' Drawer 2 ';
  const anonymous = sandbox.captureLedgerFinalizationDraft(actionContext);
  assert.equal(anonymous.customer.anonymous, true);
  assert.equal(anonymous.customer.identity_kind, 'anonymous');
  assert.deepEqual(clone(anonymous.tender), { type: 'cash', reference: 'Drawer 2' });

  elements.tenderType.value = 'wire';
  expectCode(() => sandbox.captureLedgerFinalizationDraft(actionContext), 'tender_invalid');
  elements.tenderType.value = 'cash';

  elements['note-0-price'].value = '1.00';
  expectCode(() => sandbox.captureLedgerFinalizationDraft(actionContext), 'money_invalid');
});

test('actual POS keeps explicit tender receipt-only and restores the frozen value', () => {
  assert.equal(entryText.split('id="tenderPanel"').length - 1, 1);
  assert.equal(entryText.split('id="tenderType"').length - 1, 1);
  assert.equal(entryText.split('id="tenderReference"').length - 1, 1);
  assert.match(entryText, /const RECEIPT_TENDER_TYPES = new Set\(\['cash', 'check', 'card', 'ach', 'customer_credit'\]\)/);

  const clear = entryText.slice(entryText.indexOf('function clearAll'), entryText.indexOf('const REVIEW_QR_SVG'));
  const capture = entryText.slice(entryText.indexOf('function captureLedgerFinalizationDraft'), entryText.indexOf('function captureRecoveredLedgerFinalizationDraft'));
  const docType = entryText.slice(entryText.indexOf('window.setDocType = function'), entryText.indexOf('function pad2'));
  const reprint = entryText.slice(entryText.indexOf('async function reprintOrder'), entryText.indexOf('// ─── CUSTOMER FIELDS'));
  const clover = entryText.slice(entryText.indexOf('async function chargeCardOnTerminal'), entryText.indexOf('async function retryCardTerminal'));

  assert.match(clear, /resetTenderUi\(\)/);
  assert.match(capture, /!RECEIPT_TENDER_TYPES\.has\(tender\.type\)[\s\S]*refusal\('tender_invalid'\)/);
  assert.match(capture, /tender,\s*\n\s*};/);
  assert.match(docType, /syncTenderUi\(\)/);
  assert.match(reprint, /type\.value = RECEIPT_TENDER_TYPES\.has\(order\.tender\?\.type\)/);
  assert.match(reprint, /reference\.value = order\.tender\?\.reference \|\| ''/);
  assert.match(clover, /tenderType\.value = 'card'/);
  assert.match(clover, /Clover \$\{reference\}/);
  assert.match(entryText, /\.cust-bar, \.tender-bar, \.file-bar/);
});

test('actual guarded seam awaits local output begin and blocks output after history/begin failure', async () => {
  const start = entryText.indexOf('// Finalize the order before opening the native print sheet.');
  const end = entryText.indexOf('function serializedPrintDocument', start);
  assert.ok(start > 0 && end > start);
  const events = [];
  let releaseBegin;
  const beginBlocked = new Promise(resolve => { releaseBegin = resolve; });
  let historyResult = true;
  let beginError = null;
  let preflightError = null;
  let sourceMutated = false;
  let preflightCalls = 0;
  const inert = new Set();
  const documentElement = {
    hasAttribute: name => inert.has(name),
    setAttribute: name => inert.add(name),
    removeAttribute: name => inert.delete(name),
  };
  const coordinator = {
    current: () => ({ mode: 'c06', document_number: 'INV-004201' }),
    beginOutput: async kind => {
      events.push(`begin:${kind}`);
      await beginBlocked;
      if (beginError) throw beginError;
      return { state: 'committed_for_output' };
    },
  };
  const sandbox = {
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    window: { MPELedgerFinalization: helper },
    document: { body: { dataset: {} }, documentElement, getElementById: () => null },
    _docType: 'invoice',
    _currentTxnId: null,
    _scannerModeActive: false,
    _scannerModeDefault: false,
    _ledgerOutputCoordinator: coordinator,
    _preparedPrintHtml: null,
    lockLedgerOutputUi: () => documentElement.setAttribute('inert', ''),
    releaseLedgerOutputUi: () => documentElement.removeAttribute('inert'),
    releasePhysicalOutput: () => {},
    commitActiveBridgeDraft: () => events.push('commit-editor'),
    preflightLedgerOutput: async () => {
      events.push('preflight');
      preflightCalls += 1;
      if (preflightError) throw preflightError;
      if (sourceMutated && preflightCalls % 2 === 0) {
        throw new helper.LedgerFinalizationError('source_binding');
      }
      return { mode: 'c06', recovered: false, document_number: 'INV-004201' };
    },
    preparePrint: () => events.push('prepare-print'),
    cleanupPrint: () => events.push('cleanup-print'),
    renewOnPrint: () => events.push('renew'),
    flushPendingPriceChanges: () => {},
    saveToHistory: () => { events.push('history'); return historyResult; },
    updatePriceChangesBadge: () => {},
    queueStockFinalForOutput: () => {},
    flushStockSessionQueue: () => {},
    updateScreenDocTitle: () => events.push('screen-title'),
    showPrintBanner: () => {},
    flashScanCommand: () => {},
    noteToolFailure: () => {},
    ledgerErrorCode: error => error.code || 'integrity_conflict',
    ledgerRefusalError: code => new helper.LedgerFinalizationError(code),
    serializedPrintDocument: () => '<!doctype html><html></html>',
  };
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(start, end), sandbox, { filename: 'POS-output-seam.js' });

  const pending = vm.runInContext(
    "prepareAndSaveForPrint('print_snapshot', { outputKind: 'print' })",
    sandbox,
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [
    'commit-editor', 'preflight', 'prepare-print', 'commit-editor', 'renew',
    'history', 'begin:print',
  ]);
  let resolved = false;
  pending.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  await expectCodeAsync(
    () => vm.runInContext(
      "prepareAndSaveForPrint('save_snapshot', { prepareOutput: false })",
      sandbox,
    ),
    'replay_collision',
  );
  assert.equal(events.filter(event => event === 'preflight').length, 1);
  assert.equal(events.filter(event => event === 'history').length, 1);
  assert.equal(events.filter(event => event === 'begin:print').length, 1);
  assert.equal(inert.has('inert'), true, 'configured output freezes the editable page before waiting');
  releaseBegin();
  await pending;
  assert.equal(resolved, true);
  assert.equal(events.filter(event => event === 'preflight').length, 2);
  assert.equal(vm.runInContext('_printPrepared', sandbox), true);
  sandbox.releaseLedgerOutputUi();

  vm.runInContext('_printPrepared = false', sandbox);
  historyResult = false;
  await expectCodeAsync(
    () => vm.runInContext(
      "prepareAndSaveForPrint('print_snapshot', { outputKind: 'print' })",
      sandbox,
    ),
    'output_failed',
  );
  assert.equal(events.filter(event => event === 'begin:print').length, 1);
  assert.equal(vm.runInContext('_printPrepared', sandbox), false);

  events.length = 0;
  historyResult = true;
  preflightError = new helper.LedgerFinalizationError('not_configured');
  await expectCodeAsync(
    () => vm.runInContext(
      "prepareAndSaveForPrint('print_snapshot', { outputKind: 'print' })",
      sandbox,
    ),
    'not_configured',
  );
  assert.deepEqual(events, ['commit-editor', 'preflight', 'cleanup-print']);
  assert.equal(vm.runInContext('_printPrepared', sandbox), false);
});

test('configured output refuses a DOM mutation that occurs while local begin is pending', async () => {
  const start = entryText.indexOf('// Finalize the order before opening the native print sheet.');
  const end = entryText.indexOf('function serializedPrintDocument', start);
  let mutated = false;
  let releaseBegin;
  let captures = 0;
  const beginBlocked = new Promise(resolve => { releaseBegin = resolve; });
  const inert = new Set();
  const documentElement = {
    hasAttribute: name => inert.has(name),
    setAttribute: name => inert.add(name),
    removeAttribute: name => inert.delete(name),
  };
  const sandbox = {
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    window: { MPELedgerFinalization: helper },
    document: { body: { dataset: {} }, documentElement, getElementById: () => null },
    _docType: 'invoice',
    _currentTxnId: null,
    _scannerModeActive: false,
    _scannerModeDefault: false,
    _ledgerOutputCoordinator: {
      current: () => ({ mode: 'c06', document_number: 'INV-004201' }),
      beginOutput: async () => beginBlocked,
    },
    _preparedPrintHtml: null,
    lockLedgerOutputUi: () => documentElement.setAttribute('inert', ''),
    releaseLedgerOutputUi: () => documentElement.removeAttribute('inert'),
    releasePhysicalOutput: () => {},
    commitActiveBridgeDraft: () => {},
    preflightLedgerOutput: async () => {
      captures += 1;
      if (captures === 2 && mutated) throw new helper.LedgerFinalizationError('source_binding');
      return { mode: 'c06', recovered: false, document_number: 'INV-004201' };
    },
    preparePrint: () => {},
    cleanupPrint: () => documentElement.removeAttribute('inert'),
    renewOnPrint: () => {},
    flushPendingPriceChanges: () => {},
    saveToHistory: () => true,
    updatePriceChangesBadge: () => {},
    queueStockFinalForOutput: () => {},
    flushStockSessionQueue: () => {},
    updateScreenDocTitle: () => {},
    showPrintBanner: () => {},
    flashScanCommand: () => {},
    noteToolFailure: () => {},
    ledgerErrorCode: error => error.code || 'integrity_conflict',
    ledgerRefusalError: code => new helper.LedgerFinalizationError(code),
    serializedPrintDocument: () => { throw new Error('changed source must not be snapshotted'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(start, end), sandbox, { filename: 'POS-output-mutation.js' });

  const pending = vm.runInContext(
    "prepareAndSaveForPrint('print_snapshot', { outputKind: 'print' })",
    sandbox,
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inert.has('inert'), true);
  mutated = true;
  releaseBegin();
  await expectCodeAsync(() => pending, 'source_binding');
  assert.equal(captures, 2);
  assert.equal(inert.has('inert'), false);
  assert.equal(vm.runInContext('_printPrepared', sandbox), false);
});

test('the actual output UI lock is idempotent and restores prior inert state', () => {
  const start = entryText.indexOf('let _ledgerOutputUiLock = null;');
  const end = entryText.indexOf('function cleanupPrint', start);
  const attributes = new Set();
  const root = {
    hasAttribute: name => attributes.has(name),
    setAttribute: name => attributes.add(name),
    removeAttribute: name => attributes.delete(name),
  };
  const sandbox = { document: { documentElement: root } };
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(start, end), sandbox, { filename: 'POS-output-ui-lock.js' });
  vm.runInContext('lockLedgerOutputUi(); lockLedgerOutputUi()', sandbox);
  assert.equal(attributes.has('inert'), true);
  vm.runInContext('releaseLedgerOutputUi()', sandbox);
  assert.equal(attributes.has('inert'), false);

  attributes.add('inert');
  vm.runInContext('lockLedgerOutputUi(); releaseLedgerOutputUi()', sandbox);
  assert.equal(attributes.has('inert'), true, 'a pre-existing inert state is preserved');
});

test('Manual and Auto share one physical-output mutex in both race directions', async () => {
  const stateStart = entryText.indexOf('let _printPrepared = false;');
  const stateEnd = entryText.indexOf('function recordOutgoingDocument', stateStart);
  const manualStart = entryText.indexOf('async function manualPrint');
  const autoEnd = entryText.indexOf("window.addEventListener('beforeprint'", manualStart);
  const code = entryText.slice(stateStart, stateEnd) + entryText.slice(manualStart, autoEnd);
  let releasePreparation;
  let preparations = 0;
  let manualOutputs = 0;
  let autoOutputs = 0;
  const nextPreparation = () => new Promise(resolve => { releasePreparation = resolve; });
  let preparation = nextPreparation();
  const sandbox = {
    Object,
    Promise,
    Date,
    console,
    performance: { now: () => 1 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    _currentTxnId: '',
    _scannerModeActive: false,
    _scannerModeDefault: false,
    _scannerModeAwaitingClear: false,
    _preparedPrintHtml: '<!doctype html><html></html>',
    document: { getElementById: () => null },
    window: {
      print: () => { manualOutputs += 1; },
      mpeDesktop: {
        printReceipt: async () => {
          autoOutputs += 1;
          return { ok: true, timings: null };
        },
      },
    },
    prepareAndSaveForPrint: async () => {
      preparations += 1;
      await preparation;
      return { mode: 'c06' };
    },
    finishLedgerOutput: async () => true,
    cleanupPrint: () => {},
    showLedgerRefusal: () => {},
    clearToolFailure: () => {},
    flashScanCommand: () => {},
    noteToolFailure: () => {},
    showPrintBanner: () => {},
    setScannerModeActive: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'POS-output-mutex.js' });

  const manual = vm.runInContext('manualPrint()', sandbox);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext('autoPrint()', sandbox);
  assert.equal(preparations, 1);
  assert.equal(manualOutputs, 0);
  assert.equal(autoOutputs, 0);
  releasePreparation();
  await manual;
  assert.equal(manualOutputs, 1);
  assert.equal(autoOutputs, 0);
  assert.notEqual(vm.runInContext('_physicalOutputInFlight', sandbox), null);
  vm.runInContext(
    'releasePhysicalOutput(_browserPrintLifecycle.physicalOutputOwner); _browserPrintLifecycle = null;',
    sandbox,
  );

  preparation = nextPreparation();
  const auto = vm.runInContext('autoPrint()', sandbox);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext('manualPrint()', sandbox);
  assert.equal(preparations, 2);
  assert.equal(manualOutputs, 1);
  assert.equal(autoOutputs, 0);
  releasePreparation();
  await auto;
  assert.equal(manualOutputs, 1);
  assert.equal(autoOutputs, 1);
});

test('Manual keeps physical-output ownership through pending afterprint audit and blocks scanner Auto', async () => {
  const stateStart = entryText.indexOf('let _printPrepared = false;');
  const stateEnd = entryText.indexOf('function recordOutgoingDocument', stateStart);
  const manualStart = entryText.indexOf('async function manualPrint');
  const autoEnd = entryText.indexOf("window.addEventListener('beforeprint'", manualStart);
  const afterStart = entryText.indexOf("window.addEventListener('afterprint'", autoEnd);
  const afterEnd = entryText.indexOf("document.addEventListener('keydown'", afterStart);
  const code = entryText.slice(stateStart, stateEnd)
    + entryText.slice(manualStart, autoEnd)
    + entryText.slice(afterStart, afterEnd);
  let afterprint = null;
  let releaseFinish;
  const finishBlocked = new Promise(resolve => { releaseFinish = resolve; });
  let preparations = 0;
  let manualOutputs = 0;
  let autoOutputs = 0;
  let finishCalls = 0;
  let cleanups = 0;
  const classes = new Set();
  const sandbox = {
    Object,
    Promise,
    Date,
    console,
    performance: { now: () => 1 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    _currentTxnId: '',
    _scannerModeActive: false,
    _scannerModeDefault: false,
    _scannerModeAwaitingClear: false,
    _preparedPrintHtml: '<!doctype html><html></html>',
    document: {
      getElementById: () => null,
      body: {
        classList: {
          contains: name => classes.has(name),
          remove: name => classes.delete(name),
        },
      },
      addEventListener: () => {},
    },
    window: {
      addEventListener: (name, handler) => { if (name === 'afterprint') afterprint = handler; },
      print: () => {
        manualOutputs += 1;
        afterprint();
      },
      mpeDesktop: {
        printReceipt: async () => {
          autoOutputs += 1;
          return { ok: true, timings: null };
        },
      },
    },
    prepareAndSaveForPrint: async () => {
      preparations += 1;
      vm.runInContext('_printPrepared = true', sandbox);
      return { mode: 'c06' };
    },
    finishLedgerOutput: async () => {
      finishCalls += 1;
      await finishBlocked;
      return true;
    },
    cleanupPrint: () => { cleanups += 1; },
    showLedgerRefusal: () => {},
    clearToolFailure: () => {},
    flashScanCommand: () => {},
    noteToolFailure: () => {},
    showPrintBanner: () => {},
    setScannerModeActive: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'POS-manual-afterprint-lifecycle.js' });

  await vm.runInContext('manualPrint()', sandbox);
  assert.equal(manualOutputs, 1);
  assert.equal(finishCalls, 1);
  assert.equal(vm.runInContext('_printPrepared', sandbox), true);
  assert.notEqual(vm.runInContext('_physicalOutputInFlight', sandbox), null);

  // Scanner PRINT calls autoPrint(), so this directly exercises its guarded route.
  await vm.runInContext('autoPrint()', sandbox);
  assert.equal(preparations, 1, 'the pending attempt is not borrowed');
  assert.equal(autoOutputs, 0, 'no second physical output dispatches');

  const completion = vm.runInContext('_afterPrintCompletion', sandbox);
  releaseFinish();
  await completion;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanups, 1);
  assert.equal(vm.runInContext('_printPrepared', sandbox), false);
  assert.equal(vm.runInContext('_physicalOutputInFlight', sandbox), null);
});

test('actual POS refuses configured output when the verified helper is missing', async () => {
  const start = entryText.indexOf('async function preflightLedgerOutput');
  const end = entryText.indexOf('(() => {', start);
  const sandbox = {
    Object,
    _docType: 'invoice',
    _ledgerOutputCoordinator: null,
    _reprintSource: null,
    window: { mpeDesktop: { numbering: {} } },
    ledgerRefusalError: code => new helper.LedgerFinalizationError(code),
  };
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(start, end), sandbox, { filename: 'POS-preflight-guard.js' });
  await expectCodeAsync(
    () => vm.runInContext("preflightLedgerOutput('print_snapshot')", sandbox),
    'release_unattested',
  );
  sandbox.window.mpeDesktop = null;
  assert.deepEqual(
    clone(await vm.runInContext("preflightLedgerOutput('print_snapshot')", sandbox)),
    { mode: 'legacy', reused: false },
  );
});

test('Invoice and Quote Bill-to content precedes items and handles company-only escaped facts once', () => {
  const billStart = entryText.indexOf('function buildBillTo');
  const billEnd = entryText.indexOf('let _printMoneySnapshot', billStart);
  const source = clone(fixture.source_facts);
  source.customer.name = 'Kimo <Test>';
  source.customer.company = 'A & B';
  const elements = {};
  const sandbox = {
    String,
    _docType: 'invoice',
    _ledgerOutputCoordinator: { current: () => ({ source_facts: source }) },
    document: { getElementById: id => elements[id] || null },
  };
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(billStart, billEnd), sandbox, { filename: 'POS-bill-to.js' });
  const html = vm.runInContext('buildBillTo()', sandbox);
  assert.equal((html.match(/Bill to/g) || []).length, 1);
  assert.match(html, /Kimo &lt;Test&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /123 TEST WAY/);
  assert.match(html, /HONOLULU, HI 96813/);
  assert.match(html, /808-555-0100/);
  assert.match(html, /fixture@example\.invalid/);
  assert.doesNotMatch(vm.runInContext('buildInvoiceSig()', sandbox), /Billed to|Send invoice to/);

  const titleAt = entryText.indexOf('<div class="print-titlerow">');
  const billAt = entryText.indexOf('<div class="print-bill-to" id="printBillTo">');
  const itemsAt = entryText.indexOf('<table class="search-table">', titleAt);
  assert.ok(titleAt < billAt && billAt < itemsAt);

  const pdfStart = entryText.indexOf('function buildEmailDocHTML');
  const pdfEnd = entryText.indexOf('// Shared by the Email attachment', pdfStart);
  const pdfSandbox = {
    String,
    Number,
    _docType: 'invoice',
    PDF_INK: '#111111', PDF_LINE: '#d7d7d7', PDF_GREEN: '#2f4339',
    _pdfLogoSrc: () => '',
    checkoutTotals: () => ({ tax: 0, cardFee: 0, total: 0 }),
    document: { getElementById: () => null },
  };
  vm.createContext(pdfSandbox);
  vm.runInContext(entryText.slice(pdfStart, pdfEnd), pdfSandbox, { filename: 'POS-pdf-bill-to.js' });
  const order = ledgerOrderFromSourceForTest(source);
  const buildPdf = vm.runInContext('buildEmailDocHTML', pdfSandbox);
  for (const [documentType, title] of [['invoice', 'Invoice'], ['quote', 'Quote']]) {
    pdfSandbox._docType = documentType;
    const fullPdf = buildPdf(
      order,
      title,
      fixture.history_packet.allocation.document_number,
      'September 5, 2026',
    );
    const fullText = extractedHtmlText(fullPdf);
    const orderedText = [
      title,
      fixture.history_packet.allocation.document_number,
      'BILL TO',
      source.customer.name,
      source.customer.company,
      ...source.customer.address.split('\n'),
      source.customer.phone,
      source.customer.email,
      'Product',
      'Subtotal',
      'Total',
      'Mahalo for your business!',
    ];
    let prior = -1;
    for (const expected of orderedText) {
      const found = fullText.indexOf(expected, prior + 1);
      assert.ok(found > prior, `${documentType}: ${expected} is retained in output order`);
      prior = found;
    }
    for (const expected of [
      'BILL TO', source.customer.name, source.customer.company,
      ...source.customer.address.split('\n'), source.customer.phone, source.customer.email,
    ]) {
      assert.equal(fullText.split(expected).length - 1, 1, `${documentType}: ${expected} appears once`);
    }

    const companyOnly = clone(order);
    companyOnly.customer = {
      name: '', company: 'Solo <Maui> & Co.', addr: '', city: '', state: '', zip: '',
      phone: '', email: '',
    };
    const pdf = buildPdf(
      companyOnly,
      title,
      fixture.history_packet.allocation.document_number,
      'September 5, 2026',
    );
    assert.equal((pdf.match(/BILL TO/g) || []).length, 1, documentType);
    assert.equal((pdf.match(/Solo &lt;Maui&gt; &amp; Co\./g) || []).length, 1, documentType);
    assert.ok(pdf.indexOf('BILL TO') < pdf.indexOf('<table'), documentType);
    assert.ok(pdf.indexOf('<table') < pdf.indexOf('Subtotal'), documentType);
    assert.doesNotMatch(pdf, />undefined<|>null</, documentType);

    const longAddress = clone(companyOnly);
    longAddress.customer.addr = '123 Very Long <Road> & Industrial Park '.repeat(5).trim();
    const longPdf = buildPdf(
      longAddress,
      title,
      fixture.history_packet.allocation.document_number,
      'September 5, 2026',
    );
    assert.match(longPdf, /123 Very Long &lt;Road&gt; &amp; Industrial Park/, documentType);

    const absent = clone(companyOnly);
    absent.customer.company = '';
    const absentPdf = buildPdf(
      absent,
      title,
      fixture.history_packet.allocation.document_number,
      'September 5, 2026',
    );
    assert.doesNotMatch(absentPdf, /BILL TO/, documentType);
  }
});

test('actual preparePrint executes the one/two-copy matrix without duplicating Invoice or Quote Bill-to', () => {
  const printStart = entryText.indexOf('function buildBillTo');
  const printEnd = entryText.indexOf('let _ledgerOutputUiLock', printStart);
  const makeClassList = (...initial) => {
    const values = new Set(initial);
    return {
      add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      contains: name => values.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !values.has(name) : !!force;
        if (enabled) values.add(name);
        else values.delete(name);
        return enabled;
      },
    };
  };
  const makeElement = (value = '') => ({
    value,
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    classList: makeClassList(),
  });
  const ids = [
    'printDate', 'printDocTitle', 'printDocNum', 'printBillTo', 'price-0', 'qty-0',
    'hdr-unitprice', 'warrantyBtn', 'custName', 'custCompany', 'custAddr', 'custCity',
    'custState', 'custZip', 'custPhone', 'custEmail', 'printCopy2', 'reviewBtn',
    'reviewMsg', 'signatureBtn', 'signatureBlock', 'sig-signature-section',
    'sig-warranty-form', 'sig-received', 'sig-invoice',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, makeElement()]));
  elements['price-0'].dataset = { price: '10.00', discountPerUnit: '' };
  elements['qty-0'].value = '1';
  const row = { classList: makeClassList() };
  const snInput = { value: '' };
  const snRow = {
    classList: makeClassList(),
    querySelectorAll: selector => selector === '.sn-input' ? [snInput] : [],
  };
  let warrantyRowPresent = false;
  const tbody = {
    querySelector(selector) {
      if (selector === 'tr[data-warranty="1"]') return warrantyRowPresent ? row : null;
      if (selector.startsWith('tr[data-row=')) return row;
      if (selector.startsWith('tr[data-sn-for=')) return snRow;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.sn-input') return [snInput];
      if (selector === 'tr[data-sn-for]') return [snRow];
      return [];
    },
  };
  let currentSource = clone(fixture.source_facts);
  let copy2Builds = 0;
  const sandbox = {
    String,
    Number,
    Array,
    Date,
    _docType: 'invoice',
    _ledgerOutputCoordinator: {
      current: () => ({
        source_facts: currentSource,
        document_number: fixture.history_packet.allocation.document_number,
        completion_at: '2026-09-05T20:00:00.000Z',
      }),
    },
    _reprintSource: null,
    NUM_ROWS: 1,
    tbody,
    document: {
      body: { classList: makeClassList() },
      getElementById: id => elements[id] || null,
      querySelectorAll: () => [],
    },
    DOC_TITLES: { receipt: 'Sales Receipt', invoice: 'Invoice', quote: 'Quote' },
    reserveDocDate: () => new Date('2026-09-05T20:00:00.000Z'),
    activeDocNumber: () => '',
    formatDocNumber: () => 'LEGACY-NUMBER',
    updateScreenDocTitle: () => {},
    buildCopy2HTML: () => {
      copy2Builds += 1;
      return '<div class="wrap">SECOND COPY</div>';
    },
    buildReviewBlock: () => '<div>REVIEW</div>',
    buildWarrantyForm: () => '<div>WARRANTY</div>',
    fmtPrint: value => `$${Number(value).toFixed(2)}`,
    scheduleValueFieldFit: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(entryText.slice(printStart, printEnd), sandbox, {
    filename: 'POS-prepare-print-copy-matrix.js',
  });

  const prepare = (documentType, { serial = false, warranty = false } = {}) => {
    sandbox._docType = documentType;
    currentSource = clone(fixture.source_facts);
    currentSource.document.type = documentType;
    snInput.value = serial ? 'SERIAL-ONE' : '';
    warrantyRowPresent = serial;
    elements.warrantyBtn.classList.toggle('active', warranty);
    elements.signatureBtn.classList.remove('active');
    elements.printCopy2.innerHTML = '';
    elements.printCopy2.classList.remove('active');
    elements.printBillTo.innerHTML = '';
    elements.printBillTo.classList.remove('active');
    elements.signatureBlock.classList.remove('active');
    elements['sig-invoice'].innerHTML = '';
    elements['sig-invoice'].style.display = 'none';
    vm.runInContext('preparePrint()', sandbox);
    return {
      billTo: elements.printBillTo.innerHTML,
      copy2: elements.printCopy2.innerHTML,
      copy2Active: elements.printCopy2.classList.contains('active'),
      signature: elements['sig-invoice'].innerHTML,
    };
  };

  for (const documentType of ['invoice', 'quote']) {
    for (const triggers of [{}, { serial: true, warranty: true }]) {
      const output = prepare(documentType, triggers);
      const billText = extractedHtmlText(output.billTo);
      assert.equal(billText.split('Bill to').length - 1, 1, documentType);
      for (const expected of [
        fixture.source_facts.customer.name,
        fixture.source_facts.customer.company,
        ...fixture.source_facts.customer.address.split('\n'),
        fixture.source_facts.customer.phone,
        fixture.source_facts.customer.email,
      ]) assert.equal(billText.split(expected).length - 1, 1, `${documentType}: ${expected}`);
      assert.equal(output.copy2Active, false, `${documentType} remains a one-copy document`);
      assert.equal(output.copy2, '', `${documentType} cannot duplicate Bill-to through copy 2`);
      if (documentType === 'invoice') {
        assert.match(extractedHtmlText(output.signature), /Terms: Net 30.*Received by:.*Print:.*Sign:/);
      } else {
        assert.equal(output.signature, '');
      }
    }
  }
  assert.equal(copy2Builds, 0, 'Invoice/Quote never enter the receipt-only copy builder');

  const receipt = prepare('receipt', { serial: true, warranty: true });
  assert.equal(receipt.billTo, '', 'receipt keeps Bill-to out of its output');
  assert.equal(receipt.copy2Active, true, 'receipt executes the two-copy path');
  assert.equal(receipt.copy2, '<div class="wrap">SECOND COPY</div>');
  assert.equal(copy2Builds, 1);

  const titleAt = entryText.indexOf('<div class="print-titlerow">');
  const billAt = entryText.indexOf('<div class="print-bill-to" id="printBillTo">');
  const itemsAt = entryText.indexOf('<table class="search-table">', titleAt);
  const totalsAt = entryText.indexOf('<div class="bottom-bar">', itemsAt);
  const signatureAt = entryText.indexOf('<div class="signature-block"', totalsAt);
  assert.ok(titleAt < billAt && billAt < itemsAt && itemsAt < totalsAt && totalsAt < signatureAt);
});

test('actual POS routes all output controls through the guarded seam in the required order', () => {
  const save = entryText.slice(entryText.indexOf('async function saveOnly'), entryText.indexOf('function serializedPrintDocument'));
  const manual = entryText.slice(entryText.indexOf('async function manualPrint'), entryText.indexOf('const AUTO_PRINT_REPEAT_GUARD_MS'));
  const auto = entryText.slice(entryText.indexOf('async function autoPrint'), entryText.indexOf("window.addEventListener('beforeprint'"));
  const pdf = entryText.slice(entryText.indexOf('async function exportPdf'), entryText.indexOf('async function emailDoc'));
  const email = entryText.slice(entryText.indexOf('async function emailDoc'), entryText.indexOf('// ─── HISTORY'));
  assert.match(save, /await prepareAndSaveForPrint\('save_snapshot', \{ prepareOutput: false \}\)/);
  assert.ok(save.indexOf('await preflightLedgerOutput') < save.indexOf('preparePrint()'));
  assert.ok(save.indexOf('recordOutgoingDocument()') < save.indexOf('_printPrepared = true'));
  assert.match(manual, /await prepareAndSaveForPrint\('print_snapshot', \{ outputKind: 'print' \}\);[\s\S]*window\.print\(\)/);
  assert.match(auto, /await prepareAndSaveForPrint\('print_snapshot', \{ outputKind: 'print' \}\)/);
  assert.ok(auto.indexOf("await prepareAndSaveForPrint('print_snapshot', { outputKind: 'print' })")
    < auto.indexOf('printReceipt({'));
  assert.match(pdf, /outputKind: 'pdf'/);
  assert.ok(pdf.indexOf("outputKind: 'pdf'") < pdf.indexOf('await _renderPdf'));
  assert.match(pdf, /await finishLedgerOutput\('succeeded', null\)/);
  assert.doesNotMatch(pdf, /recordOutgoingDocument\(/);
  assert.ok(email.indexOf('await _ledgerOutputCoordinator.guardArtifact()')
    < email.indexOf('createGmailDraft'));
  assert.match(entryText, /beforeprint'[\s\S]{0,700}c06-print-refused/);
  assert.match(entryText, /typeof numbering\.beginOutput !== 'function'/);
  assert.match(entryText, /typeof numbering\.finishOutput !== 'function'/);
  assert.match(entryText, /typeof numbering\.getFinalizedSource !== 'function'/);
  assert.match(entryText, /_ledgerOutputCoordinator\.recover\(\{/);
});

test('the actual POS entry loads the helper once before application code', () => {
  const digest = crypto.createHash('sha256').update(sourceText).digest('base64');
  const tag = '<script src="ledger-finalization.js" integrity="sha256-' + digest + '"></script>';
  assert.equal(entryText.split(tag).length - 1, 1);
  assert.ok(entryText.indexOf(tag) < entryText.indexOf('const SHEETS_ID ='));
  assert.equal(
    'sha256-' + crypto.createHash('sha256').update(sourceText).digest('base64'),
    /integrity="(sha256-[^"]+)"/.exec(tag)[1],
  );
});


test('renderer accepts strict numeric V4 allocation and preserves it after lost acknowledgement retry', async () => {
  let attempts = 0;
  let firstRequest;
  const coordinator = coordinatorWith({
    finalize: async request => {
      attempts++;
      if (!firstRequest) firstRequest = clone(request);
      else assert.deepEqual(request, firstRequest);
      if (attempts === 1) throw new helper.LedgerFinalizationError('local_integrity_uncertain');
      const value = finalizedResult(request);
      value.allocation = {
        source_event_id: request.sourceEventId, source_content_sha256: request.qboCommandIntent.payload.source_facts_sha256,
        document_type: request.documentType, device_id: 'fixture-mac', device_digit: 1, number_ordinal: 1749451,
        document_number: '1749451', allocated_at: '2026-10-03T19:00:00.000Z', allocation_sha256: 'a'.repeat(64),
      };
      value.qbo_command_intent.official_document_number = '1749451';
      return value;
    },
    getFinalizedSource: async request => finalizedSourceResult(request, { official_document_number: '1749451' }),
  });
  await expectCodeAsync(() => coordinator.preflight(actionProposal(), () => captureFromSource()), 'local_integrity_uncertain');
  const result = await coordinator.preflight(actionProposal(), () => captureFromSource());
  assert.equal(result.document_number, '1749451');
  assert.equal(result.source_event_id, firstRequest.sourceEventId);
  assert.equal(attempts, 2);
});
