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
 * Customers tab (header Company, Contact, Phone, Email, Street, City, State, Zip, Added + J "QBO Id"): History edits append ONE
 * row here through the same store (createRowStore with the Customers settings), so the durability is identical. A missing
 * Customers tab reads as no rows; saving then says so. History never creates the tab or its header.
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
  const TXN_RANGE = 'Transactions!A:X';
  const PAY_RANGE = 'Payments!A:J';
  const PAY_APPEND = 'Payments!A1';
  const CUST_RANGE = 'Customers!A:J';
  const CUST_APPEND = 'Customers!A1';
  const CUST_PENDING_KEY = 'mpe.ledger.pendingCustomers.v1';
  const CUST_MISSING_TEXT = 'Customers tab not set up yet';
  const QBO_FILE_ID = '1TVEYXRKC8E_Db-46IUBPSCkQaBBROWBF'; // "MPE QuickBooks History.json.gz" in the private Drive folder (read-only copy)
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
  const sameCols = (cols, a, b) => cols.every((_, i) => s(a && a[i]) === s(b && b[i]));
  const sameRow = (a, b) => sameCols(L.PAYMENT_COLUMNS, a, b);
  // What a durable store needs to know about one tab. A row is "on the sheet" when a sheet row has the same id.
  const PAY_TAB = { range: PAY_RANGE, appendRange: PAY_APPEND, pendingKey: PENDING_KEY, missingText: MISSING_TEXT, missingCode: 'payments_missing',
    noun: 'payment', idOf: r => s(r[0]), same: sameRow };
  const CUST_TAB = { range: CUST_RANGE, appendRange: CUST_APPEND, pendingKey: CUST_PENDING_KEY, missingText: CUST_MISSING_TEXT, missingCode: 'customers_missing',
    noun: 'customer change', idOf: r => L.CUSTOMER_COLUMNS.map((_, i) => s(r && r[i])).join('\u0001'), same: (a, b) => sameCols(L.CUSTOMER_COLUMNS, a, b) };
  async function guard(promise) {
    try { return await promise; } catch (e) { throw signedOutError(e) ? notSignedIn() : e; }
  }

  // ---- Durable tab writes (Payments, Customers) ----
  // get(range) -> rows; append(range, rows) -> truthy, or false when signed out; storage: localStorage. tab: PAY_TAB or CUST_TAB.
  function createRowStore({ get, append, storage }, tab) {
    const { range, appendRange, pendingKey, idOf, same } = tab;
    let chain = Promise.resolve();
    const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
    const pending = () => { try { const v = JSON.parse(storage.getItem(pendingKey) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
    function keep(rows) {
      const text = JSON.stringify(rows);
      storage.setItem(pendingKey, text);
      if (storage.getItem(pendingKey) !== text) throw new Error('Could not save on this computer');
    }
    async function read() {
      try { return await guard(get(range)); } catch (e) { throw isMissingTab(e) ? coded(tab.missingText, tab.missingCode) : e; }
    }
    // Send what is waiting, then keep only what the sheet does not show exactly. Returns the sheet rows read last.
    async function flush(sheet) {
      const queue = pending();
      if (!queue.length) return sheet;
      const onSheet = id => sheet.find(r => idOf(r) === id);
      const missing = queue.filter(r => !onSheet(idOf(r)));
      if (missing.length) {
        if (await guard(append(appendRange, missing.map(asText))) === false) throw notSignedIn();
        sheet = await read();
      }
      const done = new Set(queue.filter(r => same(onSheet(idOf(r)), r)).map(idOf));
      keep(pending().filter(r => !done.has(idOf(r)))); // re-read: another tab may have queued meanwhile
      if (done.size < queue.length) throw new Error(`A ${tab.noun} could not be checked on the sheet. It stays saved here and is tried again.`);
      return sheet;
    }
    return {
      // Resolves only after every row reads back exactly.
      appendRows: rows => serial(async () => {
        const sheet = await read(); // a missing tab or signed-out stops here, before anything is kept
        const waiting = new Set(pending().map(idOf)); // the same row sent again (a retry after a crash) is never queued twice
        keep([...pending(), ...rows.filter(r => !waiting.has(idOf(r)))]);
        await flush(sheet);
      }),
      // Sheet rows plus anything still waiting on this computer (so the screen matches what will land).
      readAll: () => serial(async () => {
        let sheet = await read();
        try { sheet = await flush(sheet); } catch (_) { /* kept locally; next load tries again */ }
        const ids = new Set(sheet.map(idOf));
        return sheet.concat(pending().filter(r => !ids.has(idOf(r))));
      }),
      pending,
    };
  }

  const createPaymentsStore = deps => createRowStore(deps, PAY_TAB);

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
      addr: s(r.addr), total: m2(r.total), docType: s(r.docType), docNumber: s(r.number), fromQuote: s(r.fromQuote), po: s(r.po),
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

  // ---- Edit session on the website: a hidden frame running the register page, answering once ----
  const EDIT_TIMEOUT_MS = 120000;
  function webEditSession(p, request) {
    return new Promise(resolve => {
      const doc = p.document, base = { v: 1, sessionId: request.sessionId, txnId: request.txn.txnId, ok: false };
      const frame = doc.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.title = 'Saving an edit';
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0';
      let timer = null, done = false;
      const finish = result => {
        if (done) return;
        done = true; clearTimeout(timer);
        p.removeEventListener('message', onMessage);
        frame.remove();
        resolve(result);
      };
      const onMessage = event => {
        if (event.source !== frame.contentWindow || event.origin !== p.location.origin || !event.data) return;
        if (event.data.type === 'edit-ready') frame.contentWindow.postMessage({ type: 'edit-session', request }, p.location.origin);
        else if (event.data.type === 'edit-result' && event.data.result && event.data.result.sessionId === request.sessionId) finish(event.data.result);
      };
      p.addEventListener('message', onMessage);
      timer = setTimeout(() => finish({ ...base, code: 'timeout', message: 'The edit took too long. Check History before trying again.' }), EDIT_TIMEOUT_MS);
      frame.src = new URL('index.html?mpeEditSession=1', p.location.href).href;
      doc.body.append(frame);
    });
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
        sendMail: typeof d.google.sendGmail === 'function' ? raw => d.google.sendGmail(raw) : undefined, // app 0.3.61+
        printDocument: request => d.printDocument(request),
        // Helcim pay links (app only; the Ledger tab's preload adds it once the app can talk to Helcim). Never on the website.
        helcim: d.helcim && typeof d.helcim.payLink === 'function' ? d.helcim : undefined,
        openSale: async request => { const r = await d.openSale(request); if (!r || !r.ok) throw new Error('The sale tab did not open'); },
        // App 0.3.64+: save customer fields through a hidden register page. Present only when the app says it can (never guessed from a method).
        editSession: d.editCapabilities && d.editCapabilities.silentEdit && typeof d.editSession === 'function' ? request => d.editSession(request) : undefined,
        pdfRefresh: !!(d.editCapabilities && d.editCapabilities.pdfSave),
        scan: typeof d.scan === 'function' ? value => d.scan(value) : undefined, // app 0.3.49+
        setType: typeof d.setType === 'function' ? (id, num, from, to) => d.setType(id, num, from, to) : undefined, // app 0.3.57+
        openPdf: typeof d.openPdf === 'function' ? number => d.openPdf(number) : undefined, // app 0.3.52+
        // Mac app only: main exposes qboRefresh on darwin, so Windows has none and History says "Refresh on the Mac".
        refreshQbo: typeof d.qboRefresh === 'function' ? () => d.qboRefresh() : undefined,
        // Main downloads, gunzips and keeps the copy; { unchanged: true } or { text, modifiedTime }.
        qboHistory: typeof d.qboHistory === 'function' ? async known => {
          const r = await d.qboHistory(known);
          return r && r.text ? { data: JSON.parse(r.text), modifiedTime: r.modifiedTime } : r;
        } : undefined,
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
        // Change to (website): the same checked one-cell write the app's main process does (google-service setTransactionType).
        setType: typeof p.sheetsUpdate === 'function' ? async (id, num, from, to) => {
          const rows = await p.sheetsGet('Transactions!A:P', { retryThrottle: false });
          const at = rows.findIndex(r => s(r[0]).toUpperCase() === 'TXN' && s(r[1]) === id);
          if (at < 0) throw new Error('Sale not found on the sheet');
          if (s(rows[at][15]) !== s(num) || s(rows[at][14]).toLowerCase() !== from) throw new Error('The sale changed. Reload History and try again.');
          await p.sheetsUpdate(`Transactions!O${at + 1}`, [[to]]);
          const back = await p.sheetsGet(`Transactions!O${at + 1}`, { retryThrottle: false });
          if (s((back[0] || [])[0]) !== to) throw new Error('The new type could not be verified');
          return { ok: true };
        } : undefined,
        identity: () => p._emailIdentity(token()),
        async sendMail(raw) { // the email window's Send (a person presses it)
          const resp = await w.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw }),
          });
          if (resp.status === 401 || resp.status === 403) throw notSignedIn();
          const data = await resp.json();
          if (!resp.ok || !data.id) throw new Error((data.error && data.error.message) || 'HTTP ' + resp.status);
          return data;
        },
        openSale: async request => { p.postMessage(request, w.location.origin); },
        // The website saves an edit in a hidden copy of the register (same origin, same saved data), so the sale on screen is never touched.
        editSession: request => webEditSession(p, request),
        pdfRefresh: false,
        // The page's own Google token (drive.readonly) reads the file; kept in memory for the life of the page.
        qboHistory: typeof w.DecompressionStream === 'function' ? async known => {
          if (known === 'web') return { unchanged: true };
          const resp = await w.fetch('https://www.googleapis.com/drive/v3/files/' + QBO_FILE_ID + '?alt=media', { headers: { Authorization: 'Bearer ' + token() } });
          if (resp.status === 401 || resp.status === 403) throw notSignedIn();
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
          return { data: await new w.Response(resp.body.pipeThrough(new w.DecompressionStream('gzip'))).json(), modifiedTime: 'web' };
        } : undefined,
      };
    }
    return null;
  }

  // ---- The host the page uses (contract: POS/ledger.js header) ----
  function createHost(env, w) {
    const doc = w && w.document;
    const store = createPaymentsStore({ get: env.get, append: env.append, storage: env.storage });
    const customers = createRowStore({ get: env.get, append: env.append, storage: env.storage }, CUST_TAB);
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
    // A timeline mark for an output (print, PDF): never blocks or fails the print itself.
    async function quietMark(kind, record, note) {
      try { await store.appendRows([L.buildMarkRow({ kind, txnId: record.txnId, invoice_number: record.number, place: env.place, note })]); }
      catch (e) { if (w && w.console) w.console.warn('[MPE] History mark skipped:', e && e.message); }
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
    // Browser print of the filled template (website, or the app's fallback when it has no cached template).
    async function printPages(list) {
      for (const html of list) {
        const frame = await frameFor(html);
        // In the app print() returns before the dialog reads the page, so keep the frame until afterprint (or a minute).
        try {
          const done = new Promise(ok => { frame.contentWindow.addEventListener('afterprint', ok, { once: true }); setTimeout(ok, 60000); });
          frame.contentWindow.focus(); frame.contentWindow.print();
          await done;
        } finally { frame.remove(); }
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
      // An app older than the PO column refuses A:X; fall back to A:W so History still opens (PO # blank) until it updates.
      async readTransactions() { await signedIn(); try { return await guard(env.get(TXN_RANGE)); } catch (e) { if (e && e.code === 'not_signed_in') throw e; return guard(env.get('Transactions!A:W')); } },
      readPayments: () => payments(),
      async readMarks() { return L.parseMarks(await payments()); },
      appendPaymentRows: rows => store.appendRows(rows),
      // The Customers tab (A:J) plus any edit still waiting on this computer; a missing tab reads as no rows.
      async readCustomers() {
        try { return await customers.readAll(); } catch (e) { if (e.code === 'customers_missing') return []; throw e; }
      },
      appendCustomerRows: rows => customers.appendRows(rows),
      async reprint(record, request) {
        // Every type, receipts too: the app prints the filled template to the counter printer (browser print is a no-op there).
        if (env.printDocument) {
          const r = await env.printDocument(request);
          if (r && r.ok) { if (r.printed !== false) await quietMark('print', record, 'reprint'); return r; } // { printed: false }: closed without printing
          if (!(r && r.fallback)) throw new Error('The printer did not take it');
        }
        await printPages(await pages(request));
        await quietMark('print', record, 'reprint');
      },
      // The email window's starting fields and the document pages it shows (and attaches). Nothing is sent here.
      async emailPrepare(record, request, payLink) { // payLink (optional): the invoice's Helcim pay page, from its 'paylink' mark
        const title = TITLES[request.type] || 'Receipt', number = request.number;
        const [identity, list] = await Promise.all([guard(env.identity()), pages(request)]);
        const t = request.totals;
        const order = { payLink: s(payLink), customer: { name: record.name }, toggles: { cardFee: Number(t.card_fee) > 0 },
          ledgerTotals: { subtotal: t.subtotal, tax: t.tax, card_fee: t.card_fee, total: t.total },
          items: (record.items || []).map(i => ({ pn: i.pn, desc: i.desc, qty: i.qty, ea: i.ea, sub: i.sub, sn: i.serials })) };
        const day = record.date ? new Date(record.date + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
        return { from: identity.email, accountEmail: identity.accountEmail || identity.email, signature: identity.signature || '', to: s(record.email), pages: [list[0]], attachment: number + '.pdf',
          subject: `${title} ${number} - Maui Power Equipment`, message: w.buildEmailBody(order, title, number, day, '').text, canSend: !!env.sendMail };
      },
      // Send: only from the email window's Send button. Then one 'email_sent' mark (note = who it went to) for the timeline.
      async sendEmail(record, prep, f) {
        if (!env.sendMail) throw new Error('This app needs its update to send email.');
        const pdf = await pdfB64(prep.pages[0]);
        const raw = w._b64UrlUtf8(w._buildEmailMime(f.to, f.subject, f.text, prep.attachment, pdf, f.html, prep.from, f.cc, f.bcc));
        await guard(env.sendMail(raw));
        await quietMark('email_sent', record, [f.to, f.cc].filter(Boolean).join(', ').slice(0, 300));
      },
      openInNewSale: ({ kind, txn }) => env.openSale(saleRequest(kind, txn)),
      // Customer fields on one saved document, saved by the register in the background. Missing on an older app (fields stay read-only).
      // patch: only the fields that changed (a cleared field is ''), plus updateInfo. Resolves with the register's one result.
      editSession: env.editSession ? async (record, patch, extra) => {
        const fingerprint = s(record.fingerprint);
        const base = { v: 1, ok: false, txnId: s(record.txnId) };
        if (!fingerprint) return { ...base, code: 'open_sale_screen', message: 'This one has to be changed on the sale screen. Nothing was changed.' };
        const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        const out = await env.editSession({ v: 1, kind: 'edit', mode: 'silent', sessionId: id, txn: { ...toHistory(record), cardFee: !!(extra && extra.cardFee) }, loaded: { fingerprint }, patch });
        return out && typeof out === 'object' ? out : { ...base, sessionId: id, code: 'closed', message: 'The edit closed before it finished. Check History before trying again.' };
      } : undefined,
      // Transactions saved on THIS computer and not yet on the sheet (History reads the sheet, so it must say so). A set of txnIds.
      pendingTxnIds() {
        try {
          const list = JSON.parse((env.storage && env.storage.getItem('mpe_print_history')) || '[]');
          return new Set((Array.isArray(list) ? list : []).filter(o => o && o.historySyncPending && !o.needsLook).map(o => s(o.txnId)));
        } catch (_) { return new Set(); }
      },
      parkedTxnIds() {
        try {
          const list = JSON.parse((env.storage && env.storage.getItem('mpe_print_history')) || '[]');
          return new Set((Array.isArray(list) ? list : []).filter(o => o && o.needsLook && o.historySyncPending).map(o => s(o.txnId)));
        } catch (_) { return new Set(); }
      },
      // A keyboard-style scan caught on this page goes to the last sale tab (app only; the website's register catches its own).
      scan: env.scan,
      openPdf: env.openPdf ? async (number, record) => {
        const res = await env.openPdf(number);
        if (res && res.ok && record) await quietMark('pdf_open', record);
        return res;
      } : undefined,
      // Change a sale's type in place (invoice, receipt, quote). Missing on app 0.3.56 and older.
      setType: env.setType ? (record, to) => guard(env.setType(record.txnId, record.number, record.kind, to)) : undefined,
      refreshQbo: env.refreshQbo,
      helcim: env.helcim, // { ready, payLink, status } or undefined
      readQboHistory: env.qboHistory ? known => guard(env.qboHistory(known)) : undefined,
      // One-time, by hand, after Trevor's go (website only: the app's Ledger tab has no tab-adding permission).
      setupPaymentsTab: env.batchUpdate ? () => setupPaymentsTab(env) : undefined,
    };
    return host;
  }

  return { QBO_FILE_ID, SALE_KINDS, PENDING_KEY, MISSING_TEXT, CUST_PENDING_KEY, createPaymentsStore, createRowStore, CUST_TAB, setupPaymentsTab, toHistory, saleRequest, environment, createHost };
});
