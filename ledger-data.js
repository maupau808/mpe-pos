/* Ledger tab data logic (pure, no DOM, no network). Browser: window.MPELedgerData. Node: module.exports.
 *
 * Transactions A:W (0-based): 0 type, 1 txnId, 2 date, 3 time, 4 name/company, 5 phone, 6 email, 7 addr,
 *   12 total (TXN) / sub (item), 13 fromQuote (TXN) / serials (item), 14 docType, 15 number (P),
 *   16-21 name, company, street, city, state, zip (Q-V); item rows: 8 pn, 9 desc, 10 qty, 11 ea.
 * Only TXN and item rows are read; REORDER, STOCK_SESSION, CUSTOMER_*, blank and unknown rows are ignored.
 * Duplicate txnId (in-place edit): the first TXN row from the top wins (edits rewrite the topmost row in place).
 * History's parser (POS/index.html:7118-7426) is to be deleted in T5b so this becomes the only one. Until then
 * search tokens, haystack and customer fixes (MPETransactionContact.displayRows) agree with History's.
 *
 * VOID MARKER (no change to Transactions columns, no extra tab): a corrected invoice is a new invoice whose
 * "from quote" cell (N) holds the TxnID of the OLD INVOICE. N already means "made from that document"; when
 * the target is an invoice (not a quote) the target is void. The old record shows state "void" with
 * replacedBy = the new number. Chains (A->B->C) void A and B. A void invoice owes nothing.
 *
 * Payments tab columns (C3, minus taken_by; method only): see PAYMENT_COLUMNS. Undo appends a void row per live
 * payment on the invoice (undoRows; voids = payment_id it undoes); nothing is deleted. A payment_id seen twice
 * counts once. Per invoice the NEWEST live payment (recorded_at) decides paid status and amount; payments are
 * never summed, so Mark paid on two computers (two ids) is paid once. A replacement invoice inherits the live
 * payments of the invoices it replaced (following the void chain).
 *
 * Email draft marker: the page passes `drafts` (array of txnIds or numbers, or an object keyed by them).
 * Record gets draftMade/draftText "Draft made". Never "Sent".
 *
 * MARKS live on the Payments tab too: a row with method 'email_draft' (a Gmail draft was made) or 'edit' (the record was
 * edited in place) and amount 0 (buildMarkRow). parsePayments drops them, so they never count toward paid status;
 * parseMarks turns them into { drafts: {txnId: date}, edits: {txnId: date} }, newest date per record.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MPELedgerData = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const NET_DAYS = 30;
  const SOON_DAYS = 7;
  const METHODS = Object.freeze(['cash', 'check', 'card_terminal']);
  const MARKS = Object.freeze({ email_draft: 'drafts', edit: 'edits' });
  const PAYMENT_COLUMNS = Object.freeze(['payment_id', 'invoice_number', 'txnId', 'date', 'amount', 'method',
    'note', 'place', 'recorded_at', 'voids']);

  const s = v => String(v == null ? '' : v).trim();
  const money = v => { const n = parseFloat(s(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const cents = n => Math.round(n * 100);
  const alnum = v => s(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  // Shop date (Pacific/Honolulu) as YYYY-MM-DD for a Date, ISO string or Date-like; default now.
  function honoluluToday(d) {
    const dt = d == null ? new Date() : new Date(d);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
  }
  const todayIso = t => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t)) ? t : honoluluToday(t);

  function isoDate(v) {
    const t = s(v);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
  }
  const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const addDays = (iso, n) => new Date((dayNum(iso) + n) * 864e5).toISOString().slice(0, 10);
  // ---- Transactions ----
  function parseTransactions(rows, states) {
    const out = [], seen = new Set();
    let cur = null;
    (rows || []).forEach(r => {
      const type = s(r && r[0]).toLowerCase();
      if (type === 'txn') {
        const id = s(r[1]);
        if (!id || seen.has(id)) { cur = null; return; } // first row from the top wins; later duplicates dropped
        seen.add(id);
        const parts = [r[16], r[17], r[18], r[19], r[20], r[21]].map(s);
        const e = s(r[4]);
        const sameAsParts = e === [parts[0], parts[1]].filter(Boolean).join(' / ');
        const split = e.split(' / ');
        const st = states && states.get && states.get(id);
        cur = {
          txnId: id, number: s(r[15]), docType: s(r[14]).toLowerCase(), date: isoDate(r[2]), time: s(r[3]),
          name: sameAsParts ? parts[0] : s(split[0]), company: sameAsParts ? parts[1] : s(split.slice(1).join(' / ')),
          street: parts[2], city: parts[3], region: parts[4], zip: parts[5],
          addr: s(r[7]), phone: s(r[5]), email: s(r[6]),
          total: money(r[12]), fromQuote: s(r[13]), items: [],
          presell: s(r[22]).toUpperCase() === 'PRESELL',
          completedContact: st && !st.conflict ? st.contact : null,
          contactConflict: st ? !!st.conflict : (rows || []).some(x => s(x && x[0]) === 'CUSTOMER_UPDATE' && s(x[1]) === id),
          _hayParts: [id, s(r[2]), e, s(r[5]), s(r[6]), s(r[7]), s(r[12]), DOC_TITLES[s(r[14]).toLowerCase()] || s(r[14]), s(r[15])],
        };
        out.push(cur);
      } else if (type === 'item' && cur && s(r[1]) === cur.txnId) {
        cur.items.push({ pn: s(r[8]), desc: s(r[9]), qty: s(r[10]), ea: money(r[11]), sub: money(r[12]),
          serials: s(r[13]).split(',').map(x => x.trim()).filter(Boolean) });
        cur._hayParts.push(s(r[8]), s(r[9]), s(r[13]));
      } else if (type !== 'item') cur = null; // noise row ends the open group
    });
    for (const t of out) { // same haystacks as History's _parseTxnRows
      t._hay = t._hayParts.filter(Boolean).join(' ').toLowerCase();
      t._serialHay = t.items.flatMap(i => i.serials).map(alnum).filter(Boolean).join(' ');
      delete t._hayParts;
    }
    return out;
  }
  const DOC_TITLES = { receipt: 'Receipt', invoice: 'Invoice', quote: 'Quote', internal: 'Internal' };

  // ---- Payments ----
  function newPaymentId(now) {
    return 'pay_' + (now || Date.now()).toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function buildPaymentRow(p, now) {
    if (!METHODS.includes(p.method)) throw new Error('method must be cash, check or card_terminal');
    const amt = typeof p.amount === 'string' && p.amount.trim() === '' ? NaN : Number(p.amount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error('amount must be a number, 0 or more');
    const at = (now ? new Date(now) : new Date()).toISOString();
    return [p.payment_id || newPaymentId(Date.parse(at)), s(p.invoice_number), s(p.txnId), isoDate(p.date) || honoluluToday(at),
      amt.toFixed(2), p.method, s(p.note), s(p.place), at, ''];
  }
  function buildVoidRow(target, now, place) { // Undo of one payment: append, never delete
    const at = (now ? new Date(now) : new Date()).toISOString();
    return [newPaymentId(Date.parse(at)), target.invoice_number, target.txnId, honoluluToday(at), '0.00', target.method,
      'undo', s(place), at, target.payment_id];
  }
  // Undo for an invoice record: one void row for EVERY live payment that counts toward it.
  function undoRows(record, now, place) {
    const base = now ? new Date(now).getTime() : Date.now();
    return (record.paymentsLive || []).map((p, i) => buildVoidRow(p, base + i, place));
  }
  const paymentRows = rows => (rows || []).filter(r => r && s(r[0]) && s(r[0]) !== PAYMENT_COLUMNS[0]).map(r => { // blank or header out
    const o = {};
    PAYMENT_COLUMNS.forEach((c, i) => { o[c] = s(r[i]); });
    o.amount = money(o.amount);
    return o;
  });
  const parsePayments = rows => paymentRows(rows).filter(o => !MARKS[o.method]);
  // A mark: kind 'email_draft' or 'edit', amount 0, never a payment.
  function buildMarkRow(m, now) {
    if (!MARKS[m.kind]) throw new Error('mark must be email_draft or edit');
    const at = (now ? new Date(now) : new Date()).toISOString();
    return ['mark_' + Date.parse(at).toString(36) + Math.random().toString(36).slice(2, 8), s(m.invoice_number), s(m.txnId),
      honoluluToday(at), '0.00', m.kind, '', s(m.place), at, ''];
  }
  function parseMarks(rows) {
    const out = { drafts: {}, edits: {} };
    for (const o of paymentRows(rows)) {
      const key = o.txnId || o.invoice_number, bucket = out[MARKS[o.method]];
      if (bucket && key && !(bucket[key] >= o.date)) bucket[key] = o.date;
    }
    return out;
  }
  // Live payments: unique payment_id, minus any id a void row points at.
  function livePayments(payments) {
    const seen = new Set(), voided = new Set(), uniq = [];
    for (const p of payments) {
      if (seen.has(p.payment_id)) continue;
      seen.add(p.payment_id);
      uniq.push(p);
      if (p.voids) voided.add(p.voids);
    }
    return uniq.filter(p => !p.voids && !voided.has(p.payment_id));
  }

  // ---- Status ----
  const newestFirst = (a, b) => b.recorded_at.localeCompare(a.recorded_at) || b.payment_id.localeCompare(a.payment_id);
  function derive(txns, payments, today, drafts) {
    today = todayIso(today);
    const live = livePayments(payments || []);
    const draftSet = new Set(Array.isArray(drafts) ? drafts : Object.keys(drafts || {}));
    const byId = new Map(txns.map(t => [t.txnId, t]));
    const replacedBy = new Map(), replaces = new Map(); // old txnId -> new record ; new txnId -> [old records]
    for (const t of txns) {
      const old = byId.get(t.fromQuote);
      if (t.docType === 'invoice' && old && old.docType === 'invoice' && old !== t) {
        replacedBy.set(old.txnId, t);
        if (!replaces.has(t.txnId)) replaces.set(t.txnId, []);
        replaces.get(t.txnId).push(old);
      }
    }
    const chain = t => { // this invoice plus every invoice it (transitively) replaced
      const out = [], seen = new Set(), stack = [t];
      while (stack.length) {
        const c = stack.pop();
        if (seen.has(c.txnId)) continue;
        seen.add(c.txnId); out.push(c);
        stack.push(...(replaces.get(c.txnId) || []));
      }
      return out;
    };
    return txns.map(t => {
      const kind = t.docType === 'invoice' || t.docType === 'quote' ? t.docType : 'receipt';
      const r = { ...t, kind, draftMade: draftSet.has(t.txnId) || (!!t.number && draftSet.has(t.number)) };
      r.draftText = r.draftMade ? 'Draft made' : '';
      if (kind !== 'invoice') { r.state = kind; return r; }
      const ids = new Set(), nums = new Set();
      for (const c of chain(t)) { ids.add(c.txnId); if (c.number) nums.add(c.number); }
      r.paymentsLive = live.filter(p => ids.has(p.txnId) || (!p.txnId && nums.has(p.invoice_number)));
      const latest = [...r.paymentsLive].sort(newestFirst)[0];
      r.paid = latest ? latest.amount : 0; // newest live event decides; never summed
      r.paidDate = latest ? latest.date : '';
      r.paidMethod = latest ? latest.method : '';
      r.balance = Math.max(0, (cents(t.total) - cents(r.paid)) / 100);
      r.dueDate = t.date ? addDays(t.date, NET_DAYS) : '';
      const next = replacedBy.get(t.txnId);
      if (next) { r.state = 'void'; r.replacedBy = next.number || next.txnId; r.balance = 0; return r; }
      if (r.balance <= 0) { r.state = 'paid'; return r; }
      const left = r.dueDate ? dayNum(r.dueDate) - dayNum(today) : Infinity;
      r.daysLate = left < 0 ? -left : 0;
      r.state = left < 0 ? 'overdue' : left <= SOON_DAYS ? 'dueSoon' : 'unpaid';
      return r;
    });
  }

  // ---- Filters, sort, summary, search ----
  const byDue = (a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9') || a.number.localeCompare(b.number);
  const newest = (a, b) => (b.date || '').localeCompare(a.date || '') || b.number.localeCompare(a.number);
  const FILTERS = {
    unpaid: [r => r.state === 'unpaid' || r.state === 'dueSoon' || r.state === 'overdue', byDue],
    dueSoon: [r => r.state === 'dueSoon', byDue],
    overdue: [r => r.state === 'overdue', byDue],
    paid: [r => r.state === 'paid', byDue],
    quotes: [r => r.kind === 'quote', newest],
    allSales: [r => r.kind !== 'quote', newest],
  };
  function filter(records, name) {
    const f = FILTERS[name];
    if (!f) throw new Error('unknown filter ' + name);
    return records.filter(f[0]).sort(f[1]);
  }
  function owedSummary(records) {
    let cts = 0, overdue = 0;
    for (const r of records) {
      if (r.state === 'unpaid' || r.state === 'dueSoon' || r.state === 'overdue') cts += cents(r.balance);
      if (r.state === 'overdue') overdue++;
    }
    return { total: cts / 100, overdue };
  }
  // Same rule as History's renderTxnResults: every word matches somewhere, or the space-insensitive serial
  // matches. Extra: 3+ digits also match phone digits (History has no such match; it is a superset).
  function search(records, query) {
    const q = s(query).toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.length) return records;
    const qc = q.replace(/[^a-z0-9]/g, ''), qd = q.replace(/\D/g, '');
    return records.filter(r => tokens.every(tok => r._hay.includes(tok)) ||
      (qc.length >= 3 && r._serialHay && r._serialHay.includes(qc)) ||
      (qd.length >= 3 && r.phone.replace(/\D/g, '').includes(qd)));
  }

  // One call for the page: rows in, ready model out. displayRows: optional (defaults to the page's
  // MPETransactionContact.displayRows) so CUSTOMER_UPDATE fixes and conflict flags match History.
  async function create({ txnRows, paymentRows, drafts, today, displayRows }) {
    const owner = typeof globalThis === 'object' ? globalThis.MPETransactionContact : null;
    const fn = displayRows || (owner && owner.displayRows && (rows => owner.displayRows(rows)));
    let rows = txnRows, states = null;
    if (fn) { const d = await fn(txnRows); rows = d.rows; states = d.states; }
    const records = derive(parseTransactions(rows, states), parsePayments(paymentRows), today, drafts);
    return {
      records,
      list: (name, query) => search(filter(records, name), query),
      owedSummary: () => owedSummary(records),
      search: q => search(records, q),
    };
  }

  return { NET_DAYS, SOON_DAYS, METHODS, PAYMENT_COLUMNS, parseTransactions, parsePayments, parseMarks, buildMarkRow, buildPaymentRow,
    buildVoidRow, undoRows, honoluluToday, livePayments, derive, filter, owedSummary, search, create };
});
