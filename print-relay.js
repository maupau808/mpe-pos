/* Counter-side remote print relay (Trevor-approved exception).
 * Pulls documents queued from the laptop (Cloud Run /relay/*) and prints them
 * through mpeDesktop.printReceipt OUTSIDE prepareAndSaveForPrint. It never
 * touches sale, history, Bridge or localStorage beyond 'mpe_relay_machine'.
 * Inert unless the Desktop bridge (printReceipt, getPrintStatus, google.sheetsGet) exists.
 * Load as a classic script BEFORE index.html's inline scripts (beside ledger-contact.js): listeners
 * on window run in registration order (capture does not jump ahead at window, verified headless),
 * so the print guard must be registered first. DOM setup waits for DOMContentLoaded. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.MPEPrintRelay = api; api.start(root); }
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const BASE = 'https://mpe-mobile-539388267026.us-central1.run.app';
  const POLL_MS = 15000, BACKOFF_MS = 60000, TOKEN_MS = 3600000, BUSY_MS = 5000, BUSY_MAX_MS = 60000;
  const MACHINE_RE = /^[A-Za-z0-9_-]{8,40}$/;
  const PRINT_CSS = '#remotePrint{display:none}' +
    '@media print{body.remote-printing > :not(#remotePrint){display:none !important}' +
    'body.remote-printing #remotePrint{display:block !important}' +
    'body.remote-printing #remotePrint img{display:block;width:8.5in;height:11in;object-fit:contain;page-break-after:always;break-after:page}' +
    'body.remote-printing #remotePrint img:last-child{page-break-after:auto;break-after:auto}}';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function newMachineId(random) {
    const bytes = random(8);
    return 'pos-' + Array.from(bytes, b => (b & 255).toString(16).padStart(2, '0')).join('');
  }
  function jsonRequest(token, path, body) {
    return [BASE + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }];
  }
  const nextRequest = (token, machine, printerOk) => jsonRequest(token, '/relay/next', { machine, printer_ok: !!printerOk });
  const doneRequest = (token, machine, job, ok, error) =>
    jsonRequest(token, '/relay/done', { machine, job, ok: !!ok, error: String(error || '').slice(0, 200) });
  const pageRequest = (token, machine, job, n) =>
    [BASE + '/relay/page?job=' + encodeURIComponent(job) + '&n=' + n, { headers: { Authorization: 'Bearer ' + token, 'X-Machine': machine }, signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined }];

  // Stops page print handlers from running only while a relay job is printing.
  function installPrintGuard(win, state) {
    const stop = e => {
      if (!state.active) return;
      e.stopImmediatePropagation();
      if (e.type === 'afterprint' && state.afterPrint) state.afterPrint();
    };
    win.addEventListener('beforeprint', stop, true);
    win.addEventListener('afterprint', stop, true);
  }

  function tokenFromRows(rows) {
    const rowset = Array.isArray(rows) ? rows : rows && rows.values;
    const t = rowset && rowset[0] && rowset[0][0];
    return typeof t === 'string' && t.trim() ? t.trim() : '';
  }

  async function printJob(env, job) {
    const { win, doc, state, token, machine } = env;
    const urls = [];
    const host = doc.getElementById('remotePrint');
    try {
      // Fetch and decode every page BEFORE taking the register's output lock, so a slow network never blocks a sale print.
      const imgs = [];
      for (let n = 1; n <= job.pages; n++) {
        const res = await env.fetch(...pageRequest(token, machine, job.id, n));
        if (!res.ok) throw new Error('page ' + n + ' HTTP ' + res.status);
        const url = win.URL.createObjectURL(await res.blob());
        urls.push(url);
        const img = doc.createElement('img');
        img.src = url;
        imgs.push(img);
        host.appendChild(img);
      }
      await Promise.all(imgs.map(i => i.decode()));
      if (typeof win.claimPhysicalOutput === 'function') {
        let owner = win.claimPhysicalOutput(), waited = 0;
        while (!owner && waited < BUSY_MAX_MS) { await sleep(BUSY_MS); waited += BUSY_MS; owner = win.claimPhysicalOutput(); }
        if (!owner) throw new Error('register busy');
        state.owner = owner;
      }
      state.active = true;
      doc.body.classList.add('remote-printing');
      // Keep the guard up until afterprint has fired (it can land after printReceipt resolves).
      const after = new Promise(r => { state.afterPrint = r; setTimeout(r, 60000); });
      await win.mpeDesktop.printReceipt({});
      await after;
    } finally {
      state.afterPrint = null;
      doc.body.classList.remove('remote-printing');
      host.textContent = '';
      urls.forEach(u => win.URL.revokeObjectURL(u));
      if (state.owner && typeof win.releasePhysicalOutput === 'function') win.releasePhysicalOutput(state.owner);
      state.owner = null;
      state.active = false;
    }
  }

  async function tick(env) {
    const { win, state } = env;
    if (!state.token || Date.now() - state.tokenAt > TOKEN_MS) {
      state.tokenAt = Date.now();
      try { state.token = tokenFromRows(await win.mpeDesktop.google.sheetsGet('Lists!Z1')); } catch (e) { state.token = ''; }
      if (!state.token) return TOKEN_MS;
    }
    let ok = false;
    try { ok = !!(await win.mpeDesktop.getPrintStatus()).ready; } catch (e) { ok = false; }
    const res = await env.fetch(...nextRequest(state.token, state.machine, ok));
    if (res.status === 401) { state.token = ''; return TOKEN_MS; }
    if (res.status === 204) return POLL_MS;
    if (!res.ok) return BACKOFF_MS;
    const job = (await res.json()).job;
    if (!job) return POLL_MS;
    let err = '';
    try { await printJob({ ...env, token: state.token, machine: state.machine }, job); } catch (e) { err = (e && e.message) || 'print failed'; }
    await env.fetch(...doneRequest(state.token, state.machine, job.id, !err, err));
    return 0;
  }

  function start(win) {
    const d = win && win.mpeDesktop;
    if (!d || typeof d.printReceipt !== 'function' || typeof d.getPrintStatus !== 'function' || !d.google || typeof d.google.sheetsGet !== 'function') return null;
    const doc = win.document;
    const state = { active: false, owner: null, token: '', tokenAt: 0, machine: '' };
    try { state.machine = win.localStorage.getItem('mpe_relay_machine') || ''; } catch (e) {}
    if (!MACHINE_RE.test(state.machine)) {
      state.machine = newMachineId(n => win.crypto.getRandomValues(new Uint8Array(n)));
      try { win.localStorage.setItem('mpe_relay_machine', state.machine); } catch (e) {}
    }
    installPrintGuard(win, state);
    if (!doc.body) { doc.addEventListener('DOMContentLoaded', () => setup(win, doc, state)); return state; }
    setup(win, doc, state);
    return state;
  }

  function setup(win, doc, state) {
    const style = doc.createElement('style');
    style.textContent = PRINT_CSS;
    doc.head.appendChild(style);
    const host = doc.createElement('div');
    host.id = 'remotePrint';
    doc.body.appendChild(host);
    const env = { win, doc, state, fetch: (...a) => win.fetch(...a) };
    const loop = async () => {
      for (;;) {
        let wait;
        try { wait = await tick(env); } catch (e) { wait = BACKOFF_MS; }
        if (wait) await sleep(wait);
      }
    };
    if (win.navigator && win.navigator.locks) win.navigator.locks.request('mpe-print-relay', loop);
  }

  return Object.freeze({ BASE, MACHINE_RE, PRINT_CSS, newMachineId, nextRequest, doneRequest, pageRequest, installPrintGuard, tokenFromRows, start });
});
