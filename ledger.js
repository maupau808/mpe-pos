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
 *   editEmbed(record, extra, { onState, onClose }) (optional) -> { sessionId, result: Promise<one result>, rect(msg), command(msg),
 *                                saveCustomer, scan? }; the one Edit: the register's sale lines in the middle, the customer in the panel
 *                                (editFlow). saveCustomer: the save command carries the customer (app 0.3.67+, website). Without it the
 *                                customer goes through editSession after the items. Without editEmbed Edit opens a new sale tab.
 *   editSession(record, patch, extra) (optional) -> Promise<one result>; customer fields saved by a hidden register page (0.3.66 fallback).
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
  const METHOD_LABEL = { cash: 'Cash', check: 'Check', card_terminal: 'Card terminal', helcim_card: 'Card online', helcim_ach: 'Bank transfer', ...L.CREDIT_LABELS }; // + credit_given / credit_used
  const KIND_LABEL = { invoice: 'Invoice', quote: 'Quote', receipt: 'Sale' };
  const STORE_KEY = 'mpe.ledger.ui';
  const UNPAID = new Set(['unpaid', 'dueSoon', 'overdue']);
  const PAGE = 400; // rows drawn at a time; "Show more" adds another page (25,000 rows at once would freeze the list)
  const SEARCH_HINT = { recent: 'Search all sales', invoices: 'Search invoices', quotes: 'Search quotes', sales: 'Search register sales', customers: 'Search customers' };
  const QBO_RECHECK_MS = 10 * 60 * 1000;
  const HELCIM_RECHECK_MS = 10 * 60 * 1000;
  const CREDIT_FROM = '2026-11-05T18:30:00-10:00'; // store credit release: only an overpay from an edit saved on or after this moves by itself

  const s = v => String(v == null ? '' : v).trim();
  const cents = n => Math.round(n * 100) / 100;
  const m2 = n => { const v = cents(n); return (Object.is(v, -0) ? 0 : v).toFixed(2); };
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = v => s(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dayNum = iso => { const [y, mo, d] = iso.split('-').map(Number); return Date.UTC(y, mo - 1, d) / 864e5; };
  const addDays = (iso, n) => new Date((dayNum(iso) + n) * 864e5).toISOString().slice(0, 10);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Timeline words for an output mark (ledger-data.js log). note 'reprint' = from History's Reprint.
  const OUTPUT_LABEL = m => ({ print: m.note === 'reprint' ? 'Reprinted' : 'Printed', pdf: 'PDF saved', pdf_open: 'PDF opened', email_draft: 'Email draft made', paylink: 'Pay link added', email_sent: m.note ? 'Emailed to ' + m.note : 'Emailed' }[m.kind] || m.kind);
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
  const SALES_SUBS = [['all', 'All'], ['missing', 'Missing info']];
  const MISSING_FIELDS = [['any', 'Any'], ['name', 'Name'], ['phone', 'Phone'], ['address', 'Address'], ['email', 'Email']];
  // Filters under the search box. Records: when and where from. Customers: who to show and the order.
  const FILTERS = {
    when: [['', 'Any date'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['year', 'This year'], ['lastYear', 'Last year']],
    src: [['', 'All sources'], ['register', 'Register only'], ['qbo', 'QuickBooks only']],
    cShow: [['', 'All customers'], ['owes', 'Owes money'], ['overdue', 'Overdue'], ['year', 'Bought this year']],
    cSort: [['', 'Newest activity'], ['name', 'Name A–Z'], ['balance', 'Most owed']],
  };
  function filterRecords(records, ui, today) {
    const y = today.slice(0, 4), from30 = addDays(today, -30), from90 = addDays(today, -90);
    const when = { '30': r => (r.date || '') >= from30, '90': r => (r.date || '') >= from90, year: r => (r.date || '').startsWith(y), lastYear: r => (r.date || '').startsWith(String(y - 1)) }[ui.when];
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
      if (ui.salesSub === 'missing') { // F02: serial-numbered sales with no buyer or a missing phone, email or address; read-only
        const miss = byNewest(L.missingInfo(records, ui.missField || 'any'));
        return { groups: miss.length ? [group('missing', 'Missing info', miss, { noTotal: true })] : [], empty: 'No sales with a serial number are missing that.' };
      }
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
  function actionsFor(r, canPdf, helcim) { // helcim: { connected, link } for Add pay link (only when History runs in the app with Helcim set up)
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
    if (r.kind === 'invoice' && UNPAID.has(r.state) && cents(r.balance) === cents(r.total) && helcim && helcim.connected && !helcim.link) a.push({ act: 'payLink', label: 'Add pay link' });
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
    if (!isQbo(r)) { // a register sale lists only the store credit it used (D17)
      const from = (records || []).find(x => x.txnId === r.fromQuote && x.kind === 'quote'); // its deposit shows on the sale made from it
      const ids = new Set([r.txnId, from && from.txnId].filter(Boolean)), nums = new Set([r.number, from && from.number].filter(Boolean));
      const mine = L.parsePayments(paymentRows).filter(p => (ids.has(p.txnId) || (!p.txnId && nums.has(p.invoice_number))) && (r.kind !== 'receipt' || p.method === 'credit_used'));
      const seen = new Set();
      for (const p of mine.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) {
        if (seen.has(p.payment_id)) continue;
        seen.add(p.payment_id);
        const dep = r.kind === 'quote' || (from && p.txnId === from.txnId);
        const t = p.method === 'credit_given' ? (p.voids ? 'Move to store credit undone' : `Moved ${money(p.amount)} to store credit`) // credit_given takes money off the sale
          : p.voids ? (dep ? 'Deposit undone' : 'Payment undone') : `${dep ? 'Deposit' : 'Paid'} ${money(p.amount)} by ${(METHOD_LABEL[p.method] || p.method).toLowerCase()}`;
        ev.push({ t, d: p.date, at: PLACES[p.place] || '' });
      }
    }
    if (r.state === 'void' && !isQbo(r)) { const n = (records || []).find(x => (x.number || x.txnId) === r.replacedBy); ev.push({ t: `Corrected, replaced by ${r.replacedBy}`, d: n ? n.date : '', at: n ? placeOf(n.number) : '' }); }
    if (r.state === 'cancelled') ev.push({ t: 'Cancelled', d: r.cancelledAt, at: '' });
    if (r.convertedTo) { const n = (records || []).find(x => (x.number || x.txnId) === r.convertedTo); ev.push({ t: `Turned into sale ${r.convertedTo}`, d: n ? n.date : '', at: n ? placeOf(n.number) : '' }); }
    return ev.sort((a, b) => (a.d || '').localeCompare(b.d || ''));
  }

  // The print request, built from a Ledger record the way POS/index.html saleScreenDocumentRequest() builds it from the sale
  // screen. The sheet keeps the invoice PO (column X) but no brand, so brand prints empty; a line discount comes from item columns O and P.
  // A quote with a deposit carries one note line saying so, on screen, on every print and in the sale made from it (Trevor, Nov 1).
  // Added once: a sale that already has a "Deposit paid" note (saved from an earlier conversion) is left as it is.
  function withDeposit(r) {
    // A register receipt paid partly with store credit: one note line, the same way as a quote deposit (no renderer change).
    if (r && r.kind === 'receipt' && r.creditUsed > 0 && !(r.items || []).some(i => i.pn === 'Note' && /^store credit/i.test(s(i.desc)))) {
      const desc = `Store credit −${money(r.creditUsed)}. Amount paid ${money(Math.max(0, cents(r.total - r.creditUsed)))}.`;
      return { ...r, items: [...(r.items || []), { pn: 'Note', desc, qty: '', ea: 0, sub: 0, serials: [], origEa: 0, off: 0 }] };
    }
    if (!(r && r.kind === 'quote' && r.deposit > 0) || (r.items || []).some(i => i.pn === 'Note' && /^deposit paid/i.test(s(i.desc)))) return r;
    const desc = `Deposit paid ${money(r.deposit)}. Balance due ${money(cents(r.total - r.deposit))}.`;
    return { ...r, items: [...(r.items || []), { pn: 'Note', desc, qty: '', ea: 0, sub: 0, serials: [], origEa: 0, off: 0 }] };
  }
  // The 3% card fee is not stored in the rows: total minus subtotal minus tax, five cents or more (less is rounding). QuickBooks sales have none.
  function cardFeeOf(rec) {
    const r = withDeposit(rec);
    if (isQbo(r)) return 0;
    const subtotal = (r.items || []).filter(i => i.pn !== 'Note').reduce((a, i) => a + i.sub, 0);
    const rest = cents(r.total) - cents(subtotal) - cents(subtotal * TAX_RATE);
    return Math.abs(rest) >= 0.05 ? rest : 0;
  }
  function requestFromRecord(rec) {
    const r = withDeposit(rec);
    const items = r.items.filter(i => i.pn !== 'Note');
    const subtotal = items.reduce((a, i) => a + i.sub, 0);
    const tax = isQbo(r) ? r.tax : subtotal * TAX_RATE; // QuickBooks states its own tax and has no card fee
    const cardFee = cardFeeOf(r);
    const completion = new Date(r.date ? `${r.date}T12:00:00-10:00` : Date.now());
    const billing = r.street || r.city
      ? { billing_address: { lines: r.addrLines || (r.street ? [r.street] : []), city: r.city, region: regionOf(r), postal_code: r.zip, country: '' } }
      : { address: r.addr || '' };
    return {
      po: r.kind === 'invoice' ? s(r.po) : '', type: r.kind, number: r.number || r.txnId, completionAt: completion.toISOString(),
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

  // Add pay link: Helcim makes the invoice, then ONE 'paylink' mark (note = url|helcimInvoiceId) goes on the Payments tab so every
  // computer shows the link. Resolves { ok, url } or { ok: false, message }; nothing is written on a Helcim error.
  async function addPayLink(h, r) {
    let out;
    try { out = await h.helcim.payLink({ txnId: r.txnId, number: r.number, total: Number(r.total), name: s(r.name).slice(0, 120), company: s(r.company).slice(0, 120) }); } // main rejects bad input (thrown): caught below
    catch (_) { out = null; }
    if (!out || !out.ok || !s(out.url)) return { ok: false, message: s(out && out.message) || 'Helcim did not answer. Try again.' };
    await h.appendPaymentRows([L.buildMarkRow({ kind: 'paylink', txnId: r.txnId, invoice_number: r.number, note: `${out.url}|${out.helcimInvoiceId}`, place: h.place || '' })]);
    return { ok: true, url: out.url };
  }
  // Ask Helcim about the open invoices that have a link, once; record what it reports. Called only on opening the Invoices list
  // (throttled: state.at, one check per HELCIM_RECHECK_MS per register) and on the Check Helcim button (force). No timer anywhere.
  // Returns { skipped } or { looks: {txnId: sentence}, added: rows written }; a number or amount that does not fit is a "look", never written.
  const STALE_LOOK = 'Helcim payment needs a look';
  // stale(record): the link is out of date (L.payLinkStale). Helcim is still asked, but nothing is written for it: anything it reports is a look.
  async function helcimPickup(h, records, payRows, paylinks, state, now, force, stale = () => false) {
    if (!h || !h.helcim) return { skipped: true, looks: {}, added: 0 };
    if (!force && state.at && now - state.at < HELCIM_RECHECK_MS) return { skipped: true, looks: {}, added: 0 };
    const open = records.filter(r => r.kind === 'invoice' && UNPAID.has(r.state) && !isQbo(r) && (paylinks[r.txnId] || paylinks[r.number]));
    if (!open.length) return { looks: {}, added: 0 };
    const idOf = r => (paylinks[r.txnId] || paylinks[r.number]).helcimInvoiceId;
    state.at = now;
    let res;
    try { res = await h.helcim.status([...new Set(open.map(idOf))]); } catch (_) { res = null; }
    if (!res || !res.ok) { state.at = 0; return { looks: {}, added: 0, error: s(res && res.message) || 'Helcim did not answer.' }; }
    // Fresh copy of the sheet right before deciding: another register may have recorded part of this already, and the amount
    // and the balance must come from what is on the Payments tab now, not from the last load.
    // ponytail: two registers checking in the same sub-second can still both write; add a re-read after append if it ever happens.
    let fresh;
    try {
      const freshRows = await h.readPayments();
      const fm = await L.create({ txnRows: await h.readTransactions(), paymentRows: freshRows, today: h.honoluluToday ? h.honoluluToday() : undefined });
      fresh = { rows: freshRows, byId: new Map(fm.records.map(x => [x.txnId, x])) };
    } catch (_) { state.at = 0; return { looks: {}, added: 0, error: 'Could not read the Payments tab.' }; }
    const rows = [], looks = {};
    for (const old of open) {
      const r = fresh.byId.get(old.txnId);
      if (!r || !UNPAID.has(r.state)) continue; // paid or cancelled meanwhile
      const id = idOf(old), got = (res.results || {})[id];
      const out = L.helcimPaymentRows(r, got && got.ok ? { ...got, helcimInvoiceId: id } : got || { ok: false }, fresh.rows, h.place || '', now);
      if (stale(r)) { looks[r.txnId] = out.rows.length || out.needsLook ? STALE_LOOK : ''; continue; }
      rows.push(...out.rows);
      looks[r.txnId] = out.needsLook;
    }
    if (rows.length) { try { await h.appendPaymentRows(rows); } catch (e) { state.at = 0; throw e; } }
    return { looks, added: rows.length };
  }

  // UI memory: in memory for tab switches, sessionStorage for a reload. Storage may be missing or throw.
  const DEFAULT_UI = Object.freeze({ section: 'recent', invSub: 'unpaid', quoteSub: 'open', salesSub: 'all', missField: 'any', when: '', src: '', cShow: '', cSort: '', q: '', sel: '', scroll: 0, closed: [] });
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

  // ---- Customer fields typed on a saved document (F01) ----
  const CUST_KEYS = ['company', 'name', 'phone', 'email', 'street', 'city', 'region', 'zip'];
  const isPlaceholderBuyer = r => s(r.name).toLowerCase() === 'jana yamashiro' && !s(r.company) && !s(r.phone); // the register's stand-in: nobody's customer (D10)
  const savedField = (r, key) => (isPlaceholderBuyer(r) && key === 'name' ? '' : s(key === 'region' ? regionOf(r) : r[key]));
  // Only the fields whose typed value differs from the saved one (case aside). A field cleared on purpose is ''.
  function customerPatch(r, typed) {
    const patch = {};
    for (const key of CUST_KEYS) if (key in typed && s(typed[key]).toUpperCase() !== savedField(r, key).toUpperCase()) patch[key] = s(typed[key]);
    return patch;
  }
  // D3 (Trevor): filling only blanks is a fill (the "also update this customer's info" box starts ticked); changing a filled value is an
  // overwrite (starts unticked). The placeholder buyer counts as blank (D10).
  function customerChange(r, typed) {
    const patch = customerPatch(r, typed);
    const keys = Object.keys(patch);
    if (!keys.length) return 'none';
    return keys.some(key => savedField(r, key)) ? 'overwrite' : 'fill';
  }
  // The toast for an edit's one result. A failure is a plain sentence that says whether anything was saved.
  function editOutcomeText(r, res) {
    if (!res || typeof res !== 'object') return 'The edit closed before it finished. Check History before trying again.';
    if (!res.ok) return s(res.message) || 'That did not go through. Nothing changed. Try again.';
    if (res.cancelled) return 'Edit cancelled. Nothing was changed.';
    if (res.unchanged) return 'Nothing was changed.';
    const num = s(res.number) && res.number !== r.number ? ` Number changed to ${res.number}.` : '';
    if (res.pending) return `Saved on this computer. It will go to the sheet when this register is back online.${num}`;
    const pdf = res.pdf === 'website' ? ' The PDF copy updates when it is next printed at a counter PC.'
      : res.pdf === 'queued' ? ' The PDF copy is waiting to upload.' : res.pdf === 'unavailable' ? ' The PDF copy could not be refreshed yet.' : '';
    return `Saved. ${r.number} is updated.${num}${pdf}`;
  }
  // The row to select when the selected one left a list: the next one down that is still there, else the one above, else ''.
  function nextSelection(was, sel, now) {
    const i = was.indexOf(sel), alive = id => now.includes(id);
    return i < 0 ? '' : was.slice(i + 1).find(alive) || was.slice(0, i).reverse().find(alive) || '';
  }
  // A11: before an email goes out, re-read the sheet and compare this document's rows with the ones the email window opened with. Throws a plain
  // sentence when they differ or the read fails: never send unchecked. QuickBooks records have no sheet rows and are not checked.
  async function documentUnchanged(h, r) {
    if (isQbo(r)) return;
    let rows;
    try { rows = await h.readTransactions(); } catch (_) { throw new Error('Could not check that this document is still current. Try again.'); }
    const at = (rows || []).findIndex(row => String(row[0]).toLowerCase() === 'txn' && String(row[1]) === r.txnId);
    if (at < 0 || L.transactionRowsFingerprint(rows.slice(at, L.transactionBlockEnd(rows, at, r.txnId))) !== r.fingerprint) throw new Error('This document changed. Close and open Email again.');
  }
  // The customer form in the panel during an edit (D14). Its state lives in st.edit.cust so a redraw never loses what was typed; the HTML is rebuilt from it.
  const CUST_LABELS = { company: 'Company', name: 'Contact', phone: 'Phone', email: 'Email', street: 'Street', city: 'City', region: 'State', zip: 'Zip' };
  const CUST_IDS = { company: 'dcCompany', name: 'dcName', phone: 'dcPhone', email: 'dcEmail', street: 'dcStreet', city: 'dcCity', region: 'dcState', zip: 'dcZip' };
  const custEditStart = (r, typed, err) => ({ txnId: r.txnId, typed: Object.fromEntries(CUST_KEYS.map(k => [k, typed ? s(typed[k]) : savedField(r, k)])), touched: false, box: false, err: err || '', saving: false });
  // What the form shows: the "also update" box starts ticked for a fill, unticked for an overwrite, until the person touches it (D3).
  function custEditModel(r, e) {
    const change = customerChange(r, e.typed);
    return { change, ticked: e.touched ? e.box : change === 'fill',
      hint: change === 'overwrite' ? 'You changed a saved detail, so the saved customer stays as it was unless you tick this.' : change === 'fill' ? 'You filled in blanks, so the customer gets them too.' : '' };
  }
  // The customer editor in the right panel during an edit (D14). It has no buttons of its own: the bar's one Save writes it with the items.
  function custEditHtml(r, e, off) {
    const m = custEditModel(r, e), d = off ? ' disabled' : '';
    const f = k => `<label>${CUST_LABELS[k]}<input id="${CUST_IDS[k]}" data-cf="${k}" value="${esc(e.typed[k])}" autocomplete="off"${d}></label>`;
    return `<div class="cedit"><h3>Customer on this document</h3>${['company', 'name', 'phone', 'email', 'street'].map(f).join('')}<div class="row2">${['city', 'region', 'zip'].map(f).join('')}</div>
      <label class="chk"><input type="checkbox" id="dcUpdate"${m.ticked ? ' checked' : ''}${d}> Also update this customer's info</label>
      <div class="hint" id="dcHint">${esc(m.hint)}</div><div class="err" id="dcErr" role="alert">${esc(e.err)}</div></div>`;
  }
  // ---- Item edit in the middle column (F03) ----
  const LOCK = 'Finish or cancel the edit first';
  // One embedded edit session, History's side (D14). h.editEmbed starts it; state from the register is kept only when it is v:1, this
  // session and a higher seq (an older or foreign one is dropped). The customer is typed in History's panel (f.cust, the inline
  // editor's state) and goes to the register with the one save; rect / save / cancel go back through the host. Nothing here writes
  // the sheet: the register's one save path does. opts: { cardFee, confirm(text) -> bool, changed(f), ended(result, f) }.
  // Without one.saveCustomer (app 0.3.66) Save sends the items only and f.followUp carries the customer for the silent session.
  function editFlow(h, r, opts = {}) {
    const f = { txnId: r.txnId, record: r, state: null, seq: -Infinity, rectSeq: 0, done: false, deferred: false, everReady: false, cust: custEditStart(r), followUp: null };
    const one = h.editEmbed(r, { cardFee: !!opts.cardFee, storeCredit: opts.storeCredit || 0 }, { onState: m => f.accept(m), onClose: () => f.cancel() });
    f.sessionId = one.sessionId;
    f.accept = m => {
      if (f.done || !m || typeof m !== 'object' || m.v !== 1 || m.sessionId !== f.sessionId || !(Number(m.seq) > f.seq)) return false;
      f.seq = Number(m.seq); f.state = m; f.asked = false; // a newer state answers the last Save (saving, or refused with a problem)
      if (m.ready) f.everReady = true;
      if (opts.changed) opts.changed(f);
      return true;
    };
    // The panel's "Also update this customer's info" box (D3). The Jana stand-in is already a blank buyer in f.cust (savedField, D10).
    f.boxModel = () => custEditModel(r, f.cust);
    f.custChanged = () => customerChange(r, f.cust.typed) !== 'none';
    f.changed = () => !!(f.state && f.state.dirty) || f.custChanged();
    f.canSave = () => { const st = f.state; return !!(st && st.ready && st.canSave && !st.saving && !f.asked && !f.done && f.changed()); };
    f.scan = one.scan; // website only: a scan typed in History's panel goes to the sale lines
    const msg = extra => ({ v: 1, sessionId: f.sessionId, ...extra });
    f.rect = b => one.rect(b ? msg({ seq: ++f.rectSeq, rect: { x: b.x, y: b.y, width: b.width, height: b.height } }) : msg({ seq: ++f.rectSeq, hidden: true }));
    f.save = () => {
      if (!f.canSave()) return false;
      f.asked = true;
      const b = f.boxModel(), patch = customerPatch(r, f.cust.typed), updateInfo = b.change !== 'none' && b.ticked;
      if (one.saveCustomer) { one.command(msg({ cmd: 'save', updateInfo, customer: patch })); return true; }
      f.followUp = Object.keys(patch).length ? { typed: { ...f.cust.typed }, updateInfo } : null;
      if (f.state.dirty) one.command(msg({ cmd: 'save', updateInfo: false }));
      else { f.viaCancel = true; one.command(msg({ cmd: 'cancel' })); } // customer only: close the screen, the silent session saves it
      return true;
    };
    // Cancel (and Cmd/Ctrl+W in the app): asks first when the items or the customer changed. The register answers with { cancelled: true }.
    f.cancel = () => {
      if (f.done || (f.state && f.state.saving)) return false;
      if (f.changed() && !(opts.confirm && opts.confirm('Throw away these changes?'))) return false;
      f.followUp = null; f.viaCancel = false;
      one.command(msg({ cmd: 'cancel' }));
      return true;
    };
    f.defer = () => { if (f.done) return false; f.deferred = true; return true; }; // an automatic reload waits for the end
    f.result = one.result.then(res => { f.done = true; if (opts.ended) opts.ended(res, f); return res; });
    return f;
  }
  // R10: the sale screen could not prove the saved rows before it opened (open_sale_screen, never ready): edit in a new sale tab instead.
  const embedFallsBack = (res, f) => !!(res && !res.ok && res.code === 'open_sale_screen' && !(f && f.everReady));
  // App 0.3.66 only: the items are saved; now the customer goes through the silent session, on the freshly loaded record.
  // Returns the customer's result, or null when it must not run (the items were kept on this computer only, or nothing to save).
  const followUpRuns = (f, res) => !!(f && f.followUp && res && res.ok && !res.pending && (!res.cancelled || f.viaCancel));
  function followUpText(r, first, out) {
    if (out && out.ok) return first ? `${first} Customer details saved.` : editOutcomeText(r, out);
    const why = s(out && out.message) || 'It did not go through.';
    return `${first ? first + ' ' : ''}The customer details were not saved: ${why} Open Edit again to add them.`;
  }
  // The Now editing bar above the sale lines: number and customer, original -> new total, the money line (C3, text from
  // L.editMoney with the customer typed in the panel), warnings (R5, R6), Save and Cancel. payLink: the invoice has a pay link.
  // credit: store credit is on (host.creditReady()); off, an overpayment reads "Refund due $X" as before (no automatic credit).
  function editBarHtml(f, { payLink, credit } = {}) {
    const r = f.record, st = f.state, num = esc(r.number || r.txnId);
    const buyer = isPlaceholderBuyer(r) ? '' : s(r.company || r.name);
    const title = `<b class="etitle">Now editing ${num}${buyer ? ` · ${esc(buyer)}` : ''}</b>`;
    const btns = (save, cancel, label) => `<div class="ebtns"><button type="button" class="btn quiet" data-act="editCancel"${cancel ? '' : ' disabled'}>Cancel</button><button type="button" class="btn primary" data-act="editSave"${save ? '' : ' disabled'}>${label}</button></div>`;
    if (!st || !st.ready) return `<div class="ebar">${title}<span class="etot muted">Opening the sale screen…</span>${btns(false, true, 'Save')}</div>`;
    const was = Number.isSafeInteger(st.originalTotalCents) ? st.originalTotalCents : Math.round(Number(r.total) * 100);
    const now = Number.isSafeInteger(st.totalCents) ? st.totalCents : null;
    let line = now == null ? null : L.editMoney(r, now, was, f.cust ? f.cust.typed : undefined);
    if (line && line.kind === 'credit' && !credit) line = { kind: 'refund', cents: line.cents, text: 'Refund due ' + money(line.cents / 100) };
    const tone = !line ? '' : line.kind === 'refund' || line.kind === 'depositExceeds' ? ' late' : line.kind === 'credit' ? (line.needsCustomer ? ' soon' : ' credit') : '';
    const warn = [];
    if (payLink) warn.push('This invoice has a pay link. If the total changes, it needs a new link after you save.');
    if (r.kind === 'quote' && r.convertedTo) warn.push(`Already turned into sale ${r.convertedTo}. That sale is not changed.`);
    const why = st.problem ? `<span class="eprob" role="alert">${esc(st.problem)}</span>` : !f.changed() ? '<span class="ehint">Change the lines or the customer, then Save.</span>' : '';
    return `<div class="ebar">${title}`
      + `<span class="etot num">${money(was / 100)}${now == null ? '' : ` → ${money(now / 100)}`}</span>`
      + (line && line.text ? `<span class="emoney${tone}">${esc(line.text)}</span>` : '')
      + why + btns(f.canSave(), !st.saving, st.saving ? 'Saving…' : 'Save')
      + warn.map(w => `<div class="ewarn">${esc(w)}</div>`).join('')
      + '</div>';
  }
  // The right panel's buttons. locked (an edit is open): every one disabled, with the reason once above them.
  function railActsHtml(acts, busy, locked) {
    const btn = a => `<button class="btn${a.primary ? ' primary' : ''}${a.quiet ? ' quiet' : ''}" data-act="${a.act}"${a.disabled || busy || locked ? ' disabled' : ''}${a.why ? ` title="${esc(a.why)}"` : ''}>${ICON[a.act] || ''}<span>${busy === a.act ? 'Saving…' : esc(a.label)}</span>${a.menu ? ICON.down : ''}</button>${a.disabled && a.why ? `<span class="why">${esc(a.why)}</span>` : ''}`;
    return (locked ? `<span class="why">${LOCK}</span>` : '') + acts.map(btn).join('');
  }
  // ---- Store credit (Part C, D17, D18). Balances come from the Payments tab every time (L.creditBalances); nothing stores one.
  // The words for a customer's balance in cents: '' (none), "Credit $40.00", or "Credit overdrawn −$5.00" (never hidden).
  const creditText = c => (c > 0 ? `Credit ${money(c / 100)}` : c < 0 ? `Credit overdrawn −${money(-c / 100)}` : '');
  const creditPill = c => (c ? `<span class="pill ${c < 0 ? 'late' : 'credit'}">${esc(creditText(c))}</span>` : '');
  // Give credit: one credit_given row with no sale on it. key: the picked customer (L.creditKey); reason is required.
  function giveCreditRows(key, amountText, reason, today, place, now) {
    if (!s(key)) return { error: 'Pick a customer first.' };
    const c = checkAmount(amountText, Infinity);
    if (c.error) return c;
    if (!s(reason)) return { error: 'Type a short reason, for example "Returned part".' };
    return { rows: [L.buildPaymentRow({ invoice_number: '', txnId: '', date: today, amount: c.amount, method: 'credit_given', note: s(reason).slice(0, 200), place: place || '', customer: key }, now)] };
  }
  // Take payment by store credit on an invoice. Reads the Payments tab (and the sale) fresh and caps with L.creditCap: when the cap is
  // now lower than asked, nothing is written and the sentence says how much is left. Returns { ok, cents } or { ok: false, cap, message }.
  async function takeCredit(h, r, amountCents, key, ctx, now) {
    const freshRows = await h.readPayments();
    const fm = await L.create({ txnRows: await h.readTransactions(), paymentRows: freshRows, today: h.honoluluToday ? h.honoluluToday() : undefined });
    const fresh = fm.records.find(x => x.txnId === r.txnId);
    if (!fresh || !UNPAID.has(fresh.state)) return { ok: false, cap: 0, message: `${r.number} is not owing any more. Nothing was taken.` };
    const cap = L.creditCap(freshRows, key, Math.round(fresh.balance * 100), fm.records, ctx);
    if (!(amountCents > 0) || amountCents > cap) return { ok: false, cap, message: cap > 0 ? `Only ${money(cap / 100)} of store credit can be used now. Nothing was taken. Try again with that amount.` : 'This customer has no store credit left. Nothing was taken.' };
    await h.appendPaymentRows([L.creditUseRow({ txnId: fresh.txnId, number: fresh.number, kind: fresh.kind }, amountCents, key, now, h.place || '')]);
    return { ok: true, cents: amountCents };
  }
  // D18: a sale that shows Refund due and has a customer moves the extra to store credit by itself. Runs on every History load, so a
  // credit row that failed after a save, or a customer added later, is picked up; the fixed ids (credit_<txnId>) make two Histories safe.
  // Only a sale whose newest 'edit' mark (payRows: the Payments tab) is on or after `from` moves: an older Refund due may already be
  // refunded in cash, so it keeps showing "Refund due $X".
  async function moveCredits(h, records, ctx, now, payRows, from = CREDIT_FROM) {
    const log = L.parseMarks(payRows || []).editLog, cut = Date.parse(from);
    const edited = m => Math.max(-Infinity, ...((log[m.record.txnId] || []).map(e => Date.parse(e.at)).filter(Number.isFinite))) >= cut;
    const rows = L.pendingCreditMoves(records, ctx).filter(edited).map(m => L.autoCreditRow(m.record, m.cents, m.key, now, h.place || '')).filter(Boolean);
    if (rows.length) await h.appendPaymentRows(rows);
    return rows.length;
  }
  // The customer's newest live Give credit row (no sale on it), for its Undo; null when there is none.
  function lastGiven(payRows, key, ctx) {
    const live = L.livePayments(L.parsePayments(payRows));
    return live.filter(p => p.method === 'credit_given' && !p.txnId && L.resolveCredit(p.customer, ctx) === key).sort((a, b) => lt(b.recorded_at, a.recorded_at))[0] || null;
  }
  const pure = { LOCK, STALE_LOOK, CREDIT_FROM, creditText, creditPill, giveCreditRows, takeCredit, moveCredits, lastGiven, editFlow, embedFallsBack, followUpRuns, followUpText, editBarHtml, railActsHtml, SALES_SUBS, MISSING_FIELDS, documentUnchanged, nextSelection, custEditStart, custEditModel, custEditHtml, CUST_KEYS, customerPatch, customerChange, editOutcomeText, qboAsOf, qboBar, runQboRefresh, qboLoader, qboNote, byNewest, TAX_RATE, SECTIONS, INVOICE_SUBS, QUOTE_SUBS, METHOD_LABEL, decorate, statusOf, buildView, subCounts, actionsFor, FILTERS, checkAmount, filterRecords,
    buildCustomerView, customerSource, customerBalance, newInvoiceTxn, historyFor, requestFromRecord, factsFromRequest, documentPages, paymentRowsFor, addPayLink, helcimPickup, HELCIM_RECHECK_MS, loadUi, saveUi, placeOf, money, fmtD };

  // ------------------------------------------------------------------ page
  function boot() {
    const doc = root.document;
    const $ = id => doc.getElementById(id);
    const store = (() => { try { return root.sessionStorage; } catch (_) { return null; } })();
    const ui = store ? loadUi(store) : { ...DEFAULT_UI, closed: [] };
    const st = { phase: 'loading', model: null, records: [], payRows: [], custRows: [], qboCustomers: [], cust: null, custRev: 0, recLimit: 100, backTo: '', marks: { drafts: {}, edits: {} }, local: { drafts: {} },
      today: '', busy: '', edit: null, template: null, docKey: '', pages: null, docErr: '',
      qbo: null, qboVersion: '', qboAt: 0, qboBusy: false, qboWarned: false, qboAgain: false, helcimOk: false, helcimP: null, helcimAt: { at: 0 }, helcimBusy: false, helcimWhen: 0, looks: {}, linkErr: {}, qboRun: null, qboTried: false, qboGenerated: '', refreshing: false, refreshFailed: false, rev: 0, limit: PAGE, view: null };
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
    // Store credit: ctx is the { qbo, sheetRows } object buildCustomers groups by (kept while those two stay the same); credits() is
    // { creditKey: cents } from the Payments tab, or null when this app cannot read column K (creditReady false: no credit anywhere).
    function ctx() {
      if (!st.ctx || st.ctx.qbo !== st.qboCustomers || st.ctx.sheetRows !== st.custRows) st.ctx = { qbo: st.qboCustomers, sheetRows: st.custRows };
      return st.ctx;
    }
    function credits() {
      const h = host();
      if (!(h && h.creditReady && h.creditReady())) return null;
      const c = ctx();
      if (!st.bal || st.bal.p !== st.payRows || st.bal.r !== st.records || st.bal.c !== c) st.bal = { p: st.payRows, r: st.records, c, map: L.creditBalances(st.payRows, st.records, c) };
      return st.bal.map;
    }
    const creditOf = key => { const b = credits(); return b && key ? b[key] || 0 : 0; };

    async function load(noMove) {
      const h = host();
      if (!h) { st.phase = 'nohost'; return draw(); }
      if (!st.model) { st.phase = 'loading'; draw(); }
      let fresh = false;
      try {
        const [tx, pay, mk, cu] = await Promise.all([h.readTransactions(), h.readPayments(), h.readMarks ? h.readMarks() : null,
          h.readCustomers ? h.readCustomers().catch(() => st.custRows) : st.custRows]); // customer rows are extra: a failure keeps the last ones
        st.custRows = cu || []; st.custRev++;
        st.today = (h.honoluluToday && h.honoluluToday()) || L.honoluluToday();
        st.payRows = pay || [];
        st.marks = { drafts: { ...((mk && mk.drafts) || {}), ...st.local.drafts }, edits: { ...((mk && mk.edits) || {}) }, before: (mk && mk.before) || {}, log: (mk && mk.log) || {}, sent: (mk && mk.sent) || {}, paylinks: (mk && mk.paylinks) || {}, editLog: (mk && mk.editLog) || {} };
        st.model = await L.create({ txnRows: tx || [], paymentRows: st.payRows, drafts: st.marks.drafts, today: st.today });
        if (st.qbo) st.model.addQbo(st.qbo, st.today); // QuickBooks copy already downloaded: merge before the first draw
        setRecords(st.model.records);
        st.phase = 'ready'; fresh = true;
      } catch (e) {
        st.phase = e && e.code === 'not_signed_in' ? 'signedout' : (st.model ? 'ready' : 'error');
        if (st.model) toast('Could not refresh. Showing what was loaded before.');
      }
      // D18: overpaid sales with a customer move to store credit now (also the retry after a failed credit row). Once per load.
      if (!noMove && fresh && credits()) { // never on the rows of an earlier load (this one failed)
        let moved = 0;
        try { moved = await moveCredits(h, st.records, ctx(), Date.now(), st.payRows); } catch (_) { /* the sale keeps "Refund due $X"; the next load tries again */ }
        if (moved) return load(true);
      }
      draw();
      loadQbo();
      if (st.phase === 'ready') { helcimReady(); helcimCheck(false); }
    }
    function setRecords(list) { st.records = decorate(list); st.rev++; st.view = null; }

    // QuickBooks history arrives after the sheet is on screen. Failure leaves the sheet as it was.
    const loadQbo = qboLoader(st, host, {
      apply: data => { st.qbo = L.qboRecords(data); setRecords(st.model.addQbo(st.qbo, st.today)); },
      loading: on => { $('qbNote').hidden = !on; if (on) $('qbNote').textContent = 'Loading QuickBooks history…'; },
      failed: () => toast('QuickBooks history could not load. Showing the sales sheet only.'),
      done: () => { if (st.phase === 'ready') draw(); },
    });

    // Helcim (app only): ask once on load whether the app has a Helcim token; History shows no Helcim buttons otherwise.
    const rawLink = r => { const p = (st.marks.paylinks || {})[r.txnId] || (st.marks.paylinks || {})[r.number]; return p ? p.url : ''; };
    const staleLink = r => !!rawLink(r) && L.payLinkStale(r, st.marks);
    const linkFor = r => (staleLink(r) ? '' : rawLink(r)); // a stale link (R5) is never emailed; Add pay link offers a new one
    const helcimState = r => ({ connected: st.helcimOk, link: linkFor(r) });
    function helcimReady() {
      const h = host();
      if (!h || !h.helcim) { st.helcimOk = false; st.helcimP = null; st.helcimHost = null; return Promise.resolve(false); }
      if (st.helcimHost !== h) { st.helcimHost = h; st.helcimP = null; st.helcimOk = false; } // a different host (fixture) asks again
      if (!st.helcimP) st.helcimP = Promise.resolve().then(() => h.helcim.ready()).then(x => !!(x && x.connected), () => false).then(ok => { st.helcimOk = ok; if (ok && st.phase === 'ready') draw(); return ok; });
      return st.helcimP;
    }
    // On opening the Invoices list (force = false, at most once per 10 minutes) and on Check Helcim (force): record what Helcim reports.
    async function helcimCheck(force) {
      if (ui.section !== 'invoices' || st.helcimBusy || !(await helcimReady())) return;
      st.helcimBusy = true; drawHelcimBar();
      try {
        const out = await helcimPickup(host(), st.records, st.payRows, st.marks.paylinks || {}, st.helcimAt, Date.now(), force, staleLink);
        if (!out.skipped) {
          st.helcimWhen = Date.now();
          Object.assign(st.looks, out.looks);
          if (out.error) toast('Helcim could not be checked. ' + out.error);
          else if (out.added) { st.helcimBusy = false; await load(); toast(`Helcim payment recorded on ${out.added} invoice${out.added === 1 ? '' : 's'}.`); }
          else if (force) toast('Helcim checked. Nothing new.');
        }
      } catch (_) { toast('Helcim could not be checked. Nothing was recorded.'); }
      st.helcimBusy = false; draw();
    }
    function drawHelcimBar() {
      const el = $('hcBar');
      el.hidden = !(st.helcimOk && ui.section === 'invoices');
      if (el.hidden) return;
      const min = st.helcimWhen ? Math.floor((Date.now() - st.helcimWhen) / 60000) : -1;
      el.innerHTML = `<button class="btn quiet" data-act="hcCheck"${st.helcimBusy ? ' disabled' : ''}>${st.helcimBusy ? 'Checking Helcim…' : 'Check Helcim'}</button>`
        + (min >= 0 && !st.helcimBusy ? `<span>${min < 1 ? 'Checked just now' : `Checked ${min} min ago`}</span>` : '');
    }
    async function copyLink(url) {
      try { await root.navigator.clipboard.writeText(url); }
      catch (_) {
        const ta = doc.createElement('textarea'); ta.value = url; ta.style.cssText = 'position:fixed;left:-10000px'; doc.body.append(ta); ta.select();
        try { doc.execCommand('copy'); } finally { ta.remove(); }
      }
      toast('Pay link copied.');
    }
    function addLink(r) {
      run('payLink', async () => {
        delete st.linkErr[r.txnId];
        const out = await addPayLink(host(), r);
        if (!out.ok) { st.linkErr[r.txnId] = out.message; return ''; }
        return 'Pay link added. It goes in the email message.';
      });
    }

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
      drawQbo(); drawHelcimBar();
      const sum = st.model.owedSummary();
      // Footer, the same on every section, so nothing above the list moves.
      $('owed').innerHTML = `Owed <span class="num">${money(sum.total)}</span> · <span class="${sum.overdue ? 'late' : ''}">${sum.overdue} overdue</span>`;
      const counts = ui.section === 'invoices' || ui.section === 'quotes' ? subCounts(st.records) : ui.section === 'sales' ? { missing: L.missingInfo(st.records, 'any').length } : {};
      $('sections').innerHTML = SECTIONS.map(([k, label]) => `<button data-section="${k}" aria-pressed="${ui.section === k}">${label}</button>`).join('');
      const subs = ui.section === 'invoices' ? [['invSub', INVOICE_SUBS]] : ui.section === 'quotes' ? [['quoteSub', QUOTE_SUBS]]
        : ui.section === 'sales' ? [['salesSub', SALES_SUBS]].concat(ui.salesSub === 'missing' ? [['missField', MISSING_FIELDS]] : []) : [];
      // One row of drop-downs under the search box on every section: what to show (Invoices, Quotes, Sales), date and source, or the
      // customer filter and sort. Fixed height, never wraps.
      const subSel = subs.map(([key, list], n) => `<select data-filter="${key}" aria-label="${key === 'missField' ? 'Missing' : 'Show'}" class="${(ui[key] || list[0][0]) !== list[0][0] ? 'on' : ''}">${list.map(([k, label]) =>
        `<option value="${k}"${(ui[key] || list[0][0]) === k ? ' selected' : ''}>${esc(label)}${counts[k] != null && ['unpaid', 'dueSoon', 'overdue', 'open', 'missing'].includes(k) ? ` (${counts[k]})` : ''}</option>`).join('')}</select>`).join('');
      const inCust = ui.section === 'customers';
      $('q').placeholder = SEARCH_HINT[ui.section] || SEARCH_HINT.recent;
      $('q').title = inCust ? 'Name, company, phone or email' : 'Name, company, phone, part #, serial #, invoice or quote number';
      $('q').setAttribute('aria-label', $('q').placeholder);
      const fkeys = inCust ? ['cShow', 'cSort'] : ['when', 'src'];
      $('filters').innerHTML = subSel + fkeys.map(k => `<select data-filter="${k}" aria-label="${k === 'cSort' ? 'Sort' : 'Filter'}" class="${ui[k] ? 'on' : ''}">${FILTERS[k].map(([v, label]) => `<option value="${v}"${ui[k] === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`).join('');
      const view = currentView();
      const rows = view.rows;
      // In Missing info a filled-in sale leaves the list: the selection moves to the next row down, else the one above, else nothing.
      const missing = ui.section === 'sales' && ui.salesSub === 'missing', was = missing && st.missRows && st.missRows.includes(ui.sel) ? st.missRows.indexOf(ui.sel) : -1;
      if (was >= 0 && !rows.some(r => r.txnId === ui.sel)) ui.sel = nextSelection(st.missRows, ui.sel, rows.map(r => r.txnId)) || (rows[0] ? rows[0].txnId : '');
      st.missRows = missing ? rows.map(r => r.txnId) : null;
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
      // D15: while an edit is open the left list collapses to a thin edge and takes no input; the panel holds the customer editor.
      const editing = !!st.edit;
      $('main').classList.toggle('editing', editing);
      doc.querySelector('.left').inert = editing;
      drawEdit(); // after the collapse or the expand: the slot moved, so the rect goes again
      remember();
    }

    // buildView is pure: rebuilt only when the records or the section / sub-tab / search change, not on every selection.
    function currentView() {
      const inCust = ui.section === 'customers';
      const key = [st.rev, inCust ? st.custRev : '', ui.section, ui.invSub, ui.quoteSub, ui.salesSub, ui.missField, ui.when, ui.src, ui.cShow, ui.cSort, s(ui.q)].join('\u0001');
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
      const cr = creditOf(c.id); // a buildCustomers id is the customer's credit key
      return `<button class="row" role="option" data-id="${esc(c.id)}" aria-selected="${c.id === ui.sel}">
        <span class="nm">${esc(c.company || c.name)}</span><span class="amt num ${c.overdue ? 'late' : ''}">${c.balance > 0 ? money(c.balance) : ''}</span>
        <span class="sub num">${cr ? `<b class="cr${cr < 0 ? ' late' : ''}">${esc(creditText(cr))}</b>${sub ? ' · ' : ''}` : ''}${esc(sub)}</span><span class="when muted">${esc(last + n)}${c.inactive ? ' · Inactive' : ''}</span></button>`;
    }

    // Customer view: contact block and the 2026 balance in the middle, then every record newest first; actions on the right.
    function drawCustomer(c) {
      st.docKey = ''; // a document still being drawn must not land here
      $('note').innerHTML = '';
      if (!c) { $('paper').innerHTML = '<div class="empty">Pick a customer on the left.</div>'; $('rail').innerHTML = ''; return; }
      const bal = customerBalance(c), cr = creditOf(c.id), on = !!credits(), given = on ? lastGiven(st.payRows, c.id, ctx()) : null;
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
        <div class="cbal"><span class="pill ${bal.tone}">${esc(bal.text)}</span>${creditPill(cr)}<span class="muted">Counts invoices from 2026 on. Older open invoices are not added in.</span></div>
        <h3>${all.length ? `Records (${all.length})` : 'Records'}</h3>
        ${all.length ? `<div class="crecs">${recs}</div>` : '<div class="empty">No sales or quotes on file for this customer.</div>'}
        ${all.length > shown.length ? `<button class="btn more" data-act="cMore">Show all ${all.length}</button>` : ''}</div>`;
      $('rail').innerHTML = `
        <div><h3>Customer</h3><div class="big">${esc(c.company || c.name)}</div><div class="state"><span class="pill ${bal.tone}">${esc(bal.text)}</span>${creditPill(cr)}</div></div>
        <div class="acts"><button class="btn primary" data-act="cNew">${ICON.newInvoice}<span>New invoice for this customer</span></button>
          <button class="btn" data-act="cEdit">${ICON.edit}<span>Edit</span></button>
          ${on ? `<button class="btn" data-act="giveCredit">${ICON.giveCredit}<span>Give credit</span></button>` : ''}
          ${given ? `<button class="btn quiet" data-act="undoCredit" data-id="${esc(given.payment_id)}">${ICON.undoPay}<span>Undo credit given ${esc(money(given.amount))} · ${esc(given.note)}</span></button>` : ''}</div>
        <div><h3>Where this came from</h3><div class="muted">${esc(customerSource(c))}</div></div>`;
    }

    function drawRecord(r) {
      if (st.edit) return drawEditRail();
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
      if (!st.edit) drawDocument(old || r);
      const draft = st.marks.drafts[r.txnId] || st.marks.drafts[r.number];
      const sent = (st.marks.sent || {})[r.txnId] || (st.marks.sent || {})[r.number];
      const stale = (r.kind === 'invoice' || r.kind === 'quote') && !isQbo(r) ? L.emailedChangedSince(r, st.marks) : '';
      const acts = actionsFor(r, !!(host() && host().openPdf), helcimState(r)).filter(a => a.act !== 'retype' || typeChoices(r).length);
      const qn = qboNote(r);
      const addr = [r.street, [r.city, regionOf(r), r.zip].filter(Boolean).join(' ')].filter(Boolean);
      const hist = historyFor(r, st.payRows, st.marks, st.records);
      const key = credits() && !r.qboBuyer ? L.creditKey(r, ctx()) : ''; // the customer on this sale, for its credit tag and Give credit
      $('rail').innerHTML = `
        <div><h3>${esc(KIND_LABEL[r.kind])} ${esc(r.number)}</h3><div class="big num">${money(r.total)}</div>
          <div class="state"><span class="pill ${t.tone}">${['paid'].includes(t.key) ? ICON.check : ''}${esc(t.pill)}</span>${awaitingPickup(r) ? '<span class="pill soon">Presold, awaiting pickup</span>' : ''}${L.refundDue(r) ? `<span class="pill late">${esc(L.refundDue(r))}</span>` : ''}${r.movedText ? `<span class="pill credit">${esc(r.movedText)}</span>` : ''}${r.kind === 'receipt' && r.creditUsed > 0 ? `<span class="pill credit">Store credit −${money(r.creditUsed)}</span>` : ''}${pendingPill(r)}${qn ? `<span class="pill muted">${esc(qn)}</span>` : ''}${stale ? `<span class="pill soon">${ICON.email}Emailed ${esc(fmtD(stale))}, changed since</span>` : sent ? `<span class="pill draft">${ICON.email}Emailed ${esc(fmtD(sent))}</span>` : draft ? `<span class="pill draft">${ICON.email}Draft made ${esc(fmtD(draft))}</span>` : ''}</div></div>
        ${r.name || r.company || r.phone || r.qboBuyer ? `<div class="who"><h3>Customer</h3><b${r.qboBuyer || !(r.company || r.name) ? ' class="muted"' : ''}>${esc(r.qboBuyer ? 'QuickBooks buyer: ' + r.qboBuyer.name : r.company || r.name || 'No name')}</b>${!r.qboBuyer && r.company && r.name ? esc(r.name) + '<br>' : ''}${r.phone ? esc(r.phone) + '<br>' : ''}${r.email ? esc(r.email) : '<span class="muted">No email on file</span>'}${addr.length ? '<br>' + addr.map(esc).join('<br>') : ''}${key ? `<div class="ccredit">${creditPill(creditOf(key))}<button class="btn quiet" data-act="giveCredit">Give credit</button></div>` : ''}</div>` : ''}
        <div class="acts">${railActsHtml(acts, st.busy, false)}</div>${payLinkHtml(r)}
        <div><h3>History</h3><ol>${hist.map(e => `<li>${esc(e.t)}<span>${esc([fmtD(e.d), e.at].filter(Boolean).join(' · '))}</span>${e.before != null ? `<a class="rec" href="#" data-before="${e.before}">See it before this edit</a>` : ''}</li>`).join('')}</ol></div>`;
    }
    // During an edit the panel is only the customer editor (D14), at the panel's normal width (D13). A redraw keeps the caret.
    function drawEditRail() {
      const f = st.edit, ae = doc.activeElement, held = ae && ae.dataset && ae.dataset.cf && $('rail').contains(ae) ? { k: ae.dataset.cf, a: ae.selectionStart, b: ae.selectionEnd } : null;
      $('rail').innerHTML = custEditHtml(f.record, f.cust, editBusy(f));
      if (held) { const el = $(CUST_IDS[held.k]); if (el && !el.disabled) { el.focus(); try { el.setSelectionRange(held.a, held.b); } catch (_) {} } }
    }
    const editBusy = f => !!(f.asked || (f.state && f.state.saving));

    // The record's Helcim bits under the buttons: the pay link with Copy, a plain Helcim error, or what needs a look.
    function payLinkHtml(r) {
      const url = r.kind === 'invoice' ? linkFor(r) : '', err = st.linkErr[r.txnId], look = r.kind === 'invoice' && UNPAID.has(r.state) ? st.looks[r.txnId] : '';
      return (url ? `<div class="paylink"><h3>Pay link</h3><div class="url">${esc(url)}</div><button class="btn" data-act="copyLink">Copy</button></div>` : '')
        + (r.kind === 'invoice' && staleLink(r) ? '<div class="note-void">Pay link needs a new link: the total changed</div>' : '')
        + (err ? `<div class="note-void">${esc(err)}</div>` : '') + (look ? `<div class="note-void">${look === STALE_LOOK ? STALE_LOOK : 'Needs a look: ' + esc(look)}</div>` : '');
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
      // Store credit (invoices only): the customer's credit, at most what is owed. Untouched, the amount box means "all of it"; a smaller
      // typed amount uses that much. The sheet is read again when it is written (takeCredit).
      const key = !dep && credits() ? L.creditKey(r, ctx()) : '', avail = key ? Math.min(Math.max(0, creditOf(key)), Math.round(r.balance * 100)) : 0, typedAt = $('payAmt').value;
      $('payCredit').hidden = !(avail > 0);
      $('payCredit').textContent = `Store credit · ${money(avail / 100)}`;
      d.returnValue = '';
      d.onsubmit = e => {
        if (!e.submitter || !METHOD_LABEL[e.submitter.value]) return;
        const credit = e.submitter.value === 'credit_used';
        let c = credit && $('payAmt').value === typedAt ? { amount: avail / 100 } : checkAmount($('payAmt').value, left);
        if (credit && !c.error && Math.round(c.amount * 100) > avail) c = { error: `Store credit covers up to ${money(avail / 100)}.` };
        if (c.error) { e.preventDefault(); $('payErr').textContent = c.error; $('payAmt').focus(); return; }
        d.amount = c.amount;
      };
      d.onclose = () => { if (d.returnValue === 'credit_used') useCredit(r, key, d.amount); else if (METHOD_LABEL[d.returnValue]) markPaid(r, d.returnValue, d.amount); };
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
    // Store credit on an invoice: written only if the fresh Payments tab still holds that much (takeCredit).
    function useCredit(r, key, amount) {
      run('pay', async () => {
        const out = await takeCredit(host(), r, Math.round(amount * 100), key, ctx(), Date.now());
        if (!out.ok) return out.message;
        const left = cents(r.balance - amount);
        return { text: `${money(amount)} of store credit used on ${r.number}.${left > 0 ? ` ${money(left)} still owed.` : ''}`, undo: () => undoPaid(r.txnId) };
      });
    }
    // Undo voids the newest live payment, read fresh (load). Store credit: an automatic move already spent is refused with a plain sentence.
    function undoPaid(id) {
      run('undoPay', async () => {
        await load(true);
        const r = recById(id);
        let rows;
        try { rows = r ? L.undoRows(r, Date.now(), host().place || '', { paymentRows: st.payRows, records: st.records, ctx: ctx() }) : []; }
        catch (e) { return s(e && e.message) || 'That did not go through. Nothing changed.'; }
        if (!rows.length) return `${id} has no payment to undo.`;
        await host().appendPaymentRows(rows);
        if (rows[0][5] === 'credit_given') return `The move to store credit on ${r.number} is undone.`;
        return r.kind === 'quote' ? `Last deposit on ${r.number} undone.` : `${r.number} is unpaid again.`;
      });
    }
    // Give credit: amount and a short reason (required) for the picked customer. One credit_given row; its toast offers Undo.
    function giveCredit(key, name) {
      const d = $('creditDlg'), have = creditOf(key);
      $('crTitle').textContent = `Give store credit to ${name}`;
      $('crHave').textContent = have ? `${creditText(have)} on file now.` : 'No store credit on file yet.';
      $('crAmt').value = ''; $('crWhy').value = ''; $('crErr').textContent = '';
      d.returnValue = ''; d.rows = null;
      d.onsubmit = e => {
        if (!e.submitter || e.submitter.value !== 'give') return;
        const out = giveCreditRows(key, $('crAmt').value, $('crWhy').value, st.today, host().place, Date.now());
        if (out.error) { e.preventDefault(); $('crErr').textContent = out.error; (/reason/.test(out.error) ? $('crWhy') : $('crAmt')).focus(); return; }
        d.rows = out.rows;
      };
      d.onclose = () => {
        const rows = d.returnValue === 'give' && d.rows; d.rows = null;
        if (rows) run('giveCredit', async () => { await host().appendPaymentRows(rows); return { text: `${money(rows[0][4])} store credit given to ${name}.`, undo: () => undoGiven(rows[0][0], name) }; });
      };
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      $('crAmt').focus();
    }
    // Undo one Give credit row, read fresh; refused with L.undoCredit's sentence when some of it is already used.
    function undoGiven(id, name) {
      run('undoCredit', async () => {
        await load(true);
        const p = L.livePayments(L.parsePayments(st.payRows)).find(x => x.payment_id === id);
        if (!p) return 'That store credit is already undone.';
        let row;
        try { row = L.undoCredit(p, Date.now(), host().place || '', { paymentRows: st.payRows, records: st.records, ctx: ctx() }); }
        catch (e) { return s(e && e.message) || 'That did not go through. Nothing changed.'; }
        await host().appendPaymentRows([row]);
        return `Store credit of ${money(p.amount)}${name ? ` for ${name}` : ''} undone.`;
      });
    }
    // Email: the shared email window (email-window.js). It sends only when a person presses Send.
    function emailWindow(r) {
      const request = st.request || requestFromRecord(r);
      run('email', async () => {
        const prep = await host().emailPrepare(r, request, r.kind === 'invoice' ? linkFor(r) : '');
        st.busy = ''; draw();
        const out = await root.MPEEmailWindow.open({ ...prep, pages: prep.pages || (st.pages || []).slice(0, 1), key: r.txnId, heading: `Email ${KIND_LABEL[r.kind].toLowerCase()} ${r.number}`,
          cannotSend: prep.canSend ? '' : 'This app needs its update before it can send. The update installs by itself when the register is idle.',
          send: async f => { await documentUnchanged(host(), r); return host().sendEmail(r, prep, f); } });
        return out && out.sent ? `Sent to ${out.to}.` : '';
      });
    }
    // Saved on this computer and not on the sheet yet, or parked for a look: shown as a pill on the record.
    const pendingIds = () => { const h = host(); return h && h.pendingTxnIds ? h.pendingTxnIds() : new Set(); };
    const parkedIds = () => { const h = host(); return h && h.parkedTxnIds ? h.parkedTxnIds() : new Set(); };
    function pendingPill(r) {
      return pendingIds().has(r.txnId) ? '<span class="pill muted">Saved on this computer, not shared yet</span>'
        : parkedIds().has(r.txnId) ? '<span class="pill late">Last change needs a look</span>' : '';
    }
    function syncCustEdit() { // update the box, hint and error in place, so typing never loses the caret
      const f = st.edit; if (!f) return;
      const m = custEditModel(f.record, f.cust);
      $('dcUpdate').checked = m.ticked; $('dcHint').textContent = m.hint; $('dcErr').textContent = f.cust.err;
    }
    function openSale(kind, r, what) {
      run(kind, async () => { await host().openInNewSale({ kind, txn: { ...withDeposit(r), cardFee: cardFeeOf(r) > 0, storeCredit: r.creditUsed || 0 } }); return `${what} opened in a new sale tab. The sale in progress is unchanged.`; });
    }
    // App 0.3.66 (no customer on the embedded save): the items are on the sheet, so the silent session saves the customer on the
    // freshly loaded record, the same way the old customer editor did. A failure says so plainly; the items stay saved.
    async function saveCustomerAfter(r, res, f) {
      const first = f.viaCancel ? '' : editOutcomeText(r, res);
      st.busy = 'docEdit';
      let out = null, fresh = r;
      try {
        await load();
        fresh = recById(r.txnId) || r;
        const h = host();
        out = h && h.editSession ? await h.editSession(fresh, { ...customerPatch(fresh, f.followUp.typed), updateInfo: !!f.followUp.updateInfo }, { cardFee: cardFeeOf(fresh) > 0, storeCredit: fresh.creditUsed || 0 }) : null;
      } catch (_) { out = null; }
      st.busy = '';
      toast(followUpText(fresh, first, out));
      return load();
    }
    // ---- The one Edit (D14): the register's sale lines sit in #editSlot under the Now editing bar; the panel holds the customer.
    function startEmbed(r) {
      const h = host();
      if (st.edit || st.busy || !h || !h.editEmbed) return;
      st.before = null;
      st.edit = editFlow(h, r, { cardFee: cardFeeOf(r) > 0, storeCredit: r.creditUsed || 0, confirm: text => root.confirm(text), changed: () => drawEdit(), ended: res => endEmbed(r, res) });
      draw();
    }
    // The one result: back to the same row (section, sub-tab, search and scroll as they were), a toast, then one fresh load.
    // The sale screen could not prove the saved rows before it opened: the old way, a new sale tab (R10).
    function endEmbed(r, res) {
      const f = st.edit;
      st.edit = null;
      if (embedFallsBack(res, f)) { draw(); return openSale('edit', r, `${r.number} cannot be edited here, so it`); }
      ui.sel = r.txnId;
      if (followUpRuns(f, res)) return saveCustomerAfter(r, res, f);
      toast(f && f.followUp && res && res.ok && res.pending ? `${editOutcomeText(r, res)} The customer details were not saved yet. Open Edit again once it is shared.` : editOutcomeText(r, res));
      load();
    }
    function drawEdit() {
      const f = st.edit, on = !!f;
      $('editBar').hidden = !on; $('editSlot').hidden = !on; $('paper').hidden = on; $('note').hidden = on;
      if (on) {
        $('editBar').innerHTML = editBarHtml(f, { payLink: f.record.kind === 'invoice' && !!rawLink(f.record), credit: !!credits() });
        const busy = editBusy(f); // while saving the panel's fields wait too
        $('rail').querySelectorAll('.cedit input').forEach(el => { el.disabled = busy; });
      } else $('editBar').innerHTML = '';
      sendRect();
    }
    // Where the sale screen goes: the slot's box in this page's CSS px, a higher seq every time (the app keeps only the newest).
    function sendRect() {
      const f = st.edit;
      if (!f || f.done) return;
      const el = $('editSlot'), b = el.hidden ? null : el.getBoundingClientRect();
      f.rect(b && b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, width: b.width, height: b.height } : null);
    }
    // An automatic reload (tab shown again, the host arriving, refresh) waits while an edit is open; the edit's end runs one load().
    const autoLoad = () => { if (st.edit && st.edit.defer()) return; load(); };
    function act(k, el) {
      const r = byId(ui.sel);
      if (k === 'editSave') { if (st.edit && st.edit.save()) drawEdit(); return; }
      if (k === 'editCancel') return st.edit && st.edit.cancel();
      if (st.edit) return toast(LOCK);
      if (k === 'retry') return load();
      if (k === 'qboRefresh') return refreshQbo();
      if (k === 'hcCheck') return helcimCheck(true);
      if (k === 'clearSearch') { ui.q = ''; $('q').value = ''; return draw(); }
      if (k === 'clearFilters') { ui.when = ui.src = ui.cShow = ui.cSort = ''; ui.sel = ''; return draw(); }
      if (k === 'more') { st.limit += PAGE; return draw(); }
      if (k === 'beforeOff') { st.before = null; return draw(); }
      if (k === 'cMore') { st.recLimit = Infinity; return draw(); }
      if (k === 'backCust') { ui.section = 'customers'; ui.q = ''; $('q').value = ''; ui.sel = st.backTo; st.backTo = ''; return draw(); }
      if (ui.section === 'customers') {
        if (k === 'cNew' && r) return openSale('newInvoice', newInvoiceTxn(r), `A new invoice for ${r.company || r.name}`);
        if (k === 'cEdit' && r) return editCustomer(r);
        if (k === 'giveCredit' && r && credits()) return giveCredit(r.id, r.company || r.name);
        if (k === 'undoCredit' && r && el) return undoGiven(el.dataset.id, r.company || r.name);
        return;
      }
      if (!r) return;
      if (k === 'pay') return takePayment(r);
      if (k === 'giveCredit') { const key = credits() ? L.creditKey(r, ctx()) : ''; return key && giveCredit(key, r.company || r.name); }
      if (k === 'undoPay') return undoPaid(r.txnId);
      if (k === 'payLink') return addLink(r);
      if (k === 'copyLink') return copyLink(linkFor(r));
      if (k === 'pdf') return host().openPdf(r.number, r).then(res => { if (!res || !res.ok) toast(PDF_WHY[res && res.reason] || PDF_WHY.missing); else load(); }, () => toast(PDF_WHY.offline));
      if (k === 'reprint') return run('reprint', async () => { const out = await host().reprint(r, st.request || requestFromRecord(r)); return out?.printed === false ? 'Not printed.' : `${r.number} sent to print.`; });
      if (k === 'email') return emailWindow(r);
      if (k === 'toSale') return r.deposit > 0
        ? run('quote', async () => { await host().openInNewSale({ kind: 'quote', txn: withDeposit(r) }); return `Quote ${r.number} opened in a new sale tab. Deposit ${money(r.deposit)} already paid: collect ${money(cents(r.total - r.deposit))}.`; })
        : openSale('quote', r, `Quote ${r.number}`);
      if (k === 'copy') return openSale('copy', r, `A copy of ${r.number}`);
      if (k === 'newInvoice') return openSale('newInvoice', r, `A new invoice for ${who(r)}`);
      if (k === 'edit') return host().editEmbed ? startEmbed(r) : openSale('edit', r, `${r.number}`); // no popup (Trevor, Nov 1): the copy before the edit is kept
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
      const items = actionsFor(r, !!(host() && host().openPdf), helcimState(r)).filter(a => !a.disabled && a.act !== 'retype')
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
      if (st.edit && !t.closest('#editBar')) {
        if (t.closest('[data-go],[data-before],[data-open],[data-section],[data-sub],.row,[data-act]')) { e.preventDefault(); toast(LOCK); }
        return;
      }
      const g = t.closest('[data-go]'); if (g) { e.preventDefault(); return go(g.dataset.go); }
      const bf = t.closest('[data-before]'); if (bf) { e.preventDefault(); st.before = { txnId: ui.sel, i: Number(bf.dataset.before) }; return draw(); }
      const a = t.closest('[data-act]'); if (a && !a.disabled) { e.preventDefault(); return act(a.dataset.act, a); }
      const o = t.closest('[data-open]'); if (o) return openRecord(o.dataset.open);
      const sec = t.closest('[data-section]'); if (sec) { st.backTo = ''; ui.section = sec.dataset.section; ui.q = ''; ui.sel = ''; $('q').value = ''; ui.scroll = 0; $('list').scrollTop = 0; draw(); return helcimCheck(false); }
      const sub = t.closest('[data-sub]'); if (sub) { st.backTo = ''; const [key, v] = sub.dataset.sub.split(':'); ui[key] = v; ui.sel = ''; $('list').scrollTop = 0; return draw(); }
      const row = t.closest('.row[data-id]'); if (row) { st.backTo = ''; return select(row.dataset.id); }
    });
    $('list').addEventListener('contextmenu', e => {
      const row = e.target.closest('.row[data-id]');
      if (!row || ui.section === 'customers') return;
      e.preventDefault();
      if (st.edit) return toast(LOCK);
      st.backTo = '';
      select(row.dataset.id);
      const r = byId(row.dataset.id); if (r) rowMenu(r, e.clientX, e.clientY);
    });
    const rail = $('rail');
    // The panel's customer fields during an edit: typing goes to st.edit.cust; the bar's Save and Cancel follow it.
    rail.addEventListener('input', e => {
      const k = e.target.dataset && e.target.dataset.cf, f = st.edit; if (!k || !f || editBusy(f)) return;
      f.cust.typed[k] = e.target.value; f.cust.err = ''; syncCustEdit(); drawEdit();
    });
    rail.addEventListener('change', e => { const f = st.edit; if (f && e.target.id === 'dcUpdate') { f.cust.touched = true; f.cust.box = e.target.checked; syncCustEdit(); } });
    rail.addEventListener('keydown', e => { if (st.edit && e.key === 'Enter' && e.target.dataset && e.target.dataset.cf) e.preventDefault(); }); // Enter never saves by surprise
    doc.addEventListener('mousedown', e => { const menu = $('menu'); if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="pay"]')) menu.hidden = true; });
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('menu').hidden = true; return; }
      if (!['ArrowDown', 'ArrowUp'].includes(e.key) || (e.target.tagName === 'INPUT' && e.target.id !== 'q') || st.phase !== 'ready' || st.edit) return;
      const rows = currentView().rows;
      const i = rows.findIndex(r => r.txnId === ui.sel);
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { e.preventDefault(); select(n.txnId); }
    });
    // Scanner typed like a keyboard: keys under SCAN_GAP ms apart, ending in Enter or Tab, are a scan. Its keys are kept out of the
    // page, the text box it landed in (search, or a customer field during an edit) keeps its text, and the code goes on: app, to the
    // last sale tab, or to the open edit's lines (main's scanTarget); website, during an edit, to the edit's lines (other keys are
    // already forwarded to the edit frame by ledger-tab.js, so only a scan typed in a text box is caught here).
    const SCAN_GAP = 35, SCAN_MIN = 4;
    const isText = el => !!el && ((el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type)) || el.tagName === 'TEXTAREA');
    let burst = '', lastKey = 0, saved = null;
    doc.addEventListener('keydown', e => {
      const h = host(), web = st.edit && st.edit.scan, send = web || (h && h.scan);
      if (!send || e.ctrlKey || e.metaKey || e.altKey || (web && !isText(e.target))) return;
      const now = e.timeStamp || Date.now();
      const fast = now - lastKey < SCAN_GAP;
      lastKey = now;
      if (e.key.length === 1) {
        if (!fast) { burst = ''; saved = isText(e.target) ? { el: e.target, v: e.target.value } : null; }
        burst += e.key;
        if (burst.length >= 3) e.preventDefault(); // three keys each under 35 ms apart is a scanner, never a person
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && fast && burst.length >= SCAN_MIN) {
        e.preventDefault(); e.stopPropagation();
        if (saved && saved.el.value !== saved.v) { saved.el.value = saved.v; saved.el.dispatchEvent(new root.Event('input', { bubbles: true })); }
        const code = burst; burst = ''; saved = null;
        send(code);
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
    root.addEventListener('resize', () => { fitDocument(); sendRect(); });
    if (root.ResizeObserver) new root.ResizeObserver(sendRect).observe($('editSlot')); // bar height, rail width, window: the slot moves
    // Coming back to the tab: fresh numbers from other computers, same search, row and scroll.
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && st.phase === 'ready') autoLoad(); });
    root.addEventListener('mpe-ledger-host', autoLoad); // the host announces itself if it attaches after this page
    api.refresh = autoLoad;
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
    payLink: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    pay: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 4.5 4.5 10.5-11"/></svg>',
    check: '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 4.5 4.5 10.5-11"/></svg>',
    reprint: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="1.5"/><path d="M7 14h10v6.5H7z"/></svg>',
    email: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="1.5"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>',
    edit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    undoPay: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    toSale: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/></svg>',
    copy: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
    giveCredit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/></svg>',
    newInvoice: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };
  const api = { ...pure, withDeposit, cardFeeOf, boot };
  return api;
});
