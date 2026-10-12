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

// heartbeat label
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MPE POS/0.3.22 Chrome/140.0.7339.80 Electron/43.4.0 Safari/537.36';
assert.strictEqual(R.desktopVersion(ua), '0.3.22');
assert.strictEqual(R.desktopVersion('Mozilla/5.0 Chrome/140.0 Safari/537.36'), '');
assert.strictEqual(R.machineLabel('win32', '2026.10.11.1', ua, 'Brother HL'), 'Windows · POS 2026.10.11.1 · App 0.3.22 · Brother HL');
assert.strictEqual(R.machineLabel('darwin', '', '', ''), 'Mac');
assert.strictEqual(R.machineLabel('win32', '2026.10.11.1', ua, 'x'.repeat(200)).length, 100);
assert(R.machineLabel('win32', '2026.10.11.1', ua, 'x'.repeat(200)).startsWith('Windows · POS 2026.10.11.1 · App 0.3.22 · '));

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
