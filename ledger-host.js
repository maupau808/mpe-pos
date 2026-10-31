/* The real MPELedgerHost for ledger.html (the fake one is ledger-host-fixture.js, ?fixture=1). It picks the environment:
 *   app      window.mpeDesktop with role 'ledger' (POSDesktop/src/ledger-tab-preload.js): printDocument, openSale, google.*
 *   website  the register in window.parent (same origin, POS/index.html): its sheetsGet / sheetsAppend / sheetsBatchUpdate,
 *            googleSessionAvailable, _emailIdentity and the token it keeps in localStorage. Nothing is forked.
 * Both use this page's own copies of email-draft.js (MIME, body) and document-renderer.js (the template filler).
 *
 * Payments tab (header row = MPELedgerData.PAYMENT_COLUMNS): rows are written durably (createPaymentsStore): saved in
 * localStorage first, appended as text, read back exactly, and only then removed locally. A row left behind (offline, a
 * failed read-back) is retried on the next load and is shown meanwhile; a payment_id already on the sheet is never sent
 * twice. A missing Payments tab shows "Payments tab not set up yet" and everything else keeps working. This file NEVER
 * creates the tab by itself: setupPaymentsTab is run once, by hand, after Trevor's go.
 *
 * Also loaded by index.html (no host there): MPELedgerHostKit.createPaymentsStore writes the 'edit' mark after an in-place
 * save of a record opened from Ledger's Edit.
 * Browser: window.MPELedgerHostKit, and window.MPELedgerHost on ledger.html. Node: module.exports. Test: node POS/test_ledger_host.cjs
 */
(function (root, factory) {
  const L = root.MPELedgerData || (typeof require === 'function' ? require('./ledger-data.js') : null);
  const api = factory(root, L);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else {
    root.MPELedgerHostKit = api;
    if (root.MPE_LEDGER_PAGE) { const env = api.environment(root); if (env) root.MPELedgerHost = api.createHost(env, root); }
  }
})(typeof globalThis === 'object' ? globalThis : this, function (root, L) {
  'use strict';
  const TXN_RANGE = 'Transactions!A:W';
  const PAY_RANGE = 'Payments!A:J';
  const PAY_APPEND = 'Payments!A1';
  const PENDING_KEY = 'mpe.ledger.pendingPayments.v1';
  const MISSING_TEXT = 'Payments tab not set up yet';
  // Screen action -> the bridge's kind (POS/ledger-tab.js, POSDesktop/src/pos-tabs.js ledgerSaleRequest).
  const SALE_KINDS = Object.freeze({ quote: 'quote-to-sale', copy: 'copy-sale', newInvoice: 'new-invoice', edit: 'edit' });
  const TITLES = { invoice: 'Invoice', quote: 'Quote', receipt: 'Receipt' };

  const s = v => String(v == null ? '' : v).trim();
  const m2 = n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const coded = (message, code) => Object.assign(new Error(message), { code });
  const notSignedIn = () => coded('Not signed in', 'not_signed_in');
  const isMissingTab = e => /Unable to parse range/i.test(s(e && e.message)); // Google's answer for a tab that does not exist
  const signedOutError = e => /not signed in|401|unauthenticated|invalid authentication|invalid_grant/i.test(s(e && e.message));
  const asText = row => row.map(v => "'" + s(v)); // USER_ENTERED keeps text as typed: no date or number guessing
  const sameRow = (a, b) => L.PAYMENT_COLUMNS.every((_, i) => s(a && a[i]) === s(b && b[i]));
  async function guard(promise) {
    try { return await promise; } catch (e) { throw signedOutError(e) ? notSignedIn() : e; }
  }

  // ---- Payments tab, durable ----
  // get(range) -> rows; append(range, rows) -> truthy, or false when signed out; storage: localStorage.
  function createPaymentsStore({ get, append, storage }) {
    let chain = Promise.resolve();
    const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
    const pending = () => { try { const v = JSON.parse(storage.getItem(PENDING_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
    function keep(rows) {
      const text = JSON.stringify(rows);
      storage.setItem(PENDING_KEY, text);
      if (storage.getItem(PENDING_KEY) !== text) throw new Error('Could not save on this computer');
    }
    async function read() {
      try { return await guard(get(PAY_RANGE)); } catch (e) { throw isMissingTab(e) ? coded(MISSING_TEXT, 'payments_missing') : e; }
    }
    // Send what is waiting, then keep only what the sheet does not show exactly. Returns the sheet rows read last.
    async function flush(sheet) {
      const queue = pending();
      if (!queue.length) return sheet;
      const onSheet = id => sheet.find(r => s(r[0]) === id);
      const missing = queue.filter(r => !onSheet(r[0]));
      if (missing.length) {
        if (await guard(append(PAY_APPEND, missing.map(asText))) === false) throw notSignedIn();
        sheet = await read();
      }
      const done = new Set(queue.filter(r => sameRow(onSheet(r[0]), r)).map(r => r[0]));
      keep(pending().filter(r => !done.has(r[0]))); // re-read: another tab may have queued meanwhile
      if (done.size < queue.length) throw new Error('A payment could not be checked on the sheet. It stays saved here and is tried again.');
      return sheet;
    }
    return {
      // Resolves only after every row reads back exactly.
      appendRows: rows => serial(async () => {
        const sheet = await read(); // a missing tab or signed-out stops here, before anything is kept
        keep([...pending(), ...rows]);
        await flush(sheet);
      }),
      // Sheet rows plus anything still waiting on this computer (so the screen matches what will land).
      readAll: () => serial(async () => {
        let sheet = await read();
        try { sheet = await flush(sheet); } catch (_) { /* kept locally; next load tries again */ }
        const ids = new Set(sheet.map(r => s(r[0])));
        return sheet.concat(pending().filter(r => !ids.has(r[0])));
      }),
      pending,
    };
  }

  // One-time setup, run by hand only after Trevor's go: adds the Payments tab and its header, then reads it back.
  async function setupPaymentsTab({ get, append, batchUpdate }) {
    const header = L.PAYMENT_COLUMNS.slice();
    let rows;
    try { rows = await get('Payments!A1:J1'); } catch (e) {
      if (!isMissingTab(e)) throw e;
      await batchUpdate([{ addSheet: { properties: { title: 'Payments' } } }]);
      rows = [];
    }
    if (rows.length && sameRow(rows[0], header)) return 'already set up';
    if (rows.length && rows[0].some(v => s(v))) throw new Error('The Payments tab has something else in row 1. Nothing was changed.');
    if (await append(PAY_APPEND, [asText(header)]) === false) throw notSignedIn();
    const back = await get('Payments!A1:J1');
    if (!back.length || !sameRow(back[0], header)) throw new Error('The Payments header could not be checked.');
    return 'created';
  }

  // ---- Ledger record -> the parsed shape History used (POS/index.html _parseTxnRows), for fillTxnIntoPOS ----
  function toHistory(r) {
    const d = s(r.date), customer = [r.name, r.company, r.street, r.city, r.region, r.zip].map(s);
    return {
      txnId: s(r.txnId), date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : d,
      time: s(r.time), name: [s(r.name), s(r.company)].filter(Boolean).join(' / '), phone: s(r.phone), email: s(r.email),
      addr: s(r.addr), total: m2(r.total), docType: s(r.docType), docNumber: s(r.number), fromQuote: s(r.fromQuote),
      customer: customer.some(Boolean) ? customer : null, presell: !!r.presell, contactConflict: !!r.contactConflict,
      completedContact: Array.isArray(r.completedContact) ? r.completedContact.slice() : null,
      items: (r.items || []).map(i => ({ pn: s(i.pn), desc: s(i.desc), qty: s(i.qty), ea: i.pn === 'Note' ? '' : m2(i.ea),
        sub: i.pn === 'Note' ? '' : m2(i.sub), sn: (i.serials || []).join(', '),
        ...(i.off > 0 && i.origEa > 0 ? { originalEa: m2(i.origEa), discountPerUnit: m2(i.off) } : {}) })),
    };
  }
  function saleRequest(kind, record) {
    const k = SALE_KINDS[kind];
    if (!k) throw new Error('unknown Ledger action ' + kind);
    return { kind: k, txn: toHistory(record) };
  }

  // ---- Environment ----
  function storageOf(w) { try { return w.localStorage; } catch (_) { return null; } }
  function environment(w) {
    const d = w.mpeDesktop;
    if (d && d.role === 'ledger' && d.google) {
      const store = storageOf(w);
      let digit = '';
      try { digit = s(store && store.getItem('mpeRegisterDigitV1')); } catch (_) { /* blocked storage */ }
      if (!/^[123]$/.test(digit)) digit = /Macintosh/.test((w.navigator && w.navigator.userAgent) || '') ? '1' : '';
      return {
        kind: 'app', place: digit, storage: store,
        signedIn: async () => { const st = await d.google.getStatus(); return !!(st && st.connected); },
        get: range => d.google.sheetsGet(range),
        append: (range, rows) => d.google.sheetsAppend(range, rows),
        identity: () => d.google.gmailIdentity(),
        createDraft: raw => d.google.createGmailDraft(raw),
        printDocument: request => d.printDocument(request),
        openSale: async request => { const r = await d.openSale(request); if (!r || !r.ok) throw new Error('The sale tab did not open'); },
        scan: typeof d.scan === 'function' ? value => d.scan(value) : undefined, // app 0.3.49+
      };
    }
    const p = w.parent;
    if (p && p !== w && typeof p.sheetsGet === 'function') {
      const token = () => { try { return p.localStorage.getItem('gToken') || ''; } catch (_) { return ''; } };
      return {
        kind: 'web', place: '9', storage: storageOf(w),
        signedIn: async () => !!p.googleSessionAvailable(),
        get: range => p.sheetsGet(range, { retryThrottle: false }),
        append: (range, rows) => p.sheetsAppend(range, rows),
        batchUpdate: requests => p.sheetsBatchUpdate(requests),
        identity: () => p._emailIdentity(token()),
        async createDraft(raw) {
          const resp = await w.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { raw } }),
          });
          if (resp.status === 401 || resp.status === 403) throw notSignedIn();
          const data = await resp.json();
          if (!resp.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + resp.status);
          return data;
        },
        openSale: async request => { p.postMessage(request, w.location.origin); },
      };
    }
    return null;
  }

  // ---- The host the page uses (contract: POS/ledger.js header) ----
  function createHost(env, w) {
    const doc = w && w.document;
    const store = createPaymentsStore({ get: env.get, append: env.append, storage: env.storage });
    let cycle = null;
    function note(text) {
      const el = doc && doc.getElementById('hostNote');
      if (el) { el.textContent = text; el.hidden = !text; }
    }
    function payments() { // readPayments and readMarks share one read per load
      if (cycle) return cycle;
      const run = store.readAll().then(rows => { note(''); return rows; }, e => {
        if (e.code !== 'payments_missing') throw e;
        note(MISSING_TEXT);
        return [L.PAYMENT_COLUMNS.slice()];
      });
      cycle = run;
      run.then(() => { cycle = null; }, () => { cycle = null; });
      return run;
    }
    async function signedIn() { if (!(await guard(env.signedIn()))) throw notSignedIn(); }
    async function mark(kind, record) { // a mark that cannot be stored (no Payments tab) is skipped, never blocks
      try { await store.appendRows([L.buildMarkRow({ kind, txnId: record.txnId, invoice_number: record.number, place: env.place })]); }
      catch (e) { if (e.code !== 'payments_missing') throw e; }
    }
    function pages(request) {
      const R = w.MPEDocumentRenderer, P = w.MPELedger;
      return readTemplate().then(t => P.documentPages(request, R, t, host.documentSettings));
    }
    let template = null;
    function readTemplate() {
      if (template) return template;
      template = new Promise((ok, fail) => {
        const x = new w.XMLHttpRequest();
        x.open('GET', 'document-template.html');
        x.onload = () => (x.status === 200 ? ok(x.responseText) : fail(new Error('template')));
        x.onerror = () => fail(new Error('template'));
        x.send();
      });
      template.catch(() => { template = null; });
      return template;
    }
    async function frameFor(html) {
      const frame = doc.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;height:1056px;border:0';
      frame.setAttribute('aria-hidden', 'true');
      doc.body.append(frame);
      await new Promise(ok => { frame.onload = ok; frame.srcdoc = html; });
      return frame;
    }
    // Browser print of the filled template (website, or the app's fallback for receipts / no cached template).
    async function printPages(list) {
      for (const html of list) {
        const frame = await frameFor(html);
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { frame.remove(); }
      }
    }
    // The customer copy as a PDF, base64, for the email attachment.
    async function pdfB64(html) {
      if (typeof w.html2canvas !== 'function' || typeof w.html2pdf !== 'function') throw new Error('The PDF maker did not load');
      const frame = await frameFor(html);
      try {
        const canvas = await w.html2canvas(frame.contentDocument.documentElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 816 });
        const blob = await w.html2pdf().set({ margin: 0, image: { type: 'jpeg', quality: 0.98 }, jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' } })
          .from(canvas, 'canvas').outputPdf('blob');
        return await w._blobToB64(blob);
      } finally { frame.remove(); }
    }

    const host = {
      environment: env.kind,
      place: env.place,
      honoluluToday: () => L.honoluluToday(),
      async readTransactions() { await signedIn(); return guard(env.get(TXN_RANGE)); },
      readPayments: () => payments(),
      async readMarks() { return L.parseMarks(await payments()); },
      appendPaymentRows: rows => store.appendRows(rows),
      async reprint(record, request) {
        if (env.printDocument && request.type !== 'receipt') {
          const r = await env.printDocument(request);
          if (r && r.ok) return;
          if (!(r && r.fallback)) throw new Error('The printer did not take it');
        }
        await printPages(await pages(request));
      },
      async emailDraft(record, request) {
        if (!s(record.email)) throw new Error('No email on file');
        const title = TITLES[request.type] || 'Receipt', number = request.number;
        const [identity, list] = await Promise.all([guard(env.identity()), pages(request)]);
        const pdf = await pdfB64(list[0]);
        const t = request.totals;
        const order = { customer: { name: record.name }, toggles: { cardFee: Number(t.card_fee) > 0 },
          ledgerTotals: { subtotal: t.subtotal, tax: t.tax, card_fee: t.card_fee, total: t.total },
          items: (record.items || []).map(i => ({ pn: i.pn, desc: i.desc, qty: i.qty, ea: i.ea, sub: i.sub, sn: i.serials })) };
        const day = record.date ? new Date(record.date + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
        const body = w.buildEmailBody(order, title, number, day, identity.signature || '');
        const raw = w._b64UrlUtf8(w._buildEmailMime(record.email, `${title} ${number} - Maui Power Equipment`, body.text,
          number + '.pdf', pdf, body.html, identity.email));
        await guard(env.createDraft(raw));
        await mark('email_draft', record);
      },
      openInNewSale: ({ kind, txn }) => env.openSale(saleRequest(kind, txn)),
      // A keyboard-style scan caught on this page goes to the last sale tab (app only; the website's register catches its own).
      scan: env.scan,
      // One-time, by hand, after Trevor's go (website only: the app's Ledger tab has no tab-adding permission).
      setupPaymentsTab: env.batchUpdate ? () => setupPaymentsTab(env) : undefined,
    };
    return host;
  }

  return { SALE_KINDS, PENDING_KEY, MISSING_TEXT, createPaymentsStore, setupPaymentsTab, toHistory, saleRequest, environment, createHost };
});
