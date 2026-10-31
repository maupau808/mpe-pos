/* Ledger page (POS/ledger.html). Pure view model + the page's UI. Browser: window.MPELedger. Node: module.exports (pure parts).
 *
 * Data: MPELedgerData (ledger-data.js) only. Every outside effect goes through ONE adapter, window.MPELedgerHost:
 *   readTransactions()        -> Promise<rows A:W of the Transactions tab>
 *   readPayments()            -> Promise<rows of the Payments tab (PAYMENT_COLUMNS order; header row allowed)>
 *   readMarks()   (optional)  -> Promise<{ drafts: {txnId|number: 'YYYY-MM-DD'}, edits: {txnId: 'YYYY-MM-DD'} }>
 *   appendPaymentRows(rows)   -> Promise; resolves only after the durable write (save locally, append, read back)
 *   renderDocument(request)   (optional) -> Promise<html pages>; without it the page fills document-template.html itself
 *                                with window.MPEDocumentRenderer (POSDesktop/src/document-renderer.js), the same filler the app prints with
 *   reprint(record, request)  -> Promise; prints `request` (the exact document shown) via printDocument
 *   emailDraft(record, request) -> Promise; makes a Gmail draft, never sends
 *   openInNewSale({ kind: 'quote' | 'copy' | 'newInvoice' | 'edit', txn: record }) -> Promise; opens a NEW sale tab
 *   honoluluToday()           -> 'YYYY-MM-DD'
 *   place         (optional)  -> '1' Mac, '2' PC Left, '3' PC Right, '9' web; stamped on payment rows
 *   documentSettings (optional) -> the app's saved Document settings; defaults to the renderer's DEFAULT_SETTINGS
 * A rejected call whose error has code 'not_signed_in' shows the signed-out state.
 */
(function (root, factory) {
  const L = root.MPELedgerData || (typeof require === 'function' ? require('./ledger-data.js') : null);
  const api = factory(root, L);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else { root.MPELedger = api; if (root.document) api.boot(); }
})(typeof globalThis === 'object' ? globalThis : this, function (root, L) {
  'use strict';
  const TAX_RATE = 0.04712; // POS/index.html TAX_RATE
  const QUOTE_DAYS = 30;
  const PLACES = { 1: 'Mac', 2: 'PC Left', 3: 'PC Right', 9: 'Web' };
  const METHOD_LABEL = { cash: 'Cash', check: 'Check', card_terminal: 'Card terminal' };
  const KIND_LABEL = { invoice: 'Invoice', quote: 'Quote', receipt: 'Sale' };
  const STORE_KEY = 'mpe.ledger.ui';
  const UNPAID = new Set(['unpaid', 'dueSoon', 'overdue']);

  const s = v => String(v == null ? '' : v).trim();
  const cents = n => Math.round(n * 100) / 100;
  const m2 = n => { const v = cents(n); return (Object.is(v, -0) ? 0 : v).toFixed(2); };
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = v => s(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dayNum = iso => { const [y, mo, d] = iso.split('-').map(Number); return Date.UTC(y, mo - 1, d) / 864e5; };
  const addDays = (iso, n) => new Date((dayNum(iso) + n) * 864e5).toISOString().slice(0, 10);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtD = iso => { if (!iso) return ''; const [, mo, d] = iso.split('-').map(Number); return `${MONTHS[mo - 1]} ${d}`; };
  const fmtDY = iso => iso ? `${fmtD(iso)}, ${iso.slice(0, 4)}` : '';
  const placeOf = number => PLACES[s(number).charAt(1)] || '';
  // ledger-data.js puts the address state (column U) in r.state and then overwrites r.state with the paid status, so the
  // region is read back from the joined address (column H: "street, city, state, zip"). Drop this once ledger-data keeps it.
  const regionOf = r => { if (s(r.region)) return s(r.region); const p = s(r.addr).split(',').map(x => x.trim()); return p.length >= 3 ? p[p.length - 2] : ''; };
  // No customer: name the sale by its highest-value line, as Oldger did.
  const topItem = r => (r.items || []).filter(i => i.pn !== 'Note').reduce((a, i) => (!a || i.sub > a.sub ? i : a), null);
  const who = r => r.company || r.name || (topItem(r) && (topItem(r).desc || topItem(r).pn)) || 'No items';
  const fmtT = t => s(t).replace(/^0(?=\d:)/, '');
  const minutes = t => { const x = /(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(s(t)); if (!x) return 0; let h = +x[1] % 12; if (/p/i.test(x[3] || '')) h += 12; return h * 60 + +x[2]; };
  const newest = (a, b) => (b.date || '').localeCompare(a.date || '') || minutes(b.time) - minutes(a.time) || s(b.number).localeCompare(s(a.number));
  const byDue = (a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9') || s(a.number).localeCompare(s(b.number));

  // Links between records: quote -> the sale made from it; replacement invoice -> the void one it replaces.
  function decorate(records) {
    const byId = new Map(records.map(r => [r.txnId, r]));
    for (const r of records) {
      const src = byId.get(r.fromQuote);
      if (!src || src === r) continue;
      if (src.kind === 'quote' && r.kind !== 'quote') { src.convertedTo = r.number || r.txnId; r.madeFromQuote = src.number || src.txnId; }
      if (src.kind === 'invoice' && r.kind === 'invoice') r.replaces = src.number || src.txnId;
    }
    for (const r of records) if (r.kind === 'quote') r.goodUntil = r.date ? addDays(r.date, QUOTE_DAYS) : '';
    return records;
  }

  // One status per record: the list text, its tone and the pill.
  function statusOf(r, today) {
    if (r.kind === 'receipt') return { key: 'sale', tone: 'muted', text: 'Register sale', pill: 'Register sale' };
    if (r.kind === 'quote') return r.convertedTo
      ? { key: 'converted', tone: 'muted', text: `Now ${r.convertedTo}`, pill: `Turned into sale ${r.convertedTo}` }
      : { key: 'quote', tone: 'quote', text: r.goodUntil ? `Good to ${fmtD(r.goodUntil)}` : 'Quote', pill: r.goodUntil ? `Quote · good to ${fmtD(r.goodUntil)}` : 'Quote' };
    if (r.state === 'void') return { key: 'void', tone: 'void', text: `Void · see ${r.replacedBy}`, pill: 'Void' };
    if (r.state === 'paid') {
      const how = METHOD_LABEL[r.paidMethod] || 'Paid';
      return { key: 'paid', tone: 'paid', text: `Paid ${fmtD(r.paidDate)} · ${how}`, pill: `Paid · ${how} · ${fmtD(r.paidDate)}` };
    }
    const left = r.paid > 0 ? ` · ${money(r.balance)} left` : '';
    if (r.state === 'overdue') { const n = r.daysLate; return { key: 'overdue', tone: 'late', text: `${n} day${n === 1 ? '' : 's'} late`, pill: `${n} day${n === 1 ? '' : 's'} late${left}` }; }
    if (r.state === 'dueSoon') {
      const n = dayNum(r.dueDate) - dayNum(today);
      const t = n === 0 ? 'Due today' : n === 1 ? 'Due tomorrow' : `Due in ${n} days`;
      return { key: 'dueSoon', tone: 'soon', text: t, pill: t + left };
    }
    return { key: 'unpaid', tone: 'muted', text: `Due ${fmtD(r.dueDate)}`, pill: `Unpaid · due ${fmtD(r.dueDate)}${left}` };
  }

  const SECTIONS = [['recent', 'Recent'], ['invoices', 'Invoices'], ['quotes', 'Quotes'], ['sales', 'Register sales']];
  const INVOICE_SUBS = [['unpaid', 'Unpaid'], ['dueSoon', 'Due soon'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Void']];
  const QUOTE_SUBS = [['open', 'Open'], ['converted', 'Turned into sale']];
  const UNPAID_GROUPS = [['overdue', 'Overdue', 'late'], ['dueSoon', 'Due in the next 7 days', ''], ['unpaid', 'Due later', '']];
  const amountOf = r => (UNPAID.has(r.state) ? r.balance : r.total);
  const group = (key, label, rows, opts = {}) => ({ key, label, rows, count: rows.length,
    total: opts.noTotal ? null : cents(rows.reduce((a, r) => a + amountOf(r), 0)), tone: opts.tone || '' });

  function subCounts(records) {
    const inv = records.filter(r => r.kind === 'invoice');
    const q = records.filter(r => r.kind === 'quote');
    return {
      unpaid: inv.filter(r => UNPAID.has(r.state)).length, dueSoon: inv.filter(r => r.state === 'dueSoon').length,
      overdue: inv.filter(r => r.state === 'overdue').length, paid: inv.filter(r => r.state === 'paid').length,
      void: inv.filter(r => r.state === 'void').length,
      open: q.filter(r => !r.convertedTo).length, converted: q.filter(r => r.convertedTo).length,
    };
  }

  // The left list for the current ui: { groups, empty }. A search always covers every record.
  function buildView(records, ui) {
    const q = s(ui.q);
    if (q) {
      const rows = L.search(records, q).slice().sort(newest);
      return { search: true, groups: [group('search', `${rows.length} found in all records`, rows, { noTotal: true })], empty: `Nothing matches “${q}”.` };
    }
    if (ui.section === 'invoices') {
      const inv = records.filter(r => r.kind === 'invoice');
      const sub = ui.invSub || 'unpaid';
      if (sub === 'unpaid') {
        return { groups: UNPAID_GROUPS.map(([k, label, tone]) => group(k, label, inv.filter(r => r.state === k).sort(byDue), { tone }))
          .filter(g => g.count), empty: 'Nothing is owed. Every invoice is paid.' };
      }
      const label = INVOICE_SUBS.find(x => x[0] === sub)[1];
      const rows = inv.filter(r => r.state === sub).sort(byDue);
      const empties = { dueSoon: 'No invoices are due in the next 7 days.', overdue: 'No invoices are overdue.', paid: 'No paid invoices yet.', void: 'No void invoices.' };
      return { groups: rows.length ? [group(sub, label, rows, { noTotal: sub === 'void', tone: sub === 'overdue' ? 'late' : '' })] : [], empty: empties[sub] };
    }
    if (ui.section === 'quotes') {
      const sub = ui.quoteSub || 'open';
      const rows = records.filter(r => r.kind === 'quote' && !!r.convertedTo === (sub === 'converted')).sort(newest);
      return { groups: rows.length ? [group(sub, sub === 'open' ? 'Open quotes' : 'Turned into sale', rows)] : [],
        empty: sub === 'open' ? 'No open quotes.' : 'No quotes have been turned into a sale yet.' };
    }
    if (ui.section === 'sales') {
      const rows = records.filter(r => r.kind === 'receipt').sort(newest);
      return { groups: rows.length ? [group('sales', 'Register sales', rows)] : [], empty: 'No register sales yet.' };
    }
    const rows = records.slice().sort(newest);
    return { groups: rows.length ? [group('recent', '', rows, { noTotal: true })] : [], empty: 'No sales yet.' };
  }

  // Buttons for one record, strongest first. Each: { act, label, primary?, quiet?, menu?, disabled?, why? }.
  function actionsFor(r) {
    const a = [];
    const isVoid = r.state === 'void';
    if (r.kind === 'quote' && !r.convertedTo) a.push({ act: 'toSale', label: 'Turn quote into sale', primary: true });
    if (r.kind === 'invoice' && UNPAID.has(r.state)) a.push({ act: 'pay', label: 'Mark paid', primary: true, menu: true });
    a.push({ act: 'reprint', label: 'Reprint' });
    if (r.kind !== 'receipt' && !isVoid) a.push(r.email ? { act: 'email', label: 'Email draft' } : { act: 'email', label: 'Email draft', disabled: true, why: 'No email on file' });
    if (!isVoid) a.push({ act: 'edit', label: 'Edit' });
    if (r.kind === 'invoice' && !isVoid && (r.paymentsLive || []).length) a.push({ act: 'undoPay', label: r.state === 'paid' ? 'Undo paid' : 'Undo payment' });
    a.push({ act: 'copy', label: 'Copy to new sale', quiet: true });
    if (r.name || r.company) a.push({ act: 'newInvoice', label: 'New invoice for this customer', quiet: true });
    return a;
  }

  // Short history for the right panel, oldest first.
  function historyFor(r, paymentRows, marks, records) {
    const ev = [];
    const at = placeOf(r.number);
    ev.push({ t: `${KIND_LABEL[r.kind]} made`, d: r.date, at });
    if (r.madeFromQuote) ev.push({ t: `Made from quote ${r.madeFromQuote}`, d: r.date, at });
    if (r.replaces) ev.push({ t: `Replaces ${r.replaces}`, d: r.date, at });
    const edited = marks && marks.edits && marks.edits[r.txnId];
    if (edited) ev.push({ t: 'Edited', d: edited, at: '' });
    const draft = marks && marks.drafts && (marks.drafts[r.txnId] || marks.drafts[r.number]);
    if (draft) ev.push({ t: 'Email draft made', d: draft, at: '' });
    if (r.kind === 'invoice') {
      const mine = L.parsePayments(paymentRows).filter(p => p.txnId === r.txnId || (!p.txnId && p.invoice_number === r.number));
      const seen = new Set();
      for (const p of mine.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) {
        if (seen.has(p.payment_id)) continue;
        seen.add(p.payment_id);
        ev.push({ t: p.voids ? 'Payment undone' : `Paid by ${(METHOD_LABEL[p.method] || p.method).toLowerCase()}${p.amount < r.total ? ' ' + money(p.amount) : ''}`, d: p.date, at: PLACES[p.place] || '' });
      }
    }
    if (r.state === 'void') { const n = (records || []).find(x => (x.number || x.txnId) === r.replacedBy); ev.push({ t: `Corrected, replaced by ${r.replacedBy}`, d: n ? n.date : '', at: n ? placeOf(n.number) : '' }); }
    if (r.convertedTo) { const n = (records || []).find(x => (x.number || x.txnId) === r.convertedTo); ev.push({ t: `Turned into sale ${r.convertedTo}`, d: n ? n.date : '', at: n ? placeOf(n.number) : '' }); }
    return ev.sort((a, b) => (a.d || '').localeCompare(b.d || ''));
  }

  // The print request, built from a Ledger record the way POS/index.html saleScreenDocumentRequest() builds it from the sale
  // screen. The sheet has no PO or brand, so those print empty; a line discount comes from item columns O and P.
  function requestFromRecord(r) {
    const items = r.items.filter(i => i.pn !== 'Note');
    const subtotal = items.reduce((a, i) => a + i.sub, 0);
    const tax = subtotal * TAX_RATE;
    const rest = cents(r.total) - cents(subtotal) - cents(tax);
    const cardFee = Math.abs(rest) >= 0.05 ? rest : 0; // a sale with the card fee on; less is rounding
    const completion = new Date(r.date ? `${r.date}T12:00:00-10:00` : Date.now());
    const billing = r.street || r.city
      ? { billing_address: { lines: r.street ? [r.street] : [], city: r.city, region: regionOf(r), postal_code: r.zip, country: '' } }
      : { address: r.addr || '' };
    return {
      po: '', type: r.kind, number: r.number || r.txnId, completionAt: completion.toISOString(),
      dueDate: r.kind === 'invoice' ? (r.dueDate || null) : null,
      customer: { name: r.name, company: r.company, phone: r.phone, email: r.email, ...billing },
      lines: r.items.map(i => (i.pn === 'Note'
        ? { kind: 'note', description: i.desc }
        : { kind: 'item', part_number: i.pn, make: '', description: i.desc, quantity: s(i.qty) || '1', serials: [...i.serials],
          original_unit_amount: m2(i.off ? i.origEa : i.ea), discount_amount: m2(i.off || 0), unit_amount: m2(i.ea), line_total: m2(i.sub) })),
      totals: { subtotal: m2(subtotal), card_fee: m2(cardFee), tax: m2(tax),
        rounding: m2(cents(r.total) - cents(subtotal) - cents(tax) - cents(cardFee)), total: m2(r.total) },
    };
  }

  // Request -> renderer facts: the same mapping as POSDesktop/src/document-print.js factsFromRequest (that file is Node-only).
  // test_ledger_page.cjs proves documentPages() equals DocumentPrintService.build() for the same request.
  function factsFromRequest(q) {
    const day = L.honoluluToday(q.completionAt);
    const c = q.customer || {};
    const customer = { name: c.name || '', company: c.company || '', phone: c.phone || '', email: c.email || '' };
    if (c.billing_address) {
      const a = c.billing_address;
      customer.billing_address = { lines: [...a.lines], city: a.city || '', region: a.region || '', postal_code: a.postal_code || '', country: a.country || '' };
    } else customer.address = c.address || '';
    const lines = q.lines.map(l => {
      if (l.kind === 'note') return { kind: 'note', description: l.description || '' };
      const make = s(l.make);
      return { kind: 'item', part_number: l.part_number || '', ...(make ? { make } : {}), description: l.description || '', quantity: l.quantity,
        serials: [...l.serials], unit_amount: l.unit_amount, line_total: l.line_total,
        discount_amount: l.discount_amount == null ? '0.00' : l.discount_amount,
        original_unit_amount: l.original_unit_amount == null ? l.unit_amount : l.original_unit_amount };
    });
    const t = q.totals;
    return {
      issued: { document_type: q.type, document_number: q.number, document_date: day, due_date: q.dueDate || null },
      customer, lines,
      totals: { subtotal: t.subtotal, card_fee: t.card_fee == null ? '0.00' : t.card_fee, tax: t.tax, rounding: t.rounding == null ? '0.00' : t.rounding, total: t.total },
      message: '',
    };
  }
  // The pages the app prints: invoice = customer copy then merchant copy; quote (and receipt) = one page.
  function documentPages(request, renderer, template, settings) {
    const facts = factsFromRequest(request);
    const po = s(request.po);
    const copies = request.type === 'invoice' ? ['customer', 'merchant'] : [undefined];
    return copies.map(copy => renderer.renderOfficialHtml(template, facts, po ? { po } : {}, settings || renderer.DEFAULT_SETTINGS, copy));
  }

  // Mark paid: one payment row for the full total (the newest live payment decides, so this settles a part-paid invoice too).
  function paymentRowsFor(r, method, today, place, now) {
    return [L.buildPaymentRow({ invoice_number: r.number, txnId: r.txnId, date: today, amount: r.total, method, place: place || '' }, now)];
  }

  // UI memory: in memory for tab switches, sessionStorage for a reload. Storage may be missing or throw.
  const DEFAULT_UI = Object.freeze({ section: 'recent', invSub: 'unpaid', quoteSub: 'open', q: '', sel: '', scroll: 0, closed: [] });
  function loadUi(storage) {
    try {
      const v = JSON.parse(storage.getItem(STORE_KEY) || 'null');
      if (v && typeof v === 'object') return { ...DEFAULT_UI, ...v, closed: Array.isArray(v.closed) ? v.closed : [] };
    } catch (_) { /* private window or blocked storage */ }
    return { ...DEFAULT_UI, closed: [] };
  }
  function saveUi(storage, ui) { try { storage.setItem(STORE_KEY, JSON.stringify(ui)); return true; } catch (_) { return false; } }

  const pure = { TAX_RATE, SECTIONS, INVOICE_SUBS, QUOTE_SUBS, METHOD_LABEL, decorate, statusOf, buildView, subCounts, actionsFor,
    historyFor, requestFromRecord, factsFromRequest, documentPages, paymentRowsFor, loadUi, saveUi, placeOf, money, fmtD };

  // ------------------------------------------------------------------ page
  function boot() {
    const doc = root.document;
    const $ = id => doc.getElementById(id);
    const store = (() => { try { return root.sessionStorage; } catch (_) { return null; } })();
    const ui = store ? loadUi(store) : { ...DEFAULT_UI, closed: [] };
    const st = { phase: 'loading', model: null, records: [], payRows: [], marks: { drafts: {}, edits: {} }, local: { drafts: {} },
      today: '', busy: '', template: null, docKey: '', pages: null, docErr: '' };
    const host = () => root.MPELedgerHost;
    const remember = () => { if (store) saveUi(store, ui); };
    const byId = id => st.records.find(r => r.txnId === id);

    async function load() {
      const h = host();
      if (!h) { st.phase = 'nohost'; return draw(); }
      if (!st.model) { st.phase = 'loading'; draw(); }
      try {
        const [tx, pay, mk] = await Promise.all([h.readTransactions(), h.readPayments(), h.readMarks ? h.readMarks() : null]);
        st.today = (h.honoluluToday && h.honoluluToday()) || L.honoluluToday();
        st.payRows = pay || [];
        st.marks = { drafts: { ...((mk && mk.drafts) || {}), ...st.local.drafts }, edits: { ...((mk && mk.edits) || {}) } };
        st.model = await L.create({ txnRows: tx || [], paymentRows: st.payRows, drafts: st.marks.drafts, today: st.today });
        st.records = decorate(st.model.records);
        st.phase = 'ready';
      } catch (e) {
        st.phase = e && e.code === 'not_signed_in' ? 'signedout' : (st.model ? 'ready' : 'error');
        if (st.model) toast('Could not refresh. Showing what was loaded before.');
      }
      draw();
    }

    function draw() {
      const list = $('list');
      if (st.phase !== 'ready') {
        const msg = {
          loading: 'Loading sales…',
          nohost: 'Waiting for the register to connect…',
          signedout: 'Not signed in to Google. Sign in on the register, then come back here.',
          error: 'Could not load the sales sheet.',
        }[st.phase];
        $('main').hidden = true; $('state').hidden = false;
        $('state').innerHTML = `<p>${msg}</p>${st.phase === 'error' || st.phase === 'signedout' ? '<button class="btn" data-act="retry">Try again</button>' : ''}`;
        return;
      }
      $('main').hidden = false; $('state').hidden = true;
      const sum = st.model.owedSummary();
      $('owed').hidden = ui.q || ui.section !== 'invoices'; // the owed line belongs to Invoices only
      $('owed').innerHTML = `Owed to us: <span class="num">${money(sum.total)}</span>, <span class="${sum.overdue ? 'late' : ''}">${sum.overdue} overdue</span>`;
      const counts = subCounts(st.records);
      $('sections').innerHTML = SECTIONS.map(([k, label]) => `<button data-section="${k}" aria-pressed="${!ui.q && ui.section === k}">${label}</button>`).join('');
      const subs = ui.q ? null : ui.section === 'invoices' ? ['invSub', INVOICE_SUBS] : ui.section === 'quotes' ? ['quoteSub', QUOTE_SUBS] : null;
      $('subs').hidden = !subs;
      $('subs').innerHTML = subs ? subs[1].map(([k, label]) => `<button data-sub="${subs[0]}:${k}" aria-pressed="${ui[subs[0]] === k}">${label}${['unpaid', 'dueSoon', 'overdue'].includes(k) ? ` <span class="n">${counts[k]}</span>` : ''}</button>`).join('') : '';

      const view = buildView(st.records, ui);
      const rows = view.groups.flatMap(g => g.rows);
      if (!byId(ui.sel)) ui.sel = rows[0] ? rows[0].txnId : ''; // a record that leaves the view (just paid) stays selected
      const keep = list.scrollTop;
      list.innerHTML = view.groups.length ? view.groups.map(g => {
        const body = g.rows.map(rowHtml).join('');
        if (!g.label) return `<div class="flat">${body}</div>`;
        return `<details data-g="${g.key}" ${ui.closed.includes(g.key) ? '' : 'open'}><summary class="${g.tone === 'late' ? 'red' : ''}">${ICON.right}${esc(g.label)} ${view.search ? '' : `<span class="ct">${g.count}</span>`}<span class="tot num">${g.total == null ? '' : money(g.total)}</span></summary>${body}</details>`;
      }).join('') : `<div class="empty">${esc(view.empty)}${view.search ? '<br><button class="btn" style="margin-top:10px" data-act="clearSearch">Clear search</button>' : ''}</div>`;
      list.scrollTop = st.firstDraw ? keep : ui.scroll;
      st.firstDraw = true;
      list.querySelectorAll('details').forEach(el => el.addEventListener('toggle', () => {
        const k = el.dataset.g; ui.closed = ui.closed.filter(x => x !== k); if (!el.open) ui.closed.push(k); remember();
      }));
      drawRecord(byId(ui.sel));
      remember();
    }

    // Row: who (or the top item), total; then date and time, and the type with its status for invoices.
    function rowHtml(r) {
      const t = statusOf(r, st.today);
      const when = [fmtD(r.date), fmtT(r.time)].filter(Boolean).join(' · ');
      const kind = r.kind === 'invoice' ? `Invoice · ${t.key === 'paid' ? 'Paid' : t.text}` : KIND_LABEL[r.kind];
      return `<button class="row${r.state === 'void' ? ' is-void' : ''}" role="option" data-id="${esc(r.txnId)}" aria-selected="${r.txnId === ui.sel}">
        <span class="nm">${esc(who(r))}</span><span class="amt num">${money(UNPAID.has(r.state) ? r.balance : r.total)}</span>
        <span class="sub num">${esc(when)}</span><span class="when ${r.kind === 'invoice' ? t.tone : 'muted'}">${esc(kind)}</span></button>`;
    }

    function drawRecord(r) {
      if (!r) { $('note').innerHTML = ''; $('paper').innerHTML = '<div class="empty">Pick a sale on the left.</div>'; $('rail').innerHTML = ''; st.docKey = ''; return; }
      const t = statusOf(r, st.today);
      $('note').innerHTML = r.state === 'void'
        ? `<div class="note-void"><b>VOID.</b> This invoice was corrected and does not count as owed. The replacement is <a class="rec" href="#" data-go="${esc(r.replacedBy)}">${esc(r.replacedBy)}</a>.</div>`
        : r.replaces ? `<div class="note-plain">Replaces <a class="rec" href="#" data-go="${esc(r.replaces)}">${esc(r.replaces)}</a>, which is now void. Both PDFs are kept.</div>` : '';
      drawDocument(r);
      const draft = st.marks.drafts[r.txnId] || st.marks.drafts[r.number];
      const acts = actionsFor(r);
      const btn = a => `<button class="btn${a.primary ? ' primary' : ''}${a.quiet ? ' quiet' : ''}" data-act="${a.act}"${a.disabled || st.busy ? ' disabled' : ''}${a.why ? ` title="${esc(a.why)}"` : ''}>${ICON[a.act] || ''}<span>${st.busy === a.act ? 'Saving…' : esc(a.label)}</span>${a.menu ? ICON.down : ''}</button>${a.disabled && a.why ? `<span class="why">${esc(a.why)}</span>` : ''}`;
      const addr = [r.street, [r.city, regionOf(r), r.zip].filter(Boolean).join(' ')].filter(Boolean);
      const hist = historyFor(r, st.payRows, st.marks, st.records);
      $('rail').innerHTML = `
        <div><h3>${esc(KIND_LABEL[r.kind])} ${esc(r.number)}</h3><div class="big num">${money(r.total)}</div>
          <div class="state"><span class="pill ${t.tone}">${['paid'].includes(t.key) ? ICON.check : ''}${esc(t.pill)}</span>${draft ? `<span class="pill draft">${ICON.email}Draft made ${esc(fmtD(draft))}</span>` : ''}</div></div>
        ${r.name || r.company || r.phone ? `<button class="who" data-act="${r.state === 'void' ? 'noop' : 'edit'}" title="Edit customer"><h3>Customer ${r.state === 'void' ? '' : ICON.edit}</h3><b>${esc(r.company || r.name)}</b>${r.company && r.name ? esc(r.name) + '<br>' : ''}${r.phone ? esc(r.phone) + '<br>' : ''}${r.email ? esc(r.email) : '<span class="muted">No email on file</span>'}${addr.length ? '<br>' + addr.map(esc).join('<br>') : ''}</button>` : ''}
        <div class="acts">${acts.map(btn).join('')}</div>
        <div><h3>History</h3><ol>${hist.map(e => `<li>${esc(e.t)}<span>${esc([fmtD(e.d), e.at].filter(Boolean).join(' · '))}</span></li>`).join('')}</ol></div>`;
    }

    // The document, filled from document-template.html exactly as the app prints it, scaled to the middle column.
    async function drawDocument(r) {
      const request = requestFromRecord(r);
      const key = JSON.stringify(request);
      if (key === st.docKey) return;
      st.docKey = key; st.request = request;
      const paper = $('paper');
      paper.innerHTML = '<div class="empty">Loading the document…</div>';
      try {
        const h = host();
        let pages;
        if (h.renderDocument) pages = await h.renderDocument(request);
        else {
          const R = root.MPEDocumentRenderer;
          if (!R) throw new Error('no renderer');
          if (!st.template) st.template = await readText('document-template.html');
          pages = documentPages(request, R, st.template, h.documentSettings);
        }
        if (st.docKey !== key) return;
        st.pages = pages;
        paper.innerHTML = '<div class="fit"><iframe title="Document" sandbox="allow-same-origin" tabindex="-1"></iframe></div>';
        const frame = paper.querySelector('iframe');
        frame.addEventListener('load', fitDocument, { once: true });
        frame.srcdoc = pages[0];
      } catch (_) {
        if (st.docKey === key) paper.innerHTML = '<div class="empty">Could not show this document. Reprint still works from the register.</div>';
      }
    }
    // XHR, not fetch: fetch refuses file: pages (the local ?fixture=1 copy); over https both work.
    function readText(url) {
      return new Promise((ok, fail) => {
        const x = new root.XMLHttpRequest();
        x.open('GET', url);
        x.onload = () => (x.status === 200 || (x.status === 0 && x.responseText) ? ok(x.responseText) : fail(new Error('template')));
        x.onerror = () => fail(new Error('template'));
        x.send();
      });
    }
    function fitDocument() {
      const frame = $('paper').querySelector('iframe');
      if (!frame || !frame.contentDocument) return;
      const page = 816, avail = $('paper').clientWidth - 36;
      const scale = Math.min(1, avail / page);
      const h = frame.contentDocument.documentElement.scrollHeight;
      frame.style.width = page + 'px'; frame.style.height = h + 'px';
      frame.style.transform = `scale(${scale})`;
      frame.parentElement.style.width = page * scale + 'px'; frame.parentElement.style.height = h * scale + 'px';
    }

    // ---- actions
    async function run(name, fn, okMsg) {
      if (st.busy) return;
      st.busy = name; draw();
      try { const msg = await fn(); st.busy = ''; await load(); if (msg || okMsg) toast(msg || okMsg); }
      catch (e) { st.busy = ''; draw(); toast(e && e.code === 'not_signed_in' ? 'Not signed in to Google. Nothing was saved.' : 'That did not go through. Nothing changed. Try again.'); }
    }
    function markPaid(r, method) {
      run('pay', async () => {
        await host().appendPaymentRows(paymentRowsFor(r, method, st.today, host().place, Date.now()));
        return { text: `${r.number} marked paid by ${METHOD_LABEL[method].toLowerCase()}.`, undo: () => undoPaid(r.txnId) };
      });
    }
    function undoPaid(id) {
      run('undoPay', async () => {
        await load();
        const r = byId(id);
        const rows = r ? L.undoRows(r, Date.now(), host().place || '') : [];
        if (!rows.length) return `${id} has no payment to undo.`;
        await host().appendPaymentRows(rows);
        return `${r.number} is unpaid again.`;
      });
    }
    function openSale(kind, r, what) {
      run(kind, async () => { await host().openInNewSale({ kind, txn: r }); return `${what} opened in a new sale tab. The sale in progress is unchanged.`; });
    }
    function act(k, el) {
      const r = byId(ui.sel);
      if (k === 'retry') return load();
      if (k === 'clearSearch') { ui.q = ''; $('q').value = ''; return draw(); }
      if (!r) return;
      if (k === 'pay') return openMenu(el, [['hint', 'How was it paid?'], ...Object.entries(METHOD_LABEL)], m => markPaid(r, m));
      if (k === 'undoPay') return undoPaid(r.txnId);
      if (k === 'reprint') return run('reprint', async () => { await host().reprint(r, st.request || requestFromRecord(r)); return `${r.number} sent to print.`; });
      if (k === 'email') return run('email', async () => {
        await host().emailDraft(r, st.request || requestFromRecord(r));
        st.local.drafts[r.txnId] = st.today;
        return `Gmail draft made for ${r.email}. Open Gmail to send it.`;
      });
      if (k === 'toSale') return openSale('quote', r, `Quote ${r.number}`);
      if (k === 'copy') return openSale('copy', r, `A copy of ${r.number}`);
      if (k === 'newInvoice') return openSale('newInvoice', r, `A new invoice for ${who(r)}`);
      if (k === 'edit') return confirmEdit(r);
    }
    function confirmEdit(r) {
      const d = $('confirm');
      const paid = r.kind === 'invoice' && (r.paymentsLive || []).length;
      $('confirmText').innerHTML = `<b>Edit ${esc(r.number)} in a new sale tab?</b><br>It keeps number ${esc(r.number)}. Saving there updates this ${esc(KIND_LABEL[r.kind].toLowerCase())}. A copy already printed or emailed stays as it was.`
        + (paid ? `<span class="warn">This invoice is marked paid; the payment stays.</span>` : '');
      d.returnValue = '';
      d.onclose = () => { if (d.returnValue === 'ok') openSale('edit', r, `${r.number}`); };
      if (d.showModal) d.showModal(); else if (root.confirm(`Edit ${r.number} in a new sale tab?`)) openSale('edit', r, r.number);
    }

    // ---- small UI pieces
    let toastT;
    function toast(msg) {
      const t = $('toast');
      const m = typeof msg === 'string' ? { text: msg } : msg;
      t.innerHTML = `<span>${esc(m.text)}</span>` + (m.undo ? '<button type="button">Undo</button>' : '');
      if (m.undo) t.querySelector('button').onclick = () => { t.classList.remove('show'); m.undo(); };
      t.classList.add('show');
      clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 7000);
    }
    function openMenu(anchor, items, onPick) {
      const menu = $('menu');
      menu.innerHTML = items.map(i => i[0] === 'hint' ? `<div class="hint">${esc(i[1])}</div>` : `<button type="button" data-k="${i[0]}">${esc(i[1])}</button>`).join('');
      const b = anchor.getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = Math.max(8, Math.min(b.left, root.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = (b.bottom + 4 + menu.offsetHeight > root.innerHeight ? b.top - menu.offsetHeight - 4 : b.bottom + 4) + 'px';
      const first = menu.querySelector('button'); if (first) first.focus();
      menu.onclick = e => { const btn = e.target.closest('button'); if (btn) { menu.hidden = true; onPick(btn.dataset.k); } };
    }
    function select(id) {
      ui.sel = id; draw();
      const el = doc.querySelector(`.row[data-id="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function go(number) {
      const r = st.records.find(x => (x.number || x.txnId) === number);
      if (!r) return;
      const view = buildView(st.records, ui).groups.flatMap(g => g.rows);
      if (!view.includes(r)) { ui.q = ''; $('q').value = ''; ui.section = 'recent'; }
      select(r.txnId);
    }

    doc.addEventListener('click', e => {
      const t = e.target;
      const g = t.closest('[data-go]'); if (g) { e.preventDefault(); return go(g.dataset.go); }
      const a = t.closest('[data-act]'); if (a && !a.disabled) return act(a.dataset.act, a);
      const sec = t.closest('[data-section]'); if (sec) { ui.section = sec.dataset.section; ui.q = ''; ui.sel = ''; $('q').value = ''; ui.scroll = 0; $('list').scrollTop = 0; return draw(); }
      const sub = t.closest('[data-sub]'); if (sub) { const [key, v] = sub.dataset.sub.split(':'); ui[key] = v; ui.sel = ''; $('list').scrollTop = 0; return draw(); }
      const row = t.closest('.row[data-id]'); if (row) return select(row.dataset.id);
    });
    doc.addEventListener('mousedown', e => { const menu = $('menu'); if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="pay"]')) menu.hidden = true; });
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('menu').hidden = true; return; }
      if (!['ArrowDown', 'ArrowUp'].includes(e.key) || (e.target.tagName === 'INPUT' && e.target.id !== 'q') || st.phase !== 'ready') return;
      const rows = buildView(st.records, ui).groups.flatMap(g => g.rows);
      const i = rows.findIndex(r => r.txnId === ui.sel);
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { e.preventDefault(); select(n.txnId); }
    });
    // Scanner typed like a keyboard (app): keys under SCAN_GAP ms apart, ending in Enter or Tab, are a scan. Its keys are kept
    // out of the page, the search box keeps its text, and the code goes to the last sale tab, which is shown.
    const SCAN_GAP = 35, SCAN_MIN = 4;
    let burst = '', lastKey = 0, saved = null;
    doc.addEventListener('keydown', e => {
      const h = host();
      if (!h || !h.scan || e.ctrlKey || e.metaKey || e.altKey) return;
      const now = e.timeStamp || Date.now();
      const fast = now - lastKey < SCAN_GAP;
      lastKey = now;
      if (e.key.length === 1) {
        if (!fast) { burst = ''; saved = e.target.id === 'q' ? { el: e.target, v: e.target.value } : null; }
        burst += e.key;
        if (burst.length >= 3) e.preventDefault(); // three keys each under 35 ms apart is a scanner, never a person
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && fast && burst.length >= SCAN_MIN) {
        e.preventDefault(); e.stopPropagation();
        if (saved && saved.el.value !== saved.v) { saved.el.value = saved.v; saved.el.dispatchEvent(new root.Event('input', { bubbles: true })); }
        const code = burst; burst = ''; saved = null;
        h.scan(code);
        return;
      }
      if (!fast) burst = '';
    }, true);
    const q = $('q');
    q.value = ui.q;
    q.addEventListener('input', () => { ui.q = q.value; ui.sel = ''; $('list').scrollTop = 0; draw(); });
    let pending = 0;
    $('list').addEventListener('scroll', () => { if (pending) return; pending = root.requestAnimationFrame(() => { pending = 0; ui.scroll = $('list').scrollTop; remember(); }); });
    root.addEventListener('resize', fitDocument);
    // Coming back to the tab: fresh numbers from other computers, same search, row and scroll.
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && st.phase === 'ready') load(); });
    root.addEventListener('mpe-ledger-host', load); // the host announces itself if it attaches after this page
    api.refresh = load;
    load();
  }

  const ICON = {
    right: '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    down: '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    pay: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 4.5 4.5 10.5-11"/></svg>',
    check: '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 4.5 4.5 10.5-11"/></svg>',
    reprint: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="1.5"/><path d="M7 14h10v6.5H7z"/></svg>',
    email: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="1.5"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>',
    edit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    undoPay: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    toSale: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/></svg>',
    copy: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
    newInvoice: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };
  const api = { ...pure, boot };
  return api;
});
