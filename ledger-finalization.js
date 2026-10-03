(function installLedgerFinalization(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  Object.defineProperty(root, 'MPELedgerFinalization', {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}(typeof globalThis === 'object' ? globalThis : this, function ledgerFinalizationFactory() {
  'use strict';

  // Pure C06 renderer boundary. This file owns no DOM, IPC, clock, UUID,
  // persistence, output, or provider capability.
  const CAPTURE_KEYS = [
    'schema', 'schema_version', 'source_client', 'document', 'customer',
    'lines', 'totals', 'tender',
  ];
  const SOURCE_CLIENT_KEYS = ['system', 'app_version'];
  const DOCUMENT_KEYS = [
    'type', 'due_date', 'linked_quote_event_id', 'original_source_display_number',
  ];
  const CUSTOMER_KEYS = [
    'customer_id', 'identity_kind', 'adoption_proof', 'anonymous', 'name',
    'company', 'phone', 'email', 'address',
  ];
  const LINE_KEYS = [
    'line_id', 'kind', 'part_number', 'description', 'quantity',
    'original_unit_amount', 'discount_amount', 'unit_amount', 'line_rounding',
    'line_total', 'serials',
  ];
  const TOTAL_KEYS = ['currency', 'subtotal', 'card_fee', 'tax', 'rounding', 'total'];
  const TENDER_KEYS = ['type', 'reference'];
  const SOURCE_FACT_KEYS = [
    'schema', 'schema_version', 'source_event_id', 'source_transaction_id',
    'recorded_at', 'source_client', 'document', 'customer', 'lines', 'totals',
    'tender', 'completion', 'lineage',
  ];
  const COMPLETION_KEYS = ['action', 'at'];
  const LINEAGE_KEYS = ['parent_source_event_id', 'parent_entity_id', 'parent_revision'];
  const CAPABILITY_KEYS = [
    'beginOutput', 'finalize', 'finishOutput', 'getFinalizedSource', 'getStatus',
    'prepareContext',
  ];
  const STATUS_KEYS = ['enabled', 'available', 'reason', 'capacity'];
  const CAPACITY_KEYS = ['document_type', 'remaining'];
  const FINALIZE_RESULT_KEYS = ['allocation', 'qbo_command_intent'];
  const ALLOCATION_KEYS = [
    'lease_id', 'source_event_id', 'source_content_sha256', 'document_type',
    'ordinal', 'document_number', 'number_format_id', 'allocated_at',
    'allocation_sha256',
  ];
  const DEVICE_ALLOCATION_KEYS = [
    'source_event_id', 'source_content_sha256', 'document_type', 'device_id',
    'device_digit', 'number_ordinal', 'document_number', 'allocated_at', 'allocation_sha256',
  ];
  const COMMITTED_INTENT_KEYS = [
    'schema', 'schema_version', 'source_event_id', 'document_type', 'operation',
    'payload', 'official_document_number',
  ];
  const INTENT_PAYLOAD_KEYS = [
    'source_contract', 'source_facts_sha256', 'completion_action',
    'formal_command_kind',
  ];
  const FINALIZED_SOURCE_RESULT_KEYS = [
    'schema', 'schema_version', 'state', 'source_event_id', 'source_transaction_id',
    'document_type', 'source_facts', 'source_facts_sha256',
    'official_document_number', 'packet_sha256',
  ];
  const OUTPUT_BEGIN_RESULT_KEYS = [
    'schema', 'schema_version', 'output_attempt_id', 'source_event_id',
    'packet_sha256', 'output_kind', 'started_at', 'official_document_number',
    'state',
  ];
  const OUTPUT_ATTEMPT_KEYS = [
    'schema', 'schema_version', 'output_attempt_id', 'source_event_id',
    'packet_sha256', 'output_kind', 'started_at', 'finished_at', 'outcome',
    'reason_code', 'output_attempt_sha256',
  ];
  const ACTION_PROPOSAL_KEYS = [
    'document_type', 'completion_action', 'parent_source_event_id',
    'parent_source_facts_sha256',
  ];
  const ACTION_CONTEXT_KEYS = [
    'schema', 'schema_version', 'source_event_id', 'source_transaction_id',
    'recorded_at', 'completion_action', 'completion_at',
    'parent_source_event_id', 'parent_source_facts_sha256', 'parent_entity_id',
    'parent_revision',
  ];
  const ACTIONS = Object.freeze({
    invoice: new Set([
      'save_snapshot', 'print_snapshot', 'export_snapshot', 'reprint_snapshot',
      'finalize_invoice',
    ]),
    quote: new Set([
      'save_snapshot', 'print_snapshot', 'export_snapshot', 'reprint_snapshot',
      'finalize_quote',
    ]),
    receipt: new Set(['print_snapshot', 'reprint_snapshot', 'complete_sale']),
  });
  const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SHA256 = /^[0-9a-f]{64}$/;
  const SAFE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const PUBLIC_CODES = new Set([
    'not_configured', 'untrusted_context', 'release_unattested', 'shape_invalid',
    'identity_invalid', 'time_invalid', 'text_invalid', 'money_invalid',
    'tender_invalid', 'action_unrepresentable', 'intent_mismatch',
    'authority_unavailable', 'lease_invalid', 'lease_exhausted',
    'number_format_invalid', 'formal_ineligible', 'stale_revision',
    'replay_collision', 'source_binding', 'finalized_source_missing',
    'local_integrity_uncertain', 'output_failed', 'output_cancelled',
    'ledger_unavailable', 'ledger_ambiguous', 'ledger_rejected',
    'qbo_definite_failure', 'qbo_ambiguous', 'integrity_conflict', 'quarantined',
  ]);
  const MONEY_FIELDS = [
    'original_unit_amount', 'discount_amount', 'unit_amount', 'line_rounding',
    'line_total',
  ];

  class LedgerFinalizationError extends Error {
    constructor(code) {
      super(`Ledger finalization refused: ${code}`);
      this.name = 'LedgerFinalizationError';
      this.code = code;
    }
  }

  function refuse(code) {
    throw new LedgerFinalizationError(code);
  }

  function dataValues(value, keys, code = 'shape_invalid') {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(code);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null) refuse(code);
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some(key => typeof key !== 'string')) refuse(code);
      const expected = [...keys].sort().join('|');
      if (ownKeys.map(String).sort().join('|') !== expected
          || Object.keys(value).sort().join('|') !== expected) refuse(code);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.values(descriptors).some(
        descriptor => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true,
      )) refuse(code);
      return descriptors;
    } catch (error) {
      if (error instanceof LedgerFinalizationError) throw error;
      refuse(code);
    }
  }

  function arrayValues(value, code = 'shape_invalid') {
    try {
      if (!Array.isArray(value)) refuse(code);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(value);
      const expected = Array.from({ length: value.length }, (_unused, index) => String(index));
      expected.push('length');
      if (ownKeys.some(key => typeof key !== 'string')
          || ownKeys.sort().join('|') !== expected.sort().join('|')) refuse(code);
      if (!descriptors.length || !Object.hasOwn(descriptors.length, 'value')) refuse(code);
      return Array.from({ length: value.length }, (_unused, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          refuse(code);
        }
        return descriptor.value;
      });
    } catch (error) {
      if (error instanceof LedgerFinalizationError) throw error;
      refuse(code);
    }
  }

  function unicodeScalars(value, code = 'shape_invalid') {
    if (typeof value !== 'string') refuse(code);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) refuse(code);
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        refuse(code);
      }
    }
    return value;
  }

  function nullableText(value, code = 'shape_invalid') {
    return value === null ? null : unicodeScalars(value, code);
  }

  function cloneCanonical(value, code = 'shape_invalid', ancestors = new Set()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      if (typeof value === 'string') unicodeScalars(value, code);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) refuse(code);
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) refuse(code);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return arrayValues(value, code).map(item => cloneCanonical(item, code, ancestors));
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== 'string')) refuse(code);
      const descriptors = dataValues(value, keys, code);
      const result = {};
      for (const key of keys) result[key] = cloneCanonical(descriptors[key].value, code, ancestors);
      return result;
    } finally {
      ancestors.delete(value);
    }
  }

  function canonicalJson(value, ancestors = new Set()) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') {
      unicodeScalars(value, 'integrity_conflict');
      return JSON.stringify(value);
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) refuse('integrity_conflict');
      return String(value);
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      refuse('integrity_conflict');
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${arrayValues(value, 'integrity_conflict')
          .map(item => canonicalJson(item, ancestors)).join(',')}]`;
      }
      const keys = Reflect.ownKeys(value).sort();
      const descriptors = dataValues(value, keys, 'integrity_conflict');
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(
        descriptors[key].value,
        ancestors,
      )}`).join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }

  function c06DesktopV3CanonicalBytes(value) {
    return new TextEncoder().encode(`${canonicalJson(value)}\n`);
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }

  function capturedDraft(input) {
    const capture = dataValues(input, CAPTURE_KEYS);
    if (capture.schema.value !== 'mpe-pos-c06-captured-draft-v1'
        || capture.schema_version.value !== 1) refuse('shape_invalid');

    const client = dataValues(capture.source_client.value, SOURCE_CLIENT_KEYS);
    const sourceClient = {
      system: unicodeScalars(client.system.value),
      app_version: unicodeScalars(client.app_version.value),
    };
    if (sourceClient.system !== 'mpe-pos' || !sourceClient.app_version) refuse('shape_invalid');

    const documentValues = dataValues(capture.document.value, DOCUMENT_KEYS);
    const documentValue = {
      type: unicodeScalars(documentValues.type.value),
      due_date: nullableText(documentValues.due_date.value),
      linked_quote_event_id: nullableText(documentValues.linked_quote_event_id.value),
      original_source_display_number: nullableText(
        documentValues.original_source_display_number.value,
      ),
    };
    if (!Object.hasOwn(ACTIONS, documentValue.type)) refuse('shape_invalid');

    const customerValues = dataValues(capture.customer.value, CUSTOMER_KEYS);
    const customer = {
      customer_id: nullableText(customerValues.customer_id.value),
      identity_kind: unicodeScalars(customerValues.identity_kind.value),
      adoption_proof: cloneCanonical(customerValues.adoption_proof.value),
      anonymous: customerValues.anonymous.value,
      name: unicodeScalars(customerValues.name.value),
      company: unicodeScalars(customerValues.company.value),
      phone: unicodeScalars(customerValues.phone.value),
      email: unicodeScalars(customerValues.email.value),
      address: unicodeScalars(customerValues.address.value),
    };
    if (typeof customer.anonymous !== 'boolean') refuse('shape_invalid');

    const lines = arrayValues(capture.lines.value).map(rawLine => {
      const values = dataValues(rawLine, LINE_KEYS);
      const line = {
        line_id: unicodeScalars(values.line_id.value),
        kind: unicodeScalars(values.kind.value),
        part_number: unicodeScalars(values.part_number.value),
        description: unicodeScalars(values.description.value),
        quantity: nullableText(values.quantity.value),
        original_unit_amount: null,
        discount_amount: null,
        unit_amount: null,
        line_rounding: null,
        line_total: null,
        serials: arrayValues(values.serials.value).map(serial => unicodeScalars(serial)),
      };
      for (const field of MONEY_FIELDS) {
        const value = nullableText(values[field].value);
        line[field] = value === '-0.00' ? '0.00' : value;
      }
      return line;
    });

    const totalValues = dataValues(capture.totals.value, TOTAL_KEYS);
    const totals = { currency: unicodeScalars(totalValues.currency.value) };
    for (const field of ['subtotal', 'card_fee', 'tax', 'rounding', 'total']) {
      const value = unicodeScalars(totalValues[field].value);
      totals[field] = value === '-0.00' ? '0.00' : value;
    }

    const tenderValues = dataValues(capture.tender.value, TENDER_KEYS);
    const tender = {
      type: unicodeScalars(tenderValues.type.value),
      reference: nullableText(tenderValues.reference.value),
    };
    return { sourceClient, documentValue, customer, lines, totals, tender };
  }

  function actionContext(input) {
    const values = dataValues(input, ACTION_CONTEXT_KEYS, 'source_binding');
    const context = {};
    for (const key of ACTION_CONTEXT_KEYS) context[key] = cloneCanonical(
      values[key].value,
      'source_binding',
    );
    if (context.schema !== 'mpe-pos-c06-action-context-v1'
        || context.schema_version !== 1
        || typeof context.source_event_id !== 'string'
        || !UUID4.test(context.source_event_id)
        || typeof context.source_transaction_id !== 'string'
        || !UUID4.test(context.source_transaction_id)
        || typeof context.recorded_at !== 'string' || !context.recorded_at
        || typeof context.completion_at !== 'string' || !context.completion_at
        || typeof context.completion_action !== 'string') refuse('source_binding');
    const initial = context.parent_source_event_id === null
      && context.parent_source_facts_sha256 === null
      && context.parent_entity_id === null
      && context.parent_revision === null;
    const descendant = typeof context.parent_source_event_id === 'string'
      && UUID4.test(context.parent_source_event_id)
      && typeof context.parent_source_facts_sha256 === 'string'
      && SHA256.test(context.parent_source_facts_sha256)
      && typeof context.parent_entity_id === 'string'
      && UUID4.test(context.parent_entity_id)
      && Number.isSafeInteger(context.parent_revision)
      && context.parent_revision >= 0;
    if (!initial && !descendant) refuse('source_binding');
    return context;
  }

  function buildActionContextRequest(input) {
    const values = dataValues(input, ACTION_PROPOSAL_KEYS);
    const documentType = unicodeScalars(values.document_type.value);
    const completionAction = unicodeScalars(values.completion_action.value);
    const parentEvent = nullableText(values.parent_source_event_id.value);
    const parentFacts = nullableText(values.parent_source_facts_sha256.value);
    if (!Object.hasOwn(ACTIONS, documentType)) refuse('shape_invalid');
    if (!ACTIONS[documentType].has(completionAction)) refuse('action_unrepresentable');
    const initial = parentEvent === null && parentFacts === null;
    const descendant = typeof parentEvent === 'string' && UUID4.test(parentEvent)
      && typeof parentFacts === 'string' && SHA256.test(parentFacts);
    if (!initial && !descendant) refuse('source_binding');
    return deepFreeze({
      schema: 'mpe-pos-c06-action-context-request-v1',
      schema_version: 1,
      document_type: documentType,
      completion_action: completionAction,
      parent_source_event_id: parentEvent,
      parent_source_facts_sha256: parentFacts,
    });
  }

  async function sha256Hex(bytes) {
    try {
      const subtle = globalThis.crypto && globalThis.crypto.subtle;
      if (!subtle || typeof subtle.digest !== 'function') refuse('integrity_conflict');
      const digest = await subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch (error) {
      if (error instanceof LedgerFinalizationError) throw error;
      refuse('integrity_conflict');
    }
  }

  async function buildFinalizationRequest(capturedInput, contextInput) {
    const draft = capturedDraft(capturedInput);
    const context = actionContext(contextInput);
    if (!ACTIONS[draft.documentValue.type].has(context.completion_action)) {
      refuse('action_unrepresentable');
    }
    const sourceSnapshot = {
      schema: 'mpe-pos-finalization-source-facts-v1',
      schema_version: 1,
      source_event_id: context.source_event_id,
      source_transaction_id: context.source_transaction_id,
      recorded_at: context.recorded_at,
      source_client: draft.sourceClient,
      document: draft.documentValue,
      customer: draft.customer,
      lines: draft.lines,
      totals: draft.totals,
      tender: draft.tender,
      completion: {
        action: context.completion_action,
        at: context.completion_at,
      },
      lineage: {
        parent_source_event_id: context.parent_source_event_id,
        parent_entity_id: context.parent_entity_id,
        parent_revision: context.parent_revision,
      },
    };
    const sourceFactsSha256 = await sha256Hex(c06DesktopV3CanonicalBytes(sourceSnapshot));
    const qboCommandIntent = {
      schema: 'mpe-pos-finalization-intent-v1',
      schema_version: 1,
      source_event_id: sourceSnapshot.source_event_id,
      document_type: sourceSnapshot.document.type,
      operation: 'history_only',
      payload: {
        source_contract: 'mpe-pos-finalization-source-facts-v1',
        source_facts_sha256: sourceFactsSha256,
        completion_action: sourceSnapshot.completion.action,
        formal_command_kind: null,
      },
    };
    return deepFreeze({
      schema: 'mpe-pos-c06-finalization-v1',
      sourceEventId: sourceSnapshot.source_event_id,
      documentType: sourceSnapshot.document.type,
      sourceSnapshot,
      qboCommandIntent,
    });
  }

  function publicErrorCode(error, fallback = 'integrity_conflict') {
    try {
      if (!error || (typeof error !== 'object' && typeof error !== 'function')) return fallback;
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      return descriptor && Object.hasOwn(descriptor, 'value')
        && typeof descriptor.value === 'string' && PUBLIC_CODES.has(descriptor.value)
        ? descriptor.value : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  async function callCapability(callback, fallback = 'integrity_conflict') {
    try {
      return await callback();
    } catch (error) {
      refuse(publicErrorCode(error, fallback));
    }
  }

  function boundedStatus(input) {
    const values = dataValues(input, STATUS_KEYS, 'integrity_conflict');
    const status = {
      enabled: values.enabled.value,
      available: values.available.value,
      reason: values.reason.value,
      capacity: arrayValues(values.capacity.value, 'integrity_conflict').map(entry => {
        const item = dataValues(entry, CAPACITY_KEYS, 'integrity_conflict');
        const bounded = {
          document_type: item.document_type.value,
          remaining: item.remaining.value,
        };
        if (!Object.hasOwn(ACTIONS, bounded.document_type)
            || !Number.isSafeInteger(bounded.remaining) || bounded.remaining < 0) {
          refuse('integrity_conflict');
        }
        return bounded;
      }),
    };
    if (typeof status.enabled !== 'boolean' || typeof status.available !== 'boolean') {
      refuse('integrity_conflict');
    }
    if (status.enabled === false) {
      if (status.available !== false || status.reason !== 'not_configured'
          || status.capacity.length !== 0) refuse('integrity_conflict');
    } else if (status.available === false) {
      if (status.reason !== 'not_configured' || status.capacity.length !== 0) {
        refuse('integrity_conflict');
      }
    } else if (status.reason !== null) {
      refuse('integrity_conflict');
    }
    const types = status.capacity.map(item => item.document_type);
    if (new Set(types).size !== types.length) refuse('integrity_conflict');
    return deepFreeze(status);
  }

  function boundedFinalizeResult(input, request) {
    const result = dataValues(input, FINALIZE_RESULT_KEYS, 'integrity_conflict');
    const deviceAllocation = Object.prototype.hasOwnProperty.call(result.allocation.value || {}, 'device_id');
    const allocationKeys = deviceAllocation ? DEVICE_ALLOCATION_KEYS : ALLOCATION_KEYS;
    const allocationValues = dataValues(
      result.allocation.value,
      allocationKeys,
      'integrity_conflict',
    );
    const allocation = {};
    for (const key of allocationKeys) allocation[key] = allocationValues[key].value;
    const intentValues = dataValues(
      result.qbo_command_intent.value,
      COMMITTED_INTENT_KEYS,
      'integrity_conflict',
    );
    const payloadValues = dataValues(
      intentValues.payload.value,
      INTENT_PAYLOAD_KEYS,
      'integrity_conflict',
    );
    const payload = {};
    for (const key of INTENT_PAYLOAD_KEYS) payload[key] = payloadValues[key].value;
    const intent = {
      schema: intentValues.schema.value,
      schema_version: intentValues.schema_version.value,
      source_event_id: intentValues.source_event_id.value,
      document_type: intentValues.document_type.value,
      operation: intentValues.operation.value,
      payload,
      official_document_number: intentValues.official_document_number.value,
    };
    const expected = request.qboCommandIntent;
    const documentNumber = allocation.document_number;
    const numberingValid = deviceAllocation
      ? typeof allocation.device_id === 'string' && /^[\x21-\x7e]{1,120}$/.test(allocation.device_id)
        && Number.isInteger(allocation.device_digit) && allocation.device_digit >= 1 && allocation.device_digit <= 9
        && typeof documentNumber === 'string' && /^[1-9][0-9]{6,7}$/.test(documentNumber)
        && Number(documentNumber[0]) === allocation.device_digit
        && Number.isSafeInteger(allocation.number_ordinal) && allocation.number_ordinal === Number(documentNumber)
      : typeof allocation.lease_id === 'string' && UUID4.test(allocation.lease_id)
        && Number.isSafeInteger(allocation.ordinal) && allocation.ordinal >= 1
        && typeof allocation.number_format_id === 'string'
        && allocation.number_format_id.length >= 1 && allocation.number_format_id.length <= 80;
    if (!numberingValid
        || allocation.source_event_id !== request.sourceEventId
        || allocation.source_content_sha256 !== expected.payload.source_facts_sha256
        || allocation.document_type !== request.documentType
        || typeof documentNumber !== 'string' || documentNumber.length > 21
        || !SAFE_NUMBER.test(documentNumber)
        || typeof allocation.allocated_at !== 'string'
        || !UTC_MILLISECONDS.test(allocation.allocated_at)
        || typeof allocation.allocation_sha256 !== 'string'
        || !SHA256.test(allocation.allocation_sha256)
        || intent.schema !== expected.schema
        || intent.schema_version !== expected.schema_version
        || intent.source_event_id !== expected.source_event_id
        || intent.document_type !== expected.document_type
        || intent.operation !== 'history_only'
        || payload.source_contract !== expected.payload.source_contract
        || payload.source_facts_sha256 !== expected.payload.source_facts_sha256
        || payload.completion_action !== expected.payload.completion_action
        || payload.formal_command_kind !== null
        || intent.official_document_number !== documentNumber) {
      refuse('integrity_conflict');
    }
    return deepFreeze({ allocation, qbo_command_intent: intent });
  }

  async function boundedFinalizedSourceResult(input, request, expectedSource = null) {
    const values = dataValues(input, FINALIZED_SOURCE_RESULT_KEYS, 'integrity_conflict');
    const result = {};
    for (const key of FINALIZED_SOURCE_RESULT_KEYS) result[key] = values[key].value;
    const source = cloneCanonical(result.source_facts, 'integrity_conflict');
    const sourceValues = dataValues(source, SOURCE_FACT_KEYS, 'integrity_conflict');
    const documentValues = dataValues(
      sourceValues.document.value,
      DOCUMENT_KEYS,
      'integrity_conflict',
    );
    const completionValues = dataValues(
      sourceValues.completion.value,
      COMPLETION_KEYS,
      'integrity_conflict',
    );
    dataValues(sourceValues.source_client.value, SOURCE_CLIENT_KEYS, 'integrity_conflict');
    dataValues(sourceValues.customer.value, CUSTOMER_KEYS, 'integrity_conflict');
    dataValues(sourceValues.totals.value, TOTAL_KEYS, 'integrity_conflict');
    dataValues(sourceValues.tender.value, TENDER_KEYS, 'integrity_conflict');
    dataValues(sourceValues.lineage.value, LINEAGE_KEYS, 'integrity_conflict');
    arrayValues(sourceValues.lines.value, 'integrity_conflict').forEach(line => {
      dataValues(line, LINE_KEYS, 'integrity_conflict');
    });
    if (result.schema !== 'mpe-pos-c06-finalized-source-v1'
        || result.schema_version !== 1
        || !['local_finalized_queue_pending', 'ledger_committed'].includes(result.state)
        || result.source_event_id !== request.source_event_id
        || result.source_facts_sha256 !== request.source_facts_sha256
        || typeof result.source_transaction_id !== 'string'
        || !UUID4.test(result.source_transaction_id)
        || !Object.hasOwn(ACTIONS, result.document_type)
        || sourceValues.schema.value !== 'mpe-pos-finalization-source-facts-v1'
        || sourceValues.schema_version.value !== 1
        || sourceValues.source_event_id.value !== result.source_event_id
        || sourceValues.source_transaction_id.value !== result.source_transaction_id
        || documentValues.type.value !== result.document_type
        || typeof completionValues.action.value !== 'string'
        || !ACTIONS[result.document_type].has(completionValues.action.value)
        || typeof result.official_document_number !== 'string'
        || result.official_document_number.length < 1
        || result.official_document_number.length > 21
        || !SAFE_NUMBER.test(result.official_document_number)
        || typeof result.packet_sha256 !== 'string'
        || !SHA256.test(result.packet_sha256)) refuse('integrity_conflict');
    const actualHash = await sha256Hex(c06DesktopV3CanonicalBytes(source));
    if (actualHash !== result.source_facts_sha256
        || (expectedSource !== null
          && canonicalJson(source) !== canonicalJson(expectedSource))) {
      refuse('integrity_conflict');
    }
    const rebuilt = recoveredSourceFromCapture({
      schema: 'mpe-pos-c06-captured-draft-v1',
      schema_version: 1,
      source_client: source.source_client,
      document: source.document,
      customer: source.customer,
      lines: source.lines,
      totals: source.totals,
      tender: source.tender,
    }, source);
    if (canonicalJson(rebuilt) !== canonicalJson(source)) {
      refuse('integrity_conflict');
    }
    return deepFreeze({ ...result, source_facts: source });
  }

  function recoveredSourceFromCapture(capturedInput, source) {
    const draft = capturedDraft(capturedInput);
    if (!source || typeof source !== 'object'
        || typeof source.source_event_id !== 'string'
        || !UUID4.test(source.source_event_id)
        || typeof source.source_transaction_id !== 'string'
        || !UUID4.test(source.source_transaction_id)
        || typeof source.recorded_at !== 'string'
        || !Number.isFinite(Date.parse(source.recorded_at))
        || typeof source.completion?.action !== 'string'
        || !ACTIONS[draft.documentValue.type].has(source.completion.action)
        || typeof source.completion.at !== 'string'
        || !Number.isFinite(Date.parse(source.completion.at))) {
      refuse('integrity_conflict');
    }
    const lineIds = draft.lines.map(line => line.line_id);
    if (lineIds.some(lineId => typeof lineId !== 'string' || !UUID4.test(lineId))
        || new Set(lineIds).size !== lineIds.length) refuse('integrity_conflict');
    const lineage = source.lineage;
    const initial = lineage.parent_source_event_id === null
      && lineage.parent_entity_id === null && lineage.parent_revision === null;
    const descendant = typeof lineage.parent_source_event_id === 'string'
      && UUID4.test(lineage.parent_source_event_id)
      && typeof lineage.parent_entity_id === 'string'
      && UUID4.test(lineage.parent_entity_id)
      && Number.isSafeInteger(lineage.parent_revision)
      && lineage.parent_revision >= 0;
    if (!initial && !descendant) refuse('integrity_conflict');
    return deepFreeze({
      schema: 'mpe-pos-finalization-source-facts-v1',
      schema_version: 1,
      source_event_id: source.source_event_id,
      source_transaction_id: source.source_transaction_id,
      recorded_at: source.recorded_at,
      source_client: draft.sourceClient,
      document: draft.documentValue,
      customer: draft.customer,
      lines: draft.lines,
      totals: draft.totals,
      tender: draft.tender,
      completion: {
        action: source.completion.action,
        at: source.completion.at,
      },
      lineage: {
        parent_source_event_id: lineage.parent_source_event_id,
        parent_entity_id: lineage.parent_entity_id,
        parent_revision: lineage.parent_revision,
      },
    });
  }

  function recoveredContext(source) {
    const lineage = source.lineage;
    // Recovery is render-only. It deliberately does not fabricate the omitted
    // parent-facts hash or reuse this object as a trusted mutation context.
    return deepFreeze({
      schema: 'mpe-pos-c06-recovered-render-context-v1',
      schema_version: 1,
      source_event_id: source.source_event_id,
      source_transaction_id: source.source_transaction_id,
      recorded_at: source.recorded_at,
      completion_action: source.completion.action,
      completion_at: source.completion.at,
      parent_source_event_id: lineage.parent_source_event_id,
      parent_source_facts_sha256: null,
      parent_entity_id: lineage.parent_entity_id,
      parent_revision: lineage.parent_revision,
    });
  }

  function boundedOutputBeginResult(input, request, documentNumber) {
    const values = dataValues(input, OUTPUT_BEGIN_RESULT_KEYS, 'integrity_conflict');
    const result = {};
    for (const key of OUTPUT_BEGIN_RESULT_KEYS) result[key] = values[key].value;
    if (result.schema !== 'mpe-pos-c06-output-begin-result-v1'
        || result.schema_version !== 1
        || typeof result.output_attempt_id !== 'string'
        || !UUID4.test(result.output_attempt_id)
        || result.source_event_id !== request.source_event_id
        || result.packet_sha256 !== request.packet_sha256
        || result.output_kind !== request.output_kind
        || typeof result.started_at !== 'string'
        || !UTC_MILLISECONDS.test(result.started_at)
        || !Number.isFinite(Date.parse(result.started_at))
        || result.official_document_number !== documentNumber
        || result.state !== 'committed_for_output') refuse('integrity_conflict');
    return deepFreeze(result);
  }

  async function boundedOutputAttempt(input, request, begin) {
    const values = dataValues(input, OUTPUT_ATTEMPT_KEYS, 'integrity_conflict');
    const result = {};
    for (const key of OUTPUT_ATTEMPT_KEYS) result[key] = values[key].value;
    if (result.schema !== 'mpe-pos-output-attempt-v1'
        || result.schema_version !== 1
        || result.output_attempt_id !== request.output_attempt_id
        || result.output_attempt_id !== begin.output_attempt_id
        || result.source_event_id !== begin.source_event_id
        || result.packet_sha256 !== begin.packet_sha256
        || result.output_kind !== begin.output_kind
        || result.started_at !== begin.started_at
        || typeof result.finished_at !== 'string'
        || !UTC_MILLISECONDS.test(result.finished_at)
        || !Number.isFinite(Date.parse(result.finished_at))
        || Date.parse(result.finished_at) < Date.parse(result.started_at)
        || result.outcome !== request.outcome
        || result.reason_code !== request.reason_code
        || typeof result.output_attempt_sha256 !== 'string'
        || !SHA256.test(result.output_attempt_sha256)) refuse('integrity_conflict');
    const preimage = {};
    for (const key of OUTPUT_ATTEMPT_KEYS) {
      if (key !== 'output_attempt_sha256') preimage[key] = result[key];
    }
    if (await sha256Hex(c06DesktopV3CanonicalBytes(preimage))
        !== result.output_attempt_sha256) refuse('integrity_conflict');
    return deepFreeze(result);
  }

  // Orchestrates injected, bounded Desktop capabilities without owning any
  // capability itself. Disabled status preserves the legacy POS path exactly;
  // enabled status cannot produce output until one durable result is verified.
  function createOutputCoordinator(input) {
    const values = dataValues(input, CAPABILITY_KEYS, 'shape_invalid');
    const capabilities = {
      beginOutput: values.beginOutput.value,
      finalize: values.finalize.value,
      finishOutput: values.finishOutput.value,
      getFinalizedSource: values.getFinalizedSource.value,
      getStatus: values.getStatus.value,
      prepareContext: values.prepareContext.value,
    };
    if (Object.values(capabilities).some(value => typeof value !== 'function')) {
      refuse('shape_invalid');
    }
    let committed = null;
    let inFlight = null;
    let recoveryInFlight = null;
    let retryCandidate = null;
    let activeOutput = null;
    let beginInFlight = null;
    let beginRetryKind = null;
    let finishInFlight = null;
    let pinnedFinishRequest = null;
    let lastTerminal = null;
    let lastMode = 'unknown';

    function publicCommit(reused) {
      if (!committed) return null;
      const source = committed.finalized_source.source_facts;
      return deepFreeze({
        mode: 'c06',
        reused,
        recovered: committed.recovered,
        context: committed.context,
        request: committed.request,
        allocation: committed.result ? committed.result.allocation : null,
        qbo_command_intent: committed.result ? committed.result.qbo_command_intent : null,
        source_event_id: source.source_event_id,
        source_transaction_id: source.source_transaction_id,
        completion_at: source.completion.at,
        document_type: source.document.type,
        source_facts: source,
        document_number: committed.finalized_source.official_document_number,
        source_facts_sha256: committed.finalized_source.source_facts_sha256,
        packet_sha256: committed.finalized_source.packet_sha256,
        state: committed.finalized_source.state,
      });
    }

    async function readStatus() {
      const raw = await callCapability(() => capabilities.getStatus());
      const status = boundedStatus(raw);
      lastMode = status.enabled ? 'c06' : 'legacy';
      return status;
    }

    async function runPreflight(proposal, capture) {
      if (typeof capture !== 'function') refuse('shape_invalid');

      if (committed) {
        const proposedAction = buildActionContextRequest(proposal);
        if (proposedAction.document_type !== committed.request.documentType) {
          refuse('source_binding');
        }
        const captured = await callCapability(() => capture(committed.context), 'shape_invalid');
        if (committed.recovered) {
          const replaySource = recoveredSourceFromCapture(
            captured,
            committed.finalized_source.source_facts,
          );
          if (canonicalJson(replaySource)
              !== canonicalJson(committed.finalized_source.source_facts)) {
            refuse('source_binding');
          }
          return publicCommit(true);
        }
        const replayRequest = await buildFinalizationRequest(captured, committed.context);
        if (replayRequest.qboCommandIntent.payload.source_facts_sha256
            !== committed.request.qboCommandIntent.payload.source_facts_sha256) {
          refuse('source_binding');
        }
        return publicCommit(true);
      }

      if (retryCandidate) {
        const proposedAction = buildActionContextRequest(proposal);
        if (proposedAction.document_type !== retryCandidate.request.documentType) {
          refuse('source_binding');
        }
        const captured = await callCapability(
          () => capture(retryCandidate.context),
          'shape_invalid',
        );
        const replayRequest = await buildFinalizationRequest(
          captured,
          retryCandidate.context,
        );
        if (canonicalJson(replayRequest) !== canonicalJson(retryCandidate.request)) {
          refuse('source_binding');
        }
        return finishCommit(retryCandidate.context, retryCandidate.request);
      }

      const status = await readStatus();
      if (!status.enabled) return deepFreeze({ mode: 'legacy', reused: false });
      if (!status.available) refuse(status.reason);
      const proposedAction = buildActionContextRequest(proposal);

      const contextValue = await callCapability(
        () => capabilities.prepareContext(proposedAction),
      );
      // buildFinalizationRequest owns the exact bounded context validation.
      const captured = await callCapability(() => capture(contextValue), 'shape_invalid');
      const request = await buildFinalizationRequest(captured, contextValue);
      retryCandidate = deepFreeze({ context: actionContext(contextValue), request });
      return finishCommit(retryCandidate.context, request);
    }

    async function finishCommit(contextValue, request) {
      let result;
      let finalizeReturned = false;
      try {
        const rawResult = await callCapability(() => capabilities.finalize(request));
        finalizeReturned = true;
        result = boundedFinalizeResult(rawResult, request);
      } catch (error) {
        if (!finalizeReturned && error.code !== 'local_integrity_uncertain') {
          retryCandidate = null;
        }
        throw error;
      }
      const sourceRequest = deepFreeze({
        schema: 'mpe-pos-c06-finalized-source-request-v1',
        schema_version: 1,
        source_event_id: request.sourceEventId,
        source_facts_sha256: request.qboCommandIntent.payload.source_facts_sha256,
      });
      let finalizedSource;
      try {
        const rawSource = await callCapability(
          () => capabilities.getFinalizedSource(sourceRequest),
        );
        finalizedSource = await boundedFinalizedSourceResult(
          rawSource,
          sourceRequest,
          request.sourceSnapshot,
        );
      } catch (error) {
        // Finalization already returned a bounded committed result. Retain the
        // exact request across every retrieval failure so a retry can never
        // advance to a new source event or consume a second number.
        throw error;
      }
      if (finalizedSource.official_document_number !== result.allocation.document_number) {
        refuse('integrity_conflict');
      }
      committed = deepFreeze({
        context: actionContext(contextValue),
        request,
        result,
        finalized_source: finalizedSource,
        recovered: false,
      });
      retryCandidate = null;
      return publicCommit(false);
    }

    async function preflight(proposal, capture) {
      if (recoveryInFlight) refuse('replay_collision');
      if (inFlight) return inFlight;
      const attempt = runPreflight(proposal, capture);
      inFlight = attempt;
      try {
        return await attempt;
      } finally {
        if (inFlight === attempt) inFlight = null;
      }
    }

    async function guardArtifact() {
      const status = await readStatus();
      if (!status.enabled) return deepFreeze({ mode: 'legacy' });
      if (!status.available) refuse(status.reason);
      // This renderer currently has no bounded QBO-confirmation evidence. Local
      // finalization is intentionally insufficient for Gmail/payment artifacts.
      refuse('ledger_unavailable');
    }

    async function recover(inputValue) {
      const values = dataValues(
        inputValue,
        ['source_event_id', 'source_facts_sha256'],
        'shape_invalid',
      );
      const request = deepFreeze({
        schema: 'mpe-pos-c06-finalized-source-request-v1',
        schema_version: 1,
        source_event_id: values.source_event_id.value,
        source_facts_sha256: values.source_facts_sha256.value,
      });
      if (typeof request.source_event_id !== 'string'
          || !UUID4.test(request.source_event_id)
          || typeof request.source_facts_sha256 !== 'string'
          || !SHA256.test(request.source_facts_sha256)) refuse('shape_invalid');
      if (inFlight || retryCandidate) refuse('replay_collision');
      if (recoveryInFlight) {
        if (canonicalJson(recoveryInFlight.request) !== canonicalJson(request)) {
          refuse('source_binding');
        }
        return recoveryInFlight.promise;
      }
      if (committed) {
        if (committed.finalized_source.source_event_id !== request.source_event_id
            || committed.finalized_source.source_facts_sha256
              !== request.source_facts_sha256) refuse('source_binding');
        return publicCommit(true);
      }
      const promise = (async () => {
        const rawSource = await callCapability(
          () => capabilities.getFinalizedSource(request),
        );
        const finalizedSource = await boundedFinalizedSourceResult(rawSource, request);
        const context = recoveredContext(finalizedSource.source_facts);
        const source = finalizedSource.source_facts;
        const qboCommandIntent = deepFreeze({
          schema: 'mpe-pos-finalization-intent-v1',
          schema_version: 1,
          source_event_id: source.source_event_id,
          document_type: source.document.type,
          operation: 'history_only',
          payload: {
            source_contract: 'mpe-pos-finalization-source-facts-v1',
            source_facts_sha256: finalizedSource.source_facts_sha256,
            completion_action: source.completion.action,
            formal_command_kind: null,
          },
        });
        const requestValue = deepFreeze({
          schema: 'mpe-pos-c06-finalization-v1',
          sourceEventId: source.source_event_id,
          documentType: source.document.type,
          sourceSnapshot: source,
          qboCommandIntent,
        });
        committed = deepFreeze({
          context,
          request: requestValue,
          result: null,
          finalized_source: finalizedSource,
          recovered: true,
        });
        lastMode = 'c06';
        return publicCommit(false);
      })();
      recoveryInFlight = { request, promise };
      try {
        return await promise;
      } finally {
        if (recoveryInFlight?.promise === promise) recoveryInFlight = null;
      }
    }

    async function beginOutput(outputKind) {
      if (!committed) refuse('finalized_source_missing');
      if (!['print', 'pdf', 'reprint'].includes(outputKind)) refuse('shape_invalid');
      if (beginRetryKind !== null && beginRetryKind !== outputKind) {
        refuse('replay_collision');
      }
      if (beginInFlight) {
        if (beginInFlight.outputKind !== outputKind) refuse('replay_collision');
        return beginInFlight.promise;
      }
      if (finishInFlight) refuse('replay_collision');
      if (activeOutput) {
        if (activeOutput.request.output_kind !== outputKind) refuse('replay_collision');
        return activeOutput.result;
      }
      const source = committed.finalized_source;
      const request = deepFreeze({
        schema: 'mpe-pos-c06-output-begin-v1',
        schema_version: 1,
        source_event_id: source.source_event_id,
        source_facts_sha256: source.source_facts_sha256,
        packet_sha256: source.packet_sha256,
        output_kind: outputKind,
      });
      const promise = (async () => {
        try {
          const rawResult = await callCapability(() => capabilities.beginOutput(request));
          const result = boundedOutputBeginResult(
            rawResult,
            request,
            source.official_document_number,
          );
          activeOutput = deepFreeze({ request, result });
          beginRetryKind = null;
          lastTerminal = null;
          return result;
        } catch (error) {
          if (error.code === 'local_integrity_uncertain') beginRetryKind = outputKind;
          else beginRetryKind = null;
          throw error;
        }
      })();
      beginInFlight = { outputKind, promise };
      try {
        return await promise;
      } finally {
        if (beginInFlight?.promise === promise) beginInFlight = null;
      }
    }

    async function finishOutput(outcome, reasonCode) {
      const validResult = (outcome === 'succeeded' && reasonCode === null)
        || (outcome === 'failed' && reasonCode === 'output_failed')
        || (outcome === 'ambiguous'
          && ['output_failed', 'output_cancelled'].includes(reasonCode));
      if (!validResult) refuse('shape_invalid');
      if (beginInFlight) await beginInFlight.promise;
      if (finishInFlight) {
        if (finishInFlight.outcome !== outcome
            || finishInFlight.reasonCode !== reasonCode) refuse('replay_collision');
        return finishInFlight.promise;
      }
      if (!activeOutput) {
        if (lastTerminal
            && lastTerminal.request.outcome === outcome
            && lastTerminal.request.reason_code === reasonCode) return lastTerminal.result;
        if (lastTerminal) refuse('replay_collision');
        refuse('finalized_source_missing');
      }
      const requested = deepFreeze({
        schema: 'mpe-pos-c06-output-finish-v1',
        schema_version: 1,
        output_attempt_id: activeOutput.result.output_attempt_id,
        outcome,
        reason_code: reasonCode,
      });
      if (pinnedFinishRequest
          && canonicalJson(pinnedFinishRequest) !== canonicalJson(requested)) {
        refuse('replay_collision');
      }
      const request = pinnedFinishRequest || requested;
      pinnedFinishRequest = request;
      const begin = activeOutput.result;
      const promise = (async () => {
        const rawResult = await callCapability(() => capabilities.finishOutput(request));
        const result = await boundedOutputAttempt(rawResult, request, begin);
        activeOutput = null;
        pinnedFinishRequest = null;
        lastTerminal = deepFreeze({ request, result });
        return result;
      })();
      finishInFlight = { outcome, reasonCode, promise };
      try {
        return await promise;
      } finally {
        if (finishInFlight?.promise === promise) finishInFlight = null;
      }
    }

    function reset() {
      if (inFlight || recoveryInFlight || retryCandidate || beginInFlight || beginRetryKind
          || finishInFlight || activeOutput || pinnedFinishRequest) {
        refuse('integrity_conflict');
      }
      committed = null;
      beginRetryKind = null;
      lastTerminal = null;
      lastMode = 'unknown';
    }

    return Object.freeze({
      current: () => publicCommit(true),
      beginOutput,
      finishOutput,
      guardArtifact,
      mode: () => lastMode,
      outputPending: () => beginInFlight !== null || beginRetryKind !== null
        || finishInFlight !== null || activeOutput !== null,
      preflight,
      probe: readStatus,
      recover,
      reset,
    });
  }

  return Object.freeze({
    LedgerFinalizationError,
    buildActionContextRequest,
    buildFinalizationRequest,
    c06DesktopV3CanonicalBytes,
    createOutputCoordinator,
  });
}));
