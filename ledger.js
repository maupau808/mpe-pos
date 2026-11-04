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
 *   emailPrepare(record, request) -> Promise<{ from, signature, to, subject, message, pages, attachment, canSend }>; sends nothing
 *   sendEmail(record, prep, fields) -> Promise; sends ONE email. Called only by the email window's Send button (a person presses it)
 *   openInNewSale({ kind: 'quote' | 'copy' | 'newInvoice' | 'edit', txn: record }) -> Promise; opens a NEW sale tab
 *   refreshQbo() (optional, Mac app only) -> Promise<{ ok, reason? }>; rebuilds the QuickBooks file and resolves once it changed.
 *                                Without it History says "Refresh on the Mac".
 *   readQboHistory(knownVersion) (optional) -> Promise<{ unchanged: true } | { data, modifiedTime }>; History's read-only QuickBooks
 *                                copy (see ledger-data.js qboRecords). The sheet shows first; these merge in when they arrive.
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
  const PAGE = 400; // rows drawn at a time; "Show more" adds another page (25,000 rows at once would freeze the list)
  const SEARCH_HINT = { recent: 'Search all sales', invoices: 'Search invoices', quotes: 'Search quotes', sales: 'Search register sales', customers: 'Search customers' };
  const QBO_RECHECK_MS = 10 * 60 * 1000;

  const s = v => String(v == null ? '' : v).trim();
  const cents = n => Math.round(n * 100) / 100;
  const m2 = n => { const v = cents(n); return (Object.is(v, -0) ? 0 : v).toFixed(2); };
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = v => s(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dayNum = iso => { const [y, mo, d] = iso.split('-').map(Number); return Date.UTC(y, mo - 1, d) / 864e5; };
  const addDays = (iso, n) => new Date((dayNum(iso) + n) * 864e5).toISOString().slice(0, 10);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Timeline words for an output mark (ledger-data.js log). note 'reprint' = from History's Reprint.
  const OUTPUT_LABEL = m => ({ print: m.note === 'reprint' ? 'Reprinted' : 'Printed', pdf: 'PDF saved', pdf_open: 'PDF opened', email_draft: 'Email draft made', email_sent: m.note ? 'Emailed to ' + m.note : 'Emailed' }[m.kind] || m.kind);
  const timeOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', minute: '2-digit' }); };
  const fmtD = iso => { if (!iso) return ''; const [, mo, d] = iso.split('-').map(Number); return `${MONTHS[mo - 1]} ${d}`; };
  const fmtDY = iso => iso ? `${fmtD(iso)}, ${iso.slice(0, 4)}` : '';
  const placeOf = number => (/^[A-Z]/.test(s(number)) && PLACES[s(number).charAt(1)]) || ''; // QuickBooks numbers are digits: no place
  // ledger-data.js puts the address state (column U) in r.state and then overwrites r.state with the paid status, so the
  // region is read back from the joined address (column H: "street, city, state, zip"). Drop this once ledger-data keeps it.
  const regionOf = r => { if (s(r.region)) return s(r.region); const p = s(r.addr).split(',').map(x => x.trim()); return p.length >= 3 ? p[p.length - 2] : ''; };
  // No customer: name the sale by its highest-value line, as Oldger did.
  const topItem = r => (r.items || []).filter(i => i.pn !== 'Note').reduce((a, i) => (!a || i.sub > a.sub ? i : a), null);
  const who = r => r.company || r.name || (topItem(r) && (topItem(r).desc || topItem(r).pn)) || 'No items';
  const fmtT = t => s(t).replace(/^0(?=\d:)/, '');
  const minutes = t => { const x = /(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(s(t)); if (!x) return 0; let h = +x[1] % 12; if (/p/i.test(x[3] || '')) h += 12; return h * 60 + +x[2]; };
  // Newest first = date, then time, then number, all descending. The key is built once per record and the sorted array is kept per
  // records array, so a keystroke in search filters an already sorted list (25,000 records) instead of sorting again.
  const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortedCache = new WeakMap();
  function byNewest(records) {
    let c = sortedCache.get(records);
    if (!c) {
      for (const r of records) if (r._k === undefined) r._k = `${r.date || ''}|${String(minutes(r.time)).padStart(4, '0')}|${s(r.number)}`;
      c = records.slice().sort((a, b) => lt(b._k, a._k));
      sortedCache.set(records, c);
    }
    return c;
  }
  const byDue = (a, b) => lt(a.dueDate || '9', b.dueDate || '9') || lt(s(a.number), s(b.number));
  const isQbo = r => r.source === 'qbo';
  const qboOpenQuote = r => r.kind === 'quote' && isQbo(r) && (!r.qboStatus || r.qboStatus === 'pending');

  // Links between records: quote -> the sale made from it; replacement invoice -> the void one it replaces.
  function decorate(records) {
    const byId = new Map(records.map(r => [r.txnId, r]));
    for (const r of records) {
      const src = byId.get(r.fromQuote);
      if (!src || src === r) continue;
      if (src.kind === 'quote' && r.kind !== 'quote') { src.convertedTo = r.number || r.txnId; r.madeFromQuote = src.number || src.txnId; }
      if (src.kind === 'invoice' && r.kind === 'invoice') r.replaces = src.number || src.txnId;
    }
    for (const r of records) if (r.kind === 'quote') r.goodUntil = isQbo(r) ? r.qboExpires : r.date ? addDays(r.date, QUOTE_DAYS) : '';
    return records;
  }

  // One status per record: the list text, its tone and the pill.
  function statusOf(r, today) {
    if (r.state === 'cancelled') return { key: 'cancelled', tone: 'void', text: `Cancelled ${fmtD(r.cancelledAt)}`, pill: `Cancelled ${fmtD(r.cancelledAt)}` };
    if (r.kind === 'receipt') return { key: 'sale', tone: 'muted', text: 'Register sale', pill: isQbo(r) ? 'Sale' : 'Register sale' };
    if (isQbo(r) && r.kind === 'quote' && !qboOpenQuote(r)) { const w = r.qboStatus.charAt(0).toUpperCase() + r.qboStatus.slice(1); return { key: 'quote', tone: 'quote', text: w, pill: `Quote · ${w}` }; }
    if (r.kind === 'quote') return r.convertedTo
      ? { key: 'converted', tone: 'muted', text: `Now ${r.convertedTo}`, pill: `Turned into sale ${r.convertedTo}` }
      : r.deposit > 0 ? { key: 'quote', tone: 'quote', text: `Deposit ${money(r.deposit)}`, pill: `Quote · deposit ${money(r.deposit)} paid` }
      : { key: 'quote', tone: 'quote', text: r.goodUntil ? `Good to ${fmtD(r.goodUntil)}` : 'Quote', pill: r.goodUntil ? `Quote · good to ${fmtD(r.goodUntil)}` : 'Quote' };
    if (r.state === 'old') return { key: 'old', tone: 'muted', text: 'Before 2026', pill: `Before 2026 · ${money(r.balance)} open · not counted as owed` };
    if (r.state === 'void') return { key: 'void', tone: 'void', text: isQbo(r) ? 'Void' : `Void · see ${r.replacedBy}`, pill: 'Void' };
    if (r.state === 'paid' && isQbo(r)) return { key: 'paid', tone: 'paid', text: 'Paid', pill: 'Paid' };
    if (r.state === 'paid' && r.paidInQbo) return { key: 'paid', tone: 'paid', text: 'Paid in QuickBooks', pill: 'Paid in QuickBooks' };
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

  const SECTIONS = [['recent', 'Recent'], ['invoices', 'Invoices'], ['quotes', 'Quotes'], ['sales', 'Sales'], ['customers', 'Customers']];
  const INVOICE_SUBS = [['unpaid', 'Unpaid'], ['dueSoon', 'Due soon'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Void or cancelled']];
  const QUOTE_SUBS = [['open', 'Open'], ['converted', 'Turned into sale'], ['closed', 'Closed in QuickBooks'], ['deleted', 'Deleted']];
  // Filters under the search box. Records: when and where from. Customers: who to show and the order.
  const FILTERS = {
    when: [['', 'Any date'], ['30', 'Last 30 days'], ['year', 'This year'], ['lastYear', 'Last year']],
    src: [['', 'All sources'], ['register', 'Register only'], ['qbo', 'QuickBooks only']],
    cShow: [['', 'All customers'], ['owes', 'Owes money'], ['overdue', 'Overdue'], ['year', 'Bought this year']],
    cSort: [['', 'Newest activity'], ['name', 'Name A–Z'], ['balance', 'Most owed']],
  };
  function filterRecords(records, ui, today) {
    const y = today.slice(0, 4), from30 = addDays(today, -30);
    const when = { '30': r => (r.date || '') >= from30, year: r => (r.date || '').startsWith(y), lastYear: r => (r.date || '').startsWith(String(y - 1)) }[ui.when];
    const src = { register: r => !isQbo(r), qbo: isQbo }[ui.src];
    return when || src ? records.filter(r => (!when || when(r)) && (!src || src(r))) : records;
  }
  // A receipt or invoice marked Presold in the register: held in stock, still to be picked up.
  const awaitingPickup = r => !!r.presell && (r.kind === 'receipt' || r.kind === 'invoice') && r.state !== 'void' && r.state !== 'cancelled' && !isQbo(r);
  const isGone = r => r.state === 'void' || r.state === 'cancelled';
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
      void: inv.filter(isGone).length,
      deleted: q.filter(isGone).length,
      open: q.filter(r => !isGone(r) && !r.convertedTo && !(isQbo(r) && !qboOpenQuote(r))).length, converted: q.filter(r => r.convertedTo).length,
      closed: q.filter(r => isQbo(r) && !qboOpenQuote(r)).length,
    };
  }

  // The left list for the current ui: { groups, empty }. Search and filters narrow the section (and sub-tab) on screen.
  function buildView(records, ui, today) {
    const q = s(ui.q);
    const view = sectionView(filterRecords(records, ui, today || L.honoluluToday()), ui);
    if (!q) return view;
    const groups = view.groups.map(g => ({ ...g, rows: L.search(g.rows, q) })).filter(g => g.rows.length)
      .map(g => group(g.key, g.label, g.rows, { noTotal: g.total == null, tone: g.tone }));
    const n = groups.reduce((a, g) => a + g.count, 0);
    return { search: true, groups: groups.length ? groups : [group('search', '0 found', [], { noTotal: true })], found: n, empty: `Nothing matches “${q}”.` };
  }
  function sectionView(records, ui) {
    if (ui.section === 'invoices') {
      const inv = records.filter(r => r.kind === 'invoice');
      const sub = ui.invSub || 'unpaid';
      if (sub === 'unpaid') {
        return { groups: UNPAID_GROUPS.map(([k, label, tone]) => group(k, label, inv.filter(r => r.state === k).sort(byDue), { tone }))
          .filter(g => g.count), empty: 'Nothing is owed. Every invoice is paid.' };
      }
      const label = INVOICE_SUBS.find(x => x[0] === sub)[1];
      const rows = sub === 'paid' ? byNewest(inv).filter(r => r.state === sub) : sub === 'void' ? byNewest(inv).filter(isGone) : inv.filter(r => r.state === sub).sort(byDue);
      const empties = { dueSoon: 'No invoices are due in the next 7 days.', overdue: 'No invoices are overdue.', paid: 'No paid invoices yet.', void: 'No void or cancelled invoices.' };
      return { groups: rows.length ? [group(sub, label, rows, { noTotal: sub === 'void', tone: sub === 'overdue' ? 'late' : '' })] : [], empty: empties[sub] };
    }
    if (ui.section === 'quotes') {
      const sub = ui.quoteSub || 'open';
      const pick = { deleted: isGone, open: r => !isGone(r) && !r.convertedTo && !(isQbo(r) && !qboOpenQuote(r)), converted: r => !!r.convertedTo, closed: r => isQbo(r) && !qboOpenQuote(r) && !r.convertedTo }[sub] || (() => false);
      const rows = byNewest(records).filter(r => r.kind === 'quote' && pick(r));
      return { groups: rows.length ? [group(sub, { open: 'Open quotes', converted: 'Turned into sale', closed: 'Closed in QuickBooks', deleted: 'Deleted quotes' }[sub], rows)] : [],
        empty: { open: 'No open quotes.', converted: 'No quotes have been turned into a sale yet.', closed: 'No closed QuickBooks quotes.', deleted: 'No deleted quotes.' }[sub] };
    }
    if (ui.section === 'sales') {
      const rows = byNewest(records).filter(r => r.kind === 'receipt');
      return { groups: rows.length ? [group('sales', 'Register sales', rows)] : [], empty: 'No register sales yet.' };
    }
    const rows = byNewest(records);
    return { groups: rows.length ? [group('recent', '', rows, { noTotal: true })] : [], empty: 'No sales yet.' };
  }

  // Customers section: the list for the current ui, built from L.buildCustomers() (newest activity first). Search is name, company,
  // phone, email (the same word-by-word rule as the other sections), over all customers.
  function buildCustomerView(customers, ui, today) {
    const q = s(ui.q), y = (today || L.honoluluToday()).slice(0, 4);
    const show = { owes: c => c.balance > 0, overdue: c => c.overdue > 0, year: c => c.records.some(r => (r.date || '').startsWith(y) && r.kind !== 'quote') }[ui.cShow];
    let rows = show ? customers.filter(show) : customers;
    if (q) rows = L.search(rows, q);
    const nameOf = c => (c.company || c.name).toLowerCase();
    if (ui.cSort === 'name') rows = rows.slice().sort((a, b) => lt(nameOf(a), nameOf(b)));
    else if (ui.cSort === 'balance') rows = rows.slice().sort((a, b) => b.balance - a.balance || lt(nameOf(a), nameOf(b)));
    return { search: !!q, groups: rows.length ? [group('customers', q ? `${rows.length} found` : 'Customers', rows, { noTotal: true })] : [],
      empty: q ? `Nothing matches “${q}”.` : show ? 'No customers match this filter.' : 'No customers yet.' };
  }
  // The customer's own text, for the panel: the plain words for where it came from and the balance pill.
  function customerSource(c) {
    const from = c.qboId ? 'In QuickBooks.' : 'From the register customer list or past sales.';
    return c.edited ? `${from} Contact details are from the latest change.` : from;
  }
  function customerBalance(c) {
    if (c.overdue) return { tone: 'late', text: `Owes ${money(c.balance)} · ${c.overdue} overdue` };
    if (c.balance > 0) return { tone: 'soon', text: `Owes ${money(c.balance)}` };
    return { tone: 'paid', text: 'Nothing owed' };
  }
  // What the register opens for "New invoice for this customer": contact only, no lines, no number.
  function newInvoiceTxn(c) {
    return { txnId: '', number: '', docType: '', date: '', time: '', name: c.name, company: c.company, phone: c.phone, email: c.email, street: c.street,
      city: c.city, region: c.region, zip: c.zip, addr: [c.street, c.city, c.region, c.zip].filter(Boolean).join(', '), total: 0, fromQuote: '', items: [] };
  }

  // Buttons for one record, strongest first. Each: { act, label, primary?, quiet?, menu?, disabled?, why? }.
  function actionsFor(r, canPdf) {
    const a = [];
    if (isQbo(r)) { // read-only copy from QuickBooks: no Payments tab, edit, PDF or email draft
      if (qboOpenQuote(r) && !r.convertedTo) a.push({ act: 'toSale', label: 'Turn quote into sale', primary: true });
      a.push({ act: 'reprint', label: 'Reprint' }, { act: 'copy', label: 'Copy to new sale', quiet: true });
      if (r.name || r.company) a.push({ act: 'newInvoice', label: 'New invoice for this customer', quiet: true });
      return a;
    }
    const isVoid = r.state === 'void' || r.state === 'cancelled'; // a cancelled sale gets no Edit or Email draft, as a void one
    if (r.kind === 'quote' && !r.convertedTo && !isVoid) a.push({ act: 'toSale', label: 'Turn quote into sale', primary: true });
    if (r.kind === 'quote' && !r.convertedTo && !isVoid && cents(r.total - (r.deposit || 0)) > 0) a.push({ act: 'pay', label: r.deposit > 0 ? `Take more deposit · ${money(r.deposit)} paid` : 'Take deposit' });
    if (r.kind === 'invoice' && UNPAID.has(r.state)) a.push({ act: 'pay', label: r.paid > 0 ? `Take payment · ${money(r.balance)} left` : 'Take payment', primary: true });
    a.push({ act: 'reprint', label: 'Reprint' });
    if (r.kind === 'invoice' && canPdf) a.push({ act: 'pdf', label: 'Open PDF' });
    if (r.kind !== 'receipt' && !isVoid) a.push(r.email ? { act: 'email', label: 'Email' } : { act: 'email', label: 'Email' });
    if (!isVoid) a.push({ act: 'edit', label: 'Edit' });
    if (r.kind === 'invoice' && !isVoid && (r.paymentsLive || []).length) a.push({ act: 'undoPay', label: r.paymentsLive.length > 1 ? 'Undo last payment' : r.state === 'paid' ? 'Undo paid' : 'Undo payment' });
    if (r.kind === 'quote' && !r.convertedTo && (r.paymentsLive || []).length) a.push({ act: 'undoPay', label: 'Undo last deposit' });
    if (!isVoid && r.docType !== 'internal' && !r.convertedTo && !r.replaces && !isQbo(r)) a.push({ act: 'retype', label: 'Change type', quiet: true, menu: true });
    if (r.state === 'cancelled') a.push({ act: 'uncancel', label: r.kind === 'quote' ? 'Restore quote' : 'Undo cancel' });
    else if (!isVoid && r.docType !== 'internal' && !(r.kind === 'quote' && r.convertedTo)) a.push({ act: 'cancel', label: r.kind === 'quote' ? 'Delete quote' : 'Cancel sale', quiet: true });
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
    const befores = (marks && marks.before && marks.before[r.txnId]) || [];
    if (befores.length) befores.forEach((b, i) => ev.push({ t: 'Edited', d: b.date, at: '', before: i }));
    else if (edited) ev.push({ t: 'Edited', d: edited, at: '' });
    const log = marks && marks.log && [...(marks.log[r.txnId] || []), ...(r.number && r.number !== r.txnId ? marks.log[r.number] || [] : [])];
    if (log && log.length) {
      for (const m of log.sort((a, b) => a.at.localeCompare(b.at))) ev.push({ t: OUTPUT_LABEL(m), d: m.date, at: [timeOf(m.at), PLACES[m.place] || ''].filter(Boolean).join(' · ') });
    } else {
      const draft = marks && marks.drafts && (marks.drafts[r.txnId] || marks.drafts[r.number]);
      if (draft) ev.push({ t: 'Email draft made', d: draft, at: '' });
    }
    if ((r.kind === 'invoice' || r.kind === 'quote') && !isQbo(r)) {
      const from = (records || []).find(x => x.txnId === r.fromQuote && x.kind === 'quote'); // its deposit shows on the sale made from it
      const ids = new Set([r.txnId, from && from.txnId].filter(Boolean)), nums = new Set([r.number, from && from.number].filter(Boolean));
      const mine = L.parsePayments(paymentRows).filter(p => ids.has(p.txnId) || (!p.txnId && nums.has(p.invoice_number)));
      const seen = new Set();
      for (const p of mine.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) {
        if (seen.has(p.payment_id)) continue;
        seen.add(p.payment_id);
        const dep = r.kind === 'quote' || (from && p.txnId === from.txnId);
        ev.push({ t: p.voids ? (dep ? 'Deposit undone' : 'Payment undone') : `${dep ? 'Deposit' : 'Paid'} ${money(p.amount)} by ${(METHOD_LABEL[p.method] || p.method).toLowerCase()}`, d: p.date, at: PLACES[p.place] || '' });
      }
    }
    if (r.state === 'void' && !isQbo(r)) { const n = (records || []).find(x => (x.number || x.txnId) === r.replacedBy); ev.push({ t: `Corrected, replaced by ${r.replacedBy}`, d: n ? n.date : '', at: n ? placeOf(n.number) : '' }); }
    if (r.state === 'cancelled') ev.push({ t: 'Cancelled', d: r.cancelledAt, at: '' });
    if (r.convertedTo) { const n = (records || []).find(x => (x.number || x.txnId) === r.convertedTo); ev.push({ t: `Turned into sale ${r.convertedTo}`, d: n ? n.date : '', at: n ? placeOf(n.number) : '' }); }
    return ev.sort((a, b) => (a.d || '').localeCompare(b.d || ''));
  }

  // The print request, built from a Ledger record the way POS/index.html saleScreenDocumentRequest() builds it from the sale
  // screen. The sheet has no PO or brand, so those print empty; a line discount comes from item columns O and P.
  // A quote with a deposit carries one note line saying so, on screen, on every print and in the sale made from it (Trevor, Nov 1).
  // Added once: a sale that already has a "Deposit paid" note (saved from an earlier conversion) is left as it is.
  function withDeposit(r) {
    if (!(r && r.kind === 'quote' && r.deposit > 0) || (r.items || []).some(i => i.pn === 'Note' && /^deposit paid/i.test(s(i.desc)))) return r;
    const desc = `Deposit paid ${money(r.deposit)}. Balance due ${money(cents(r.total - r.deposit))}.`;
    return { ...r, items: [...(r.items || []), { pn: 'Note', desc, qty: '', ea: 0, sub: 0, serials: [], origEa: 0, off: 0 }] };
  }
  function requestFromRecord(rec) {
    const r = withDeposit(rec);
    const items = r.items.filter(i => i.pn !== 'Note');
    const subtotal = items.reduce((a, i) => a + i.sub, 0);
    const tax = isQbo(r) ? r.tax : subtotal * TAX_RATE; // QuickBooks states its own tax and has no card fee
    const rest = cents(r.total) - cents(subtotal) - cents(tax);
    const cardFee = !isQbo(r) && Math.abs(rest) >= 0.05 ? rest : 0; // a sale with the card fee on; less is rounding
    const completion = new Date(r.date ? `${r.date}T12:00:00-10:00` : Date.now());
    const billing = r.street || r.city
      ? { billing_address: { lines: r.addrLines || (r.street ? [r.street] : []), city: r.city, region: regionOf(r), postal_code: r.zip, country: '' } }
      : { address: r.addr || '' };
    return {
      po: '', type: r.kind, number: r.number || r.txnId, completionAt: completion.toISOString(),
      ...(r.kind === 'invoice' && r.paid > 0 ? { paid: m2(r.paid) } : {}), // part or full payments print as Amount paid / Balance due
      dueDate: r.kind === 'invoice' ? (r.dueDate || null) : null,
      customer: { name: r.name, company: r.company, phone: r.phone, email: r.email, ...billing },
      lines: r.items.map(i => (i.pn === 'Note'
        ? { kind: 'note', description: i.desc }
        : { kind: 'item', part_number: i.pn, make: '', description: i.desc, quantity: s(i.qty) || '1', serials: i.serials.filter(x => !s(i.desc).toUpperCase().includes(x)), // QuickBooks already prints S/N in the description
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
    const extras = { ...(po ? { po } : {}), ...(request.type === 'invoice' && request.paid ? { paid: request.paid } : {}) };
    const copies = request.type === 'invoice' ? ['customer', 'merchant'] : [undefined];
    return copies.map(copy => renderer.renderOfficialHtml(template, facts, extras, settings || renderer.DEFAULT_SETTINGS, copy));
  }

  // Take payment: one payment row. Payments add up; the default amount is what is still owed.
  function paymentRowsFor(r, method, today, place, now, amount) {
    return [L.buildPaymentRow({ invoice_number: r.number, txnId: r.txnId, date: today, amount: amount == null ? r.balance : amount, method, place: place || '' }, now)];
  }
  // The amount typed in the payment box: a number above 0 and no more than what is owed, or an error to show.
  function checkAmount(text, balance) {
    const v = s(text).replace(/[$,\s]/g, '');
    const n = /^\d*\.?\d{0,2}$/.test(v) && v !== '' && v !== '.' ? Number(v) : NaN;
    if (!(n > 0)) return { error: 'Enter an amount above $0.00.' };
    if (Math.round(n * 100) > Math.round(balance * 100)) return { error: `That is more than the ${money(balance)} owed.` };
    return { amount: n };
  }

  // UI memory: in memory for tab switches, sessionStorage for a reload. Storage may be missing or throw.
  const DEFAULT_UI = Object.freeze({ section: 'recent', invSub: 'unpaid', quoteSub: 'open', when: '', src: '', cShow: '', cSort: '', q: '', sel: '', scroll: 0, closed: [] });
  function loadUi(storage) {
    try {
      const v = JSON.parse(storage.getItem(STORE_KEY) || 'null');
      if (v && typeof v === 'object') return { ...DEFAULT_UI, ...v, closed: Array.isArray(v.closed) ? v.closed : [] };
    } catch (_) { /* private window or blocked storage */ }
    return { ...DEFAULT_UI, closed: [] };
  }
  function saveUi(storage, ui) { try { storage.setItem(STORE_KEY, JSON.stringify(ui)); return true; } catch (_) { return false; } }

  // The one line that replaces Mark paid / Undo on a QuickBooks record.
  const qboNote = r => (!isQbo(r) ? '' : r.kind !== 'invoice' ? 'From QuickBooks' : r.state === 'paid' ? 'Paid in QuickBooks' : r.state === 'void' ? 'Void in QuickBooks' : 'Open in QuickBooks');

  // "QuickBooks as of Sat 2:04 AM" (Honolulu) from the file's own generatedAt; stale after 4 days (96 hours).
  const QBO_STALE_HOURS = 96;
  const QBO_STALE_MS = QBO_STALE_HOURS * 3600 * 1000;
  const HNL = new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  function qboAsOf(generatedAt, now) {
    const t = Date.parse(generatedAt);
    if (!Number.isFinite(t)) return null;
    const p = {}; for (const x of HNL.formatToParts(t)) p[x.type] = x.value;
    return { text: `QuickBooks as of ${p.weekday} ${p.hour}:${p.minute} ${p.dayPeriod}`, stale: now - t > QBO_STALE_MS };
  }
  // What the History header shows about QuickBooks: { text, stale, control: 'button' | 'mac' | '', label, busy, error }.
  function qboBar({ loading, loaded, generatedAt, canRefresh, refreshing, failed }, now) {
    if (loading) return { text: '', stale: false, control: '', label: '', busy: false, error: '' };
    const info = loaded && qboAsOf(generatedAt, now);
    return { text: info ? info.text : 'QuickBooks history not loaded', stale: !!(info && info.stale),
      control: canRefresh ? 'button' : 'mac', busy: !!refreshing,
      label: refreshing ? 'Refreshing… (takes a few minutes)' : canRefresh ? 'Refresh from QuickBooks' : 'Refresh on the Mac',
      error: failed && !refreshing ? 'Refresh did not finish. Try again later.' : '' };
  }
  // 'done' (file changed, reload ran) or 'failed'. 'busy' means main is already refreshing (e.g. the page was reloaded): stay
  // "refreshing" and re-read every 20 s for up to 8 minutes until the file's generatedAt differs from the one showing now.
  async function runQboRefresh(h, reload, { generated = () => '', sleep = ms => new Promise(ok => setTimeout(ok, ms)), pollMs = 20000, giveUpMs = 8 * 60000 } = {}) {
    let r;
    const start = generated();
    try { r = await h.refreshQbo(); } catch (_) { return 'failed'; }
    if (r && r.reason === 'busy') {
      for (let waited = 0; waited < giveUpMs; waited += pollMs) {
        await sleep(pollMs);
        await reload();
        if (generated() !== start) return 'done';
      }
      return 'failed';
    }
    if (!r || !r.ok) return 'failed';
    await reload();
    return 'done';
  }
  // The QuickBooks loader (state in st). A call while a read is in flight asks for one more read after it, so a refresh that
  // finishes mid-read never leaves the old file showing; the returned promise settles when that extra read is done.
  function qboLoader(st, host, hooks, now = Date.now) {
    async function load() {
      const h = host();
      if (!h || !h.readQboHistory || st.phase !== 'ready') return undefined;
      if (st.qboBusy) { st.qboAgain = true; return st.qboRun; }
      if (st.qboAt && now() - st.qboAt < QBO_RECHECK_MS) return undefined;
      st.qboBusy = true;
      st.qboRun = (async () => {
        if (!st.qbo) hooks.loading(true);
        try {
          const res = await h.readQboHistory(st.qboVersion);
          st.qboAt = now();
          if (res && !res.unchanged && res.data) {
            st.qboCustomers = Array.isArray(res.data.customers) ? res.data.customers : [];
            st.qboVersion = res.modifiedTime || '';
            st.qboGenerated = res.data.generatedAt || '';
            hooks.apply(res.data);
          }
        } catch (_) {
          if (!st.qbo && !st.qboWarned) { st.qboWarned = true; hooks.failed(); }
        }
        st.qboBusy = false;
        st.qboTried = true;
        hooks.loading(false);
        hooks.done();
        if (st.qboAgain) { st.qboAgain = false; st.qboAt = 0; await load(); }
      })();
      return st.qboRun;
    }
    return load;
  }

  const pure = { qboAsOf, qboBar, runQboRefresh, qboLoader, qboNote, byNewest, TAX_RATE, SECTIONS, INVOICE_SUBS, QUOTE_SUBS, METHOD_LABEL, decorate, statusOf, buildView, subCounts, actionsFor, FILTERS, checkAmount, filterRecords,
    buildCustomerView, customerSource, customerBalance, newInvoiceTxn, historyFor, requestFromRecord, factsFromRequest, documentPages, paymentRowsFor, loadUi, saveUi, placeOf, money, fmtD };

  // ------------------------------------------------------------------ page
  function boot() {
    const doc = root.document;
    const $ = id => doc.getElementById(id);
    const store = (() => { try { return root.sessionStorage; } catch (_) { return null; } })();
    const ui = store ? loadUi(store) : { ...DEFAULT_UI, closed: [] };
    const st = { phase: 'loading', model: null, records: [], payRows: [], custRows: [], qboCustomers: [], cust: null, custRev: 0, recLimit: 100, backTo: '', marks: { drafts: {}, edits: {} }, local: { drafts: {} },
      today: '', busy: '', template: null, docKey: '', pages: null, docErr: '',
      qbo: null, qboVersion: '', qboAt: 0, qboBusy: false, qboWarned: false, qboAgain: false, qboRun: null, qboTried: false, qboGenerated: '', refreshing: false, refreshFailed: false, rev: 0, limit: PAGE, view: null };
    const host = () => root.MPELedgerHost;
    const remember = () => { if (store) saveUi(store, ui); };
    const recById = id => st.records.find(r => r.txnId === id);
    const byId = id => (ui.section === 'customers' ? (st.cust && st.cust.map.get(id)) : recById(id)); // the selected row of the section on screen
    // Customers are grouped once per change of records or Customers-tab rows, not per keystroke.
    function customers() {
      const key = st.rev + ':' + st.custRev;
      if (!st.cust || st.cust.key !== key) {
        const list = L.buildCustomers({ qbo: st.qboCustomers, sheetRows: st.custRows, records: st.records });
        st.cust = { key, list, map: new Map(list.map(c => [c.id, c])) };
      }
      return st.cust;
    }

    async function load() {
      const h = host();
      if (!h) { st.phase = 'nohost'; return draw(); }
      if (!st.model) { st.phase = 'loading'; draw(); }
      try {
        const [tx, pay, mk, cu] = await Promise.all([h.readTransactions(), h.readPayments(), h.readMarks ? h.readMarks() : null,
          h.readCustomers ? h.readCustomers().catch(() => st.custRows) : st.custRows]); // customer rows are extra: a failure keeps the last ones
        st.custRows = cu || []; st.custRev++;
        st.today = (h.honoluluToday && h.honoluluToday()) || L.honoluluToday();
        st.payRows = pay || [];
        st.marks = { drafts: { ...((mk && mk.drafts) || {}), ...st.local.drafts }, edits: { ...((mk && mk.edits) || {}) }, before: (mk && mk.before) || {}, log: (mk && mk.log) || {}, sent: (mk && mk.sent) || {} };
        st.model = await L.create({ txnRows: tx || [], paymentRows: st.payRows, drafts: st.marks.drafts, today: st.today });
        if (st.qbo) st.model.addQbo(st.qbo, st.today); // QuickBooks copy already downloaded: merge before the first draw
        setRecords(st.model.records);
        st.phase = 'ready';
      } catch (e) {
        st.phase = e && e.code === 'not_signed_in' ? 'signedout' : (st.model ? 'ready' : 'error');
        if (st.model) toast('Could not refresh. Showing what was loaded before.');
      }
      draw();
      loadQbo();
    }
    function setRecords(list) { st.records = decorate(list); st.rev++; st.view = null; }

    // QuickBooks history arrives after the sheet is on screen. Failure leaves the sheet as it was.
    const loadQbo = qboLoader(st, host, {
      apply: data => { st.qbo = L.qboRecords(data); setRecords(st.model.addQbo(st.qbo, st.today)); },
      loading: on => { $('qbNote').hidden = !on; if (on) $('qbNote').textContent = 'Loading QuickBooks history…'; },
      failed: () => toast('QuickBooks history could not load. Showing the sales sheet only.'),
      done: () => { if (st.phase === 'ready') draw(); },
    });

    // The "QuickBooks as of" line, amber when stale, with the Mac's Refresh button or "Refresh on the Mac" on the others.
    function drawQbo() {
      const h = host(), el = $('qbAsOf');
      const m = qboBar({ loading: !st.qboTried && !!(h && h.readQboHistory), loaded: !!st.qbo, generatedAt: st.qboGenerated,
        canRefresh: !!(h && h.refreshQbo), refreshing: st.refreshing, failed: st.refreshFailed }, Date.now());
      el.hidden = !m.text;
      el.innerHTML = m.text ? `<span class="${m.stale ? 'stale' : ''}">${esc(m.text)}</span>`
        + (m.control === 'button' ? `<button class="btn quiet" data-act="qboRefresh"${m.busy ? ' disabled' : ''}>${esc(m.label)}</button>` : `<span>${esc(m.label)}</span>`)
        + (m.error ? `<span class="stale">${esc(m.error)}</span>` : '') : '';
    }
    async function refreshQbo() {
      const h = host();
      if (st.refreshing || !h || !h.refreshQbo) return;
      st.refreshing = true; st.refreshFailed = false; drawQbo();
      const out = await runQboRefresh(h, async () => { st.qboAt = 0; await loadQbo(); }, { generated: () => st.qboGenerated });
      st.refreshing = false; st.refreshFailed = out === 'failed'; drawQbo();
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
      drawQbo();
      const sum = st.model.owedSummary();
      // Footer, the same on every section, so nothing above the list moves.
      $('owed').innerHTML = `Owed <span class="num">${money(sum.total)}</span> · <span class="${sum.overdue ? 'late' : ''}">${sum.overdue} overdue</span>`;
      const counts = ui.section === 'invoices' || ui.section === 'quotes' ? subCounts(st.records) : {};
      $('sections').innerHTML = SECTIONS.map(([k, label]) => `<button data-section="${k}" aria-pressed="${ui.section === k}">${label}</button>`).join('');
      const subs = ui.section === 'invoices' ? ['invSub', INVOICE_SUBS] : ui.section === 'quotes' ? ['quoteSub', QUOTE_SUBS] : null;
      // One row of drop-downs under the search box on every section: what to show (Invoices, Quotes), date and source, or the
      // customer filter and sort. Fixed height, never wraps.
      const subSel = subs ? `<select data-filter="${subs[0]}" aria-label="Show" class="${(ui[subs[0]] || subs[1][0][0]) !== subs[1][0][0] ? 'on' : ''}">${subs[1].map(([k, label]) =>
        `<option value="${k}"${(ui[subs[0]] || subs[1][0][0]) === k ? ' selected' : ''}>${esc(label)}${counts[k] != null && ['unpaid', 'dueSoon', 'overdue', 'open'].includes(k) ? ` (${counts[k]})` : ''}</option>`).join('')}</select>` : '';

      const inCust = ui.section === 'customers';
      $('q').placeholder = SEARCH_HINT[ui.section] || SEARCH_HINT.recent;
      $('q').title = inCust ? 'Name, company, phone or email' : 'Name, company, phone, part #, serial #, invoice or quote number';
      $('q').setAttribute('aria-label', $('q').placeholder);
      const fkeys = inCust ? ['cShow', 'cSort'] : ['when', 'src'];
      $('filters').innerHTML = subSel + fkeys.map(k => `<select data-filter="${k}" aria-label="${k === 'cSort' ? 'Sort' : 'Filter'}" class="${ui[k] ? 'on' : ''}">${FILTERS[k].map(([v, label]) => `<option value="${v}"${ui[k] === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`).join('');
      const view = currentView();
      const rows = view.rows;
      if (!byId(ui.sel)) ui.sel = rows[0] ? rows[0].txnId : ''; // a record that leaves the view (just paid) stays selected
      const at = rows.findIndex(r => r.txnId === ui.sel);
      if (at >= st.limit) st.limit = at + 1; // arrow keys walk past the drawn rows
      let room = st.limit;
      const keep = list.scrollTop;
      list.innerHTML = view.groups.length ? view.groups.map(g => {
        const body = g.rows.slice(0, Math.max(0, room)).map(inCust ? custRowHtml : rowHtml).join('');
        room -= g.rows.length;
        if (!g.label) return `<div class="flat">${body}</div>`;
        return `<details data-g="${g.key}" ${ui.closed.includes(g.key) ? '' : 'open'}><summary class="${g.tone === 'late' ? 'red' : ''}">${ICON.right}${esc(g.label)} ${view.search ? '' : `<span class="ct">${g.count}</span>`}<span class="tot num">${g.total == null ? '' : money(g.total)}</span></summary>${body}</details>`;
      }).join('') + (rows.length > st.limit ? `<button class="btn more" data-act="more">Show ${Math.min(PAGE, rows.length - st.limit)} more of ${(rows.length - st.limit).toLocaleString('en-US')} left</button>` : '')
        : `<div class="empty">${esc(view.empty)}${view.search ? '<br><button class="btn" style="margin-top:10px" data-act="clearSearch">Clear search</button>' : ''}</div>`;
      list.scrollTop = st.firstDraw ? keep : ui.scroll;
      st.firstDraw = true;
      list.querySelectorAll('details').forEach(el => el.addEventListener('toggle', () => {
        const k = el.dataset.g; ui.closed = ui.closed.filter(x => x !== k); if (!el.open) ui.closed.push(k); remember();
      }));
      if (inCust) drawCustomer(byId(ui.sel)); else drawRecord(byId(ui.sel));
      remember();
    }

    // buildView is pure: rebuilt only when the records or the section / sub-tab / search change, not on every selection.
    function currentView() {
      const inCust = ui.section === 'customers';
      const key = [st.rev, inCust ? st.custRev : '', ui.section, ui.invSub, ui.quoteSub, ui.when, ui.src, ui.cShow, ui.cSort, s(ui.q)].join('\u0001');
      if (!st.view || st.view.key !== key) {
        const v = inCust ? buildCustomerView(customers().list, ui, st.today) : buildView(st.records, ui, st.today);
        st.view = { key, ...v, rows: v.groups.flatMap(g => g.rows) };
        st.limit = PAGE;
      }
      return st.view;
    }

    // Row: who (or the top item), total; then date and time, and the type with its status for invoices.
    function rowHtml(r) {
      const when = [fmtD(r.date), fmtT(r.time)].filter(Boolean).join(' · ');
      // Type spot (Trevor, Nov 2): only Cancelled, Repair, Invoice or Quote, in that order; a sale shows nothing. Labor makes it Repair.
      const repair = (r.items || []).some(i => /labor/i.test(i.pn) || /labor/i.test(i.desc));
      const kind = r.state === 'cancelled' ? '<b class="k-cancel">Cancelled</b>' : repair ? '<b class="k-repair">Repair</b>' : r.kind === 'receipt' ? '' : `<b class="k-doc">${esc(KIND_LABEL[r.kind])}</b>`;
      return `<button class="row${r.state === 'void' || r.state === 'cancelled' ? ' is-void' : ''}" role="option" data-id="${esc(r.txnId)}" aria-selected="${r.txnId === ui.sel}">
        <span class="nm${r.qboBuyer || !(r.company || r.name) ? ' noname' : ''}">${esc(r.qboBuyer ? 'QuickBooks buyer: ' + r.qboBuyer.name : who(r))}</span><span class="amt num">${money(UNPAID.has(r.state) ? r.balance : r.total)}</span>
        <span class="sub num">${esc(when)}</span><span class="when">${kind}</span></button>`;
    }

    // Customer row: name, what is owed, then contact and last activity.
    function custRowHtml(c) {
      const sub = [c.company ? c.name : '', c.phone].filter(Boolean).join(' · ');
      const last = c.last ? 'Last ' + (c.last.slice(0, 4) === st.today.slice(0, 4) ? fmtD(c.last) : fmtDY(c.last)) : 'No sales yet';
      const n = c.count ? ` · ${c.count} record${c.count === 1 ? '' : 's'}` : '';
      return `<button class="row" role="option" data-id="${esc(c.id)}" aria-selected="${c.id === ui.sel}">
        <span class="nm">${esc(c.company || c.name)}</span><span class="amt num ${c.overdue ? 'late' : ''}">${c.balance > 0 ? money(c.balance) : ''}</span>
        <span class="sub num">${esc(sub)}</span><span class="when muted">${esc(last + n)}${c.inactive ? ' · Inactive' : ''}</span></button>`;
    }

    // Customer view: contact block and the 2026 balance in the middle, then every record newest first; actions on the right.
    function drawCustomer(c) {
      st.docKey = ''; // a document still being drawn must not land here
      $('note').innerHTML = '';
      if (!c) { $('paper').innerHTML = '<div class="empty">Pick a customer on the left.</div>'; $('rail').innerHTML = ''; return; }
      const bal = customerBalance(c);
      const line = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : '');
      const all = byNewest(c.records);
      const shown = all.slice(0, st.recLimit);
      const recs = shown.map(r => {
        const t = statusOf(r, st.today);
        return `<button class="crec" data-open="${esc(r.txnId)}"><span class="num">${esc(r.number || r.txnId)}</span><span>${esc(KIND_LABEL[r.kind])}${isQbo(r) ? ' · QuickBooks' : ''}</span>
          <span class="num">${esc(fmtDY(r.date))}</span><span class="${r.kind === 'invoice' ? t.tone : 'muted'}">${esc(r.kind === 'invoice' ? t.text : '')}</span>
          <span class="amt num">${money(UNPAID.has(r.state) ? r.balance : r.total)}</span></button>`;
      }).join('');
      $('paper').innerHTML = `<div class="cust">
        <h2>${esc(c.company || c.name)}</h2>
        <dl class="cinfo">${line('Contact', c.company ? c.name : '')}${line('Phone', c.phone)}${line('Email', c.email)}${line('Address', c.addr)}</dl>
        <div class="cbal"><span class="pill ${bal.tone}">${esc(bal.text)}</span><span class="muted">Counts invoices from 2026 on. Older open invoices are not added in.</span></div>
        <h3>${all.length ? `Records (${all.length})` : 'Records'}</h3>
        ${all.length ? `<div class="crecs">${recs}</div>` : '<div class="empty">No sales or quotes on file for this customer.</div>'}
        ${all.length > shown.length ? `<button class="btn more" data-act="cMore">Show all ${all.length}</button>` : ''}</div>`;
      $('rail').innerHTML = `
        <div><h3>Customer</h3><div class="big">${esc(c.company || c.name)}</div><div class="state"><span class="pill ${bal.tone}">${esc(bal.text)}</span></div></div>
        <div class="acts"><button class="btn primary" data-act="cNew">${ICON.newInvoice}<span>New invoice for this customer</span></button>
          <button class="btn" data-act="cEdit">${ICON.edit}<span>Edit</span></button></div>
        <div><h3>Where this came from</h3><div class="muted">${esc(customerSource(c))}</div></div>`;
    }

    function drawRecord(r) {
      if (!r) { $('note').innerHTML = ''; $('paper').innerHTML = '<div class="empty">Pick a sale on the left.</div>'; $('rail').innerHTML = ''; st.docKey = ''; return; }
      const t = statusOf(r, st.today);
      const back = st.backTo && st.cust && st.cust.map.get(st.backTo);
      $('note').innerHTML = (back ? `<div class="note-plain"><a class="rec" href="#" data-act="backCust">&larr; Back to ${esc(back.company || back.name)}</a></div>` : '') + (r.state === 'void' && isQbo(r)
        ? '<div class="note-void"><b>VOID.</b> This invoice is void in QuickBooks and does not count as owed.</div>'
        : r.state === 'void'
        ? `<div class="note-void"><b>VOID.</b> This invoice was corrected and does not count as owed. The replacement is <a class="rec" href="#" data-go="${esc(r.replacedBy)}">${esc(r.replacedBy)}</a>.</div>`
        : r.state === 'cancelled' ? `<div class="note-void">Cancelled ${esc(fmtD(r.cancelledAt))}. ${r.kind === 'quote' ? 'This quote is deleted. You can restore it.' : 'Its items went back into stock and it does not count as owed.'}</div>`
        : r.replaces ? `<div class="note-plain">Replaces <a class="rec" href="#" data-go="${esc(r.replaces)}">${esc(r.replaces)}</a>, which is now void. Both PDFs are kept.</div>` : '');
      const snap = st.before && st.before.txnId === r.txnId && ((st.marks.before || {})[r.txnId] || [])[st.before.i];
      const old = snap && L.derive(L.parseTransactions(snap.rows), [], st.today)[0];
      if (old) $('note').innerHTML += `<div class="note-plain">The copy before the edit on ${esc(fmtD(snap.date))}. <a class="rec" href="#" data-act="beforeOff">Back to the current copy</a></div>`;
      else st.before = null;
      drawDocument(old || r);
      const draft = st.marks.drafts[r.txnId] || st.marks.drafts[r.number];
      const sent = (st.marks.sent || {})[r.txnId] || (st.marks.sent || {})[r.number];
      const acts = actionsFor(r, !!(host() && host().openPdf)).filter(a => a.act !== 'retype' || typeChoices(r).length);
      const qn = qboNote(r);
      const btn = a => `<button class="btn${a.primary ? ' primary' : ''}${a.quiet ? ' quiet' : ''}" data-act="${a.act}"${a.disabled || st.busy ? ' disabled' : ''}${a.why ? ` title="${esc(a.why)}"` : ''}>${ICON[a.act] || ''}<span>${st.busy === a.act ? 'Saving…' : esc(a.label)}</span>${a.menu ? ICON.down : ''}</button>${a.disabled && a.why ? `<span class="why">${esc(a.why)}</span>` : ''}`;
      const addr = [r.street, [r.city, regionOf(r), r.zip].filter(Boolean).join(' ')].filter(Boolean);
      const hist = historyFor(r, st.payRows, st.marks, st.records);
      $('rail').innerHTML = `
        <div><h3>${esc(KIND_LABEL[r.kind])} ${esc(r.number)}</h3><div class="big num">${money(r.total)}</div>
          <div class="state"><span class="pill ${t.tone}">${['paid'].includes(t.key) ? ICON.check : ''}${esc(t.pill)}</span>${awaitingPickup(r) ? '<span class="pill soon">Presold, awaiting pickup</span>' : ''}${qn ? `<span class="pill muted">${esc(qn)}</span>` : ''}${sent ? `<span class="pill draft">${ICON.email}Emailed ${esc(fmtD(sent))}</span>` : draft ? `<span class="pill draft">${ICON.email}Draft made ${esc(fmtD(draft))}</span>` : ''}</div></div>
        ${r.name || r.company || r.phone || r.qboBuyer ? `<button class="who" data-act="${r.state === 'void' || r.state === 'cancelled' || isQbo(r) ? 'noop' : 'edit'}" title="${isQbo(r) ? '' : 'Edit customer'}"><h3>Customer ${r.state === 'void' || r.state === 'cancelled' || isQbo(r) ? '' : ICON.edit}</h3><b${r.qboBuyer ? ' class="muted"' : ''}>${esc(r.qboBuyer ? 'QuickBooks buyer: ' + r.qboBuyer.name : r.company || r.name)}</b>${!r.qboBuyer && r.company && r.name ? esc(r.name) + '<br>' : ''}${r.phone ? esc(r.phone) + '<br>' : ''}${r.email ? esc(r.email) : '<span class="muted">No email on file</span>'}${addr.length ? '<br>' + addr.map(esc).join('<br>') : ''}</button>` : ''}
        <div class="acts">${acts.map(btn).join('')}</div>
        <div><h3>History</h3><ol>${hist.map(e => `<li>${esc(e.t)}<span>${esc([fmtD(e.d), e.at].filter(Boolean).join(' · '))}</span>${e.before != null ? `<a class="rec" href="#" data-before="${e.before}">See it before this edit</a>` : ''}</li>`).join('')}</ol></div>`;
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
    // Take payment: amount (what is owed, typed over for a part payment) and how it was paid.
    function takePayment(r) {
      const d = $('payDlg');
      const dep = r.kind === 'quote', left = dep ? cents(r.total - (r.deposit || 0)) : r.balance;
      $('payTitle').textContent = `${dep ? 'Take deposit' : 'Take payment'} on ${r.number}`;
      $('payOwed').textContent = dep ? `Quote total ${money(r.total)}${r.deposit > 0 ? `, ${money(r.deposit)} deposit paid` : ''}`
        : r.paid > 0 ? `${money(r.balance)} left of ${money(r.total)}` : `${money(r.balance)} owed`;
      $('payAmt').value = dep ? '' : m2(r.balance);
      $('payErr').textContent = '';
      d.returnValue = '';
      d.onsubmit = e => {
        if (!e.submitter || !METHOD_LABEL[e.submitter.value]) return;
        const c = checkAmount($('payAmt').value, left);
        if (c.error) { e.preventDefault(); $('payErr').textContent = c.error; $('payAmt').focus(); return; }
        d.amount = c.amount;
      };
      d.onclose = () => { if (METHOD_LABEL[d.returnValue]) markPaid(r, d.returnValue, d.amount); };
      $('payDlg').querySelector('.hint').textContent = dep ? 'The deposit counts toward the sale made from this quote.' : 'Type a smaller amount for a part payment. The rest stays owed.';
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      $('payAmt').select();
    }
    function markPaid(r, method, amount) {
      run('pay', async () => {
        await host().appendPaymentRows(paymentRowsFor(r, method, st.today, host().place, Date.now(), amount));
        const left = cents(r.balance - amount);
        if (r.kind === 'quote') return { text: `${money(amount)} deposit taken on ${r.number} by ${METHOD_LABEL[method].toLowerCase()}.`, undo: () => undoPaid(r.txnId) };
        return { text: left > 0 ? `${money(amount)} taken on ${r.number} by ${METHOD_LABEL[method].toLowerCase()}. ${money(left)} still owed.`
          : `${r.number} paid in full by ${METHOD_LABEL[method].toLowerCase()}.`, undo: () => undoPaid(r.txnId) };
      });
    }
    function undoPaid(id) {
      run('undoPay', async () => {
        await load();
        const r = recById(id);
        const rows = r ? L.undoRows(r, Date.now(), host().place || '') : [];
        if (!rows.length) return `${id} has no payment to undo.`;
        await host().appendPaymentRows(rows);
        return r.kind === 'quote' ? `Last deposit on ${r.number} undone.` : `${r.number} is unpaid again.`;
      });
    }
    // Email: the shared email window (email-window.js). It sends only when a person presses Send.
    function emailWindow(r) {
      const request = st.request || requestFromRecord(r);
      run('email', async () => {
        const prep = await host().emailPrepare(r, request);
        st.busy = ''; draw();
        const out = await root.MPEEmailWindow.open({ ...prep, pages: prep.pages || (st.pages || []).slice(0, 1), key: r.txnId, heading: `Email ${KIND_LABEL[r.kind].toLowerCase()} ${r.number}`,
          cannotSend: prep.canSend ? '' : 'This app needs its update before it can send. The update installs by itself when the register is idle.',
          send: f => host().sendEmail(r, prep, f) });
        return out && out.sent ? `Sent to ${out.to}.` : '';
      });
    }
    function openSale(kind, r, what) {
      run(kind, async () => { await host().openInNewSale({ kind, txn: withDeposit(r) }); return `${what} opened in a new sale tab. The sale in progress is unchanged.`; });
    }
    function act(k, el) {
      const r = byId(ui.sel);
      if (k === 'retry') return load();
      if (k === 'qboRefresh') return refreshQbo();
      if (k === 'clearSearch') { ui.q = ''; $('q').value = ''; return draw(); }
      if (k === 'clearFilters') { ui.when = ui.src = ui.cShow = ui.cSort = ''; ui.sel = ''; return draw(); }
      if (k === 'more') { st.limit += PAGE; return draw(); }
      if (k === 'beforeOff') { st.before = null; return draw(); }
      if (k === 'cMore') { st.recLimit = Infinity; return draw(); }
      if (k === 'backCust') { ui.section = 'customers'; ui.q = ''; $('q').value = ''; ui.sel = st.backTo; st.backTo = ''; return draw(); }
      if (ui.section === 'customers') {
        if (k === 'cNew' && r) return openSale('newInvoice', newInvoiceTxn(r), `A new invoice for ${r.company || r.name}`);
        if (k === 'cEdit' && r) return editCustomer(r);
        return;
      }
      if (!r) return;
      if (k === 'pay') return takePayment(r);
      if (k === 'undoPay') return undoPaid(r.txnId);
      if (k === 'pdf') return host().openPdf(r.number, r).then(res => { if (!res || !res.ok) toast(PDF_WHY[res && res.reason] || PDF_WHY.missing); else load(); }, () => toast(PDF_WHY.offline));
      if (k === 'reprint') return run('reprint', async () => { const out = await host().reprint(r, st.request || requestFromRecord(r)); return out?.printed === false ? 'Not printed.' : `${r.number} sent to print.`; });
      if (k === 'email') return emailWindow(r);
      if (k === 'toSale') return r.deposit > 0
        ? run('quote', async () => { await host().openInNewSale({ kind: 'quote', txn: withDeposit(r) }); return `Quote ${r.number} opened in a new sale tab. Deposit ${money(r.deposit)} already paid: collect ${money(cents(r.total - r.deposit))}.`; })
        : openSale('quote', r, `Quote ${r.number}`);
      if (k === 'copy') return openSale('copy', r, `A copy of ${r.number}`);
      if (k === 'newInvoice') return openSale('newInvoice', r, `A new invoice for ${who(r)}`);
      if (k === 'edit') return openSale('edit', r, `${r.number}`); // no popup (Trevor, Nov 1): the copy before the edit is kept
      if (k === 'retype') return typeMenu(r, el);
      if (k === 'cancel') return confirmCancel(r);
      if (k === 'uncancel') return setCancel(r, 'uncancel');
    }
    // Edit: the contact fields in a small form. Saving adds ONE row to the Customers tab (the newest row for a customer wins), kept
    // on this computer until the sheet shows it exactly.
    const EDIT_FIELDS = [['company', 'ceCompany'], ['name', 'ceName'], ['phone', 'cePhone'], ['email', 'ceEmail'], ['street', 'ceStreet'], ['city', 'ceCity'], ['region', 'ceState'], ['zip', 'ceZip']];
    function editCustomer(c) {
      const d = $('custEdit');
      for (const [key, id] of EDIT_FIELDS) $(id).value = c[key] || '';
      $('ceErr').textContent = '';
      d.returnValue = '';
      d.onsubmit = e => {
        if (e.submitter && e.submitter.value === 'save' && !s($('ceCompany').value) && !s($('ceName').value)) {
          e.preventDefault(); $('ceErr').textContent = 'Enter a company or a contact name.';
        }
      };
      d.onclose = () => {
        if (d.returnValue !== 'save') return;
        const f = Object.fromEntries(EDIT_FIELDS.map(([key, id]) => [key, $(id).value]));
        saveCustomer(c, f);
      };
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      $('ceCompany').focus();
    }
    function saveCustomer(c, f) {
      run('cSave', async () => {
        const key = L.customerKey(f.phone, f.company, f.name);
        const ref = c.qboId || (c.id.startsWith('k:') && key !== c.id.slice(2) ? c.id : ''); // see buildCustomerRow
        try { await host().appendCustomerRows([L.buildCustomerRow(f, ref, Date.now())]); }
        catch (e) { if (e && e.code === 'customers_missing') return 'The Customers tab is not on the sheet yet. Nothing was saved.'; throw e; }
        ui.sel = c.id;
        return `Saved. ${s(f.company) || s(f.name)} is updated.`;
      });
    }
    // Cancel sale: one 'cancel' mark on the Payments tab (ledger-data.js CANCEL). A payment must be undone first.
    function confirmCancel(r) {
      if ((r.paymentsLive || []).length) return toast(r.kind === 'quote' ? 'This quote has a deposit. Undo the deposit first.' : 'This invoice has a payment. Undo the payment first.');
      const quote = r.kind === 'quote';
      const d = $('confirm');
      $('confirmText').innerHTML = quote ? `<b>Delete quote ${esc(r.number)}?</b><br>It moves to Deleted quotes. You can restore it.` : `<b>Cancel sale ${esc(r.number)}?</b><br>The items go back into stock. You can undo this.`;
      $('confirmNo').textContent = quote ? 'Keep quote' : 'Keep sale'; $('confirmOk').textContent = quote ? 'Delete quote' : 'Cancel sale';
      d.returnValue = '';
      d.onclose = () => { if (d.returnValue === 'ok') setCancel(r, 'cancel'); };
      if (d.showModal) d.showModal(); else if (root.confirm(quote ? `Delete quote ${r.number}? You can restore it.` : `Cancel sale ${r.number}? The items go back into stock. You can undo this.`)) setCancel(r, 'cancel');
    }
    function setCancel(r, kind) {
      run(kind, async () => {
        await load();
        const now = recById(r.txnId);
        if (!now) return `${r.number} was not found.`;
        if (isQbo(now) || now.state === 'void' || now.docType === 'internal' || (now.kind === 'quote' && now.convertedTo)) return 'This record cannot be removed.';
        if (kind === 'cancel' && (now.paymentsLive || []).length) return now.kind === 'quote' ? 'This quote has a deposit. Undo the deposit first.' : 'This invoice has a payment. Undo the payment first.';
        if ((now.state === 'cancelled') === (kind === 'cancel')) return kind === 'cancel' ? `${r.number} is already cancelled.` : `${r.number} is not cancelled.`;
        await host().appendPaymentRows([L.buildMarkRow({ kind, txnId: r.txnId, invoice_number: r.number, place: host().place || '' })]);
        return kind === 'cancel' ? { text: now.kind === 'quote' ? `${r.number} deleted.` : `${r.number} cancelled. Its items go back into stock.`, undo: () => setCancel(r, 'uncancel') } : now.kind === 'quote' ? `${r.number} restored.` : `${r.number} is back on the books.`;
      });
    }
    // Change to: invoice, receipt or quote, in place (one checked cell on the sheet; stock follows the new type).
    function typeChoices(r) {
      if (isQbo(r) || !host() || !host().setType || r.state === 'void' || r.state === 'cancelled' || r.docType === 'internal' || r.convertedTo || r.replaces) return [];
      return ['receipt', 'invoice', 'quote'].filter(k => k !== r.kind).map(k => ['type:' + k, `Change to ${k === 'receipt' ? 'sale (receipt)' : k}`]);
    }
    function changeType(r, to) {
      if ((r.paymentsLive || []).length && !(r.kind === 'quote' && to === 'invoice')) return toast(r.kind === 'quote' ? 'This quote has a deposit. Change it to an invoice, or undo the deposit first.' : 'This invoice has a payment. Undo the payment first.');
      const from = r.kind;
      run('retype', async () => {
        await host().setType(r, to);
        return { text: `${r.number} is now ${to === 'receipt' ? 'a sale' : (to === 'invoice' ? 'an ' : 'a ') + to}.`, undo: () => changeType({ ...r, kind: to }, from) };
      });
    }
    function typeMenu(r, el) { openMenu(el.getBoundingClientRect(), typeChoices(r), k => changeType(r, k.slice(5))); }
    // Right-click a row: the same actions as the panel on the right, plus Change to.
    function rowMenu(r, x, y) {
      if (ui.section === 'customers') return;
      const items = actionsFor(r, !!(host() && host().openPdf)).filter(a => !a.disabled && a.act !== 'retype')
        .map(a => [a.act, a.act === 'cancel' && r.kind !== 'quote' ? 'Remove (cancel sale)' : a.label]);
      const types = typeChoices(r);
      openMenu({ left: x, top: y, bottom: y }, types.length ? items.concat([['hint', 'Change type']], types) : items, k => k.startsWith('type:') ? changeType(r, k.slice(5)) : act(k));
    }
    function confirmEdit(r) {
      const d = $('confirm');
      $('confirmNo').textContent = 'Cancel'; $('confirmOk').textContent = 'Open to edit';
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
    function openMenu(b, items, onPick) { // b: a rect ({ left, top, bottom })
      const menu = $('menu');
      if (!items.length) return;
      menu.innerHTML = items.map(i => i[0] === 'hint' ? `<div class="hint">${esc(i[1])}</div>` : `<button type="button" data-k="${i[0]}">${esc(i[1])}</button>`).join('');
      menu.hidden = false;
      menu.style.left = Math.max(8, Math.min(b.left, root.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = (b.bottom + 4 + menu.offsetHeight > root.innerHeight ? b.top - menu.offsetHeight - 4 : b.bottom + 4) + 'px';
      const first = menu.querySelector('button'); if (first) first.focus();
      menu.onclick = e => { const btn = e.target.closest('button'); if (btn) { menu.hidden = true; onPick(btn.dataset.k); } };
    }
    function select(id) {
      if (ui.sel !== id) { st.recLimit = 100; st.before = null; }
      ui.sel = id; draw();
      const el = doc.querySelector(`.row[data-id="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
    }
    // A record in the customer view opens in the normal record view, with a way back to the customer.
    function openRecord(id) {
      st.backTo = ui.sel; ui.section = 'recent'; ui.q = ''; $('q').value = ''; ui.scroll = 0;
      select(id);
    }
    function go(number) {
      const r = st.records.find(x => (x.number || x.txnId) === number);
      if (!r) return;
      const view = currentView().rows;
      if (!view.includes(r)) { ui.q = ''; $('q').value = ''; ui.section = 'recent'; }
      select(r.txnId);
    }

    doc.addEventListener('click', e => {
      const t = e.target;
      const g = t.closest('[data-go]'); if (g) { e.preventDefault(); return go(g.dataset.go); }
      const bf = t.closest('[data-before]'); if (bf) { e.preventDefault(); st.before = { txnId: ui.sel, i: Number(bf.dataset.before) }; return draw(); }
      const a = t.closest('[data-act]'); if (a && !a.disabled) { e.preventDefault(); return act(a.dataset.act, a); }
      const o = t.closest('[data-open]'); if (o) return openRecord(o.dataset.open);
      const sec = t.closest('[data-section]'); if (sec) { st.backTo = ''; ui.section = sec.dataset.section; ui.q = ''; ui.sel = ''; $('q').value = ''; ui.scroll = 0; $('list').scrollTop = 0; return draw(); }
      const sub = t.closest('[data-sub]'); if (sub) { st.backTo = ''; const [key, v] = sub.dataset.sub.split(':'); ui[key] = v; ui.sel = ''; $('list').scrollTop = 0; return draw(); }
      const row = t.closest('.row[data-id]'); if (row) { st.backTo = ''; return select(row.dataset.id); }
    });
    $('list').addEventListener('contextmenu', e => {
      const row = e.target.closest('.row[data-id]');
      if (!row || ui.section === 'customers') return;
      e.preventDefault(); st.backTo = '';
      select(row.dataset.id);
      const r = byId(row.dataset.id); if (r) rowMenu(r, e.clientX, e.clientY);
    });
    doc.addEventListener('mousedown', e => { const menu = $('menu'); if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="pay"]')) menu.hidden = true; });
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('menu').hidden = true; return; }
      if (!['ArrowDown', 'ArrowUp'].includes(e.key) || (e.target.tagName === 'INPUT' && e.target.id !== 'q') || st.phase !== 'ready') return;
      const rows = currentView().rows;
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
    doc.addEventListener('change', e => {
      const f = e.target.closest('[data-filter]');
      if (f) { ui[f.dataset.filter] = f.value; ui.sel = ''; $('list').scrollTop = 0; draw(); }
    });
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

  const PDF_WHY = {
    missing: 'No saved PDF for this invoice. Only invoices printed after Nov 1 are saved.',
    waiting: 'The PDF is still uploading to Drive. Try again in a minute.',
    needs_sign_in: 'This computer needs one more Google sign-in to save PDFs. Use the app menu: Sign In to Google Again (on the PCs press Alt, then File).',
    offline: 'Could not reach Google Drive. Check the internet and try again.',
  };
  const ICON = {
    pdf: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4"/></svg>',
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
  const api = { ...pure, withDeposit, boot };
  return api;
});
