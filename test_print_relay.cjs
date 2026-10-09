const assert = require('assert');
const R = require('./print-relay.js');

// machine id
const id = R.newMachineId(n => Uint8Array.from({ length: n }, (_, i) => i * 17));
assert(R.MACHINE_RE.test(id) && id.startsWith('pos-') && id.length === 20, id);

// request shapes
const [u1, o1] = R.nextRequest('T', 'pos-abcdef12', true);
assert.strictEqual(u1, R.BASE + '/relay/next');
assert.strictEqual(o1.method, 'POST');
assert.strictEqual(o1.headers.Authorization, 'Bearer T');
assert.deepStrictEqual(JSON.parse(o1.body), { machine: 'pos-abcdef12', printer_ok: true, label: '' });
const d = JSON.parse(R.doneRequest('T', 'm', 'J', false, 'x'.repeat(500))[1].body);
assert.strictEqual(d.ok, false); assert.strictEqual(d.error.length, 200); assert.strictEqual(d.job, 'J');
const [u2, o2] = R.pageRequest('T', 'pos-abcdef12', '20260101T000000-abcdef', 3);
assert.strictEqual(u2, R.BASE + '/relay/page?job=20260101T000000-abcdef&n=3');
assert.strictEqual(o2.headers['X-Machine'], 'pos-abcdef12');
assert.strictEqual(R.tokenFromRows([[' tok ']]), 'tok');
assert.strictEqual(R.tokenFromRows([]), '');

// print CSS
assert(R.PRINT_CSS.includes('body.remote-printing > :not(#remotePrint)') && R.PRINT_CSS.includes('width:8.5in;height:11in'));

// guard only stops propagation while active
const handlers = {};
const win = { addEventListener: (t, f, cap) => { assert.strictEqual(cap, true); handlers[t] = f; } };
const state = { active: false };
R.installPrintGuard(win, state);
let stopped = 0;
const ev = { stopImmediatePropagation: () => stopped++ };
handlers.beforeprint(ev); handlers.afterprint(ev);
assert.strictEqual(stopped, 0);
state.active = true;
handlers.beforeprint(ev); handlers.afterprint(ev);
assert.strictEqual(stopped, 2);

// inert without mpeDesktop (or with an incomplete one)
assert.strictEqual(R.start({}), null);
assert.strictEqual(R.start({ mpeDesktop: { printReceipt() {} } }), null);
console.log('print-relay: all checks passed');
