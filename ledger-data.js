/* Ledger tab data logic (pure, no DOM, no network). Browser: window.MPELedgerData. Node: module.exports.
 *
 * Transactions A:X (0-based; 23 = invoice PO number): 0 type, 1 txnId, 2 date, 3 time, 4 name/company, 5 phone, 6 email, 7 addr,
 *   12 total (TXN) / sub (item), 13 fromQuote (TXN) / serials (item), 14 docType, 15 number (P),
 *   16-21 name, company, street, city, state, zip (Q-V); item rows: 8 pn, 9 desc, 10 qty, 11 ea, 14 original ea, 15 off per unit.
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
 * Payments tab columns (C3, minus taken_by; method only): see PAYMENT_COLUMNS. Undo appends ONE void row for the newest
 * live payment on the invoice (undoRows; voids = payment_id it undoes); nothing is deleted. A payment_id seen twice
 * counts once. Live payments on an invoice ADD UP (partial payments, Trevor 2026-11-01); the balance is total minus
 * that sum, never below 0, so the same payment taken on two computers still leaves the invoice simply paid. A
 * replacement invoice inherits the live payments of the invoices it replaced (following the void chain).
 *
 * Email draft marker: the page passes `drafts` (array of txnIds or numbers, or an object keyed by them).
 * Record gets draftMade/draftText "Draft made". Never "Sent".
 *
 * MARKS live on the Payments tab too: a row with method 'email_draft' (a Gmail draft was made) or 'edit' (the record was
 * edited in place) and amount 0 (buildMarkRow). parsePayments drops them, so they never count toward paid status;
 * parseMarks turns them into { drafts: {txnId: date}, edits: {txnId: date} }, newest date per record.
 * Output marks 'print', 'pdf' (saved or downloaded) and 'pdf_open' (History's Open PDF) go in the same way; parseMarks also gives
 * log {txnId|number: [{ kind, date, at, place, note }]}, one entry per print, PDF and email draft, for History's timeline.
 *
 * CANCEL (Cancel sale, append-only, nothing on Transactions changes): marks of kind 'cancel' and 'uncancel' on the Payments tab,
 * same columns as every mark: id, invoice_number, txnId, date, '0.00', kind, '', place, recorded_at ISO, ''. For one txnId the NEWEST
 * mark (recorded_at; a later row wins a tie) decides: newest 'cancel' = cancelled. parseMarks gives cancels {txnId: {cancelled, at, date}}.
 * cancelledIds(paymentRows) -> Set of currently cancelled txnIds is THE CONTRACT the stock poll mirrors. A cancelled receipt or invoice
 * gets state 'cancelled' (cancelledAt = the mark's date), owes nothing, and stays out of Customers balances and Awaiting pickup.
 *
 * CUSTOMERS (buildCustomers): QuickBooks customers (the nightly file's `customers` array), rows of the sheet's Customers tab
 * (CUSTOMER_COLUMNS: the register's 9 plus J "QBO Id", written only by History) and the customers seen on Transactions / QuickBooks
 * records, grouped into one customer each. Group = QuickBooks id when known, else the register's key (customerKey). The newest
 * Customers-tab row of a group (Added date, then row order) wins over QuickBooks for every contact field. The balance is the
 * existing owed rule over the group's own records (pre-2026 never counts); QuickBooks' own `balance` field is never used.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MPELedgerData = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const NET_DAYS = 30;
  const COUNT_FROM = '2026-01-01'; // invoices dated earlier never count as owed
  const SOON_DAYS = 7;
  const METHODS = Object.freeze(['cash', 'check', 'card_terminal', 'helcim_card', 'helcim_ach', 'credit_given', 'credit_used']); // helcim_*: payments Helcim reported (helcimPaymentRows); credit_*: store credit
  // Labels for the two store-credit methods (ledger.js owns the rest in its METHOD_LABEL). credit_given on a sale = an overpayment moved off it.
  const CREDIT_LABELS = Object.freeze({ credit_given: 'Moved to store credit', credit_used: 'Store credit' });
  const MARKS = Object.freeze({ email_draft: 'drafts', edit: 'edits', cancel: 'cancels', uncancel: 'cancels', print: 'prints', pdf: 'pdfs', pdf_open: 'pdfs', email_sent: 'sent', paylink: 'paylinks' }); // paylink: note = url|helcimInvoiceId (parseMarks.paylinks)
  const LOGGED = new Set(['email_draft', 'email_sent', 'print', 'pdf', 'pdf_open', 'paylink']); // each one shows in History's timeline
  const PAYMENT_COLUMNS = Object.freeze(['payment_id', 'invoice_number', 'txnId', 'date', 'amount', 'method',
    'note', 'place', 'recorded_at', 'voids', 'customer']); // customer (K): store credit's owner (QuickBooks id, else register key); blank on every other row

  const s = v => String(v == null ? '' : v).trim();
  const money = v => { const n = parseFloat(s(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const cents = n => Math.round(n * 100);
  const CREDIT = Object.freeze({ credit_given: true, credit_used: true });
  const signedCents = p => (p.method === 'credit_given' ? -1 : 1) * cents(p.amount); // credit_given moves money OFF the sale it names
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
          presell: s(r[22]).toUpperCase() === 'PRESELL', po: s(r[23]),
          completedContact: st && !st.conflict ? st.contact : null,
          contactConflict: st ? !!st.conflict : (rows || []).some(x => s(x && x[0]) === 'CUSTOMER_UPDATE' && s(x[1]) === id),
          _ph: s(r[5]).replace(/\D/g, ''),
          _hayParts: [id, s(r[2]), e, s(r[5]), s(r[6]), s(r[7]), s(r[12]), DOC_TITLES[s(r[14]).toLowerCase()] || s(r[14]), s(r[15])],
        };
        cur._raw = [r];
        out.push(cur);
      } else if (type === 'item' && cur && s(r[1]) === cur.txnId) {
        cur._raw.push(r);
        // O, P: original Ea. and the amount off each unit, written only for a discounted line.
        const off = money(r[15]);
        cur.items.push({ pn: s(r[8]), desc: s(r[9]), qty: s(r[10]), ea: money(r[11]), sub: money(r[12]),
          serials: s(r[13]).split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
          origEa: off > 0 ? money(r[14]) : 0, off: off > 0 ? off : 0 });
        cur._hayParts.push(s(r[8]), s(r[9]), s(r[13]));
      } else if (type !== 'item') cur = null; // noise row ends the open group
    });
    for (const t of out) { // same haystacks as History's _parseTxnRows
      t._hay = t._hayParts.filter(Boolean).join(' ').toLowerCase();
      t._serialHay = t.items.flatMap(i => i.serials).map(alnum).filter(Boolean).join(' ');
      t.fingerprint = transactionRowsFingerprint(t._raw); // the saved rows as read: an edit is refused if the sheet no longer matches
      delete t._hayParts; delete t._raw;
    }
    return out;
  }
  // The token for "the saved rows of one document" (Transactions A:X). The register's save and History's edit request use this one
  // function: an in-place rewrite is refused when the sheet block no longer has the fingerprint it was loaded or last verified with.
  function transactionRowsFingerprint(rows) {
    return JSON.stringify(rows.map(row => Array.from({ length: 24 }, (_, col) => {
      let value = String(row[col] ?? '').trim().replace(/^'/, '');
      if (col === 12 || (String(row[0]).toLowerCase() === 'item' && [10, 11, 14, 15].includes(col))) {
        return value === '' ? '' : Number(value.replace(/[$,]/g, '')).toFixed(2);
      }
      if (col === 3) value = value.replace(/^0(?=\d:)/, '').toUpperCase();
      if (col === 2) value = value.replace(/^0(?=\d\/)/, '').replace(/\/0(?=\d\/)/, '/'); // 11/04/2026 and 11/4/2026 are the same day (Sheets shows either)
      return value;
    })));
  }
  function transactionBlockEnd(rows, start, id) {
    let end = start + 1;
    while (end < rows.length && String(rows[end][0]).toLowerCase() === 'item' && String(rows[end][1]) === id) end++;
    return end;
  }
  const DOC_TITLES = { receipt: 'Receipt', invoice: 'Invoice', quote: 'Quote', internal: 'Internal' };

  // ---- Payments ----
  function newPaymentId(now) {
    return 'pay_' + (now || Date.now()).toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function buildPaymentRow(p, now) {
    if (!METHODS.includes(p.method)) throw new Error('method must be cash, check, card_terminal, helcim_card, helcim_ach, credit_given or credit_used');
    const amt = typeof p.amount === 'string' && p.amount.trim() === '' ? NaN : Number(p.amount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error('amount must be a number, 0 or more');
    if (CREDIT[p.method]) { // store credit: positive amount, an owner in K; given needs a reason, used needs the sale it paid
      if (!(amt > 0)) throw new Error('Store credit needs an amount more than $0.');
      if (!s(p.customer)) throw new Error('Store credit needs a customer.');
      if (p.method === 'credit_given' && !s(p.note)) throw new Error('Store credit needs a reason.');
      if (p.method === 'credit_used' && !s(p.txnId)) throw new Error('Store credit used needs the sale it paid.');
    }
    const at = (now ? new Date(now) : new Date()).toISOString();
    return [p.payment_id || newPaymentId(Date.parse(at)), s(p.invoice_number), s(p.txnId), isoDate(p.date) || honoluluToday(at),
      amt.toFixed(2), p.method, s(p.note), s(p.place), at, '', s(p.customer)];
  }
  function buildVoidRow(target, now, place) { // Undo of one payment: append, never delete
    const at = (now ? new Date(now) : new Date()).toISOString();
    return [newPaymentId(Date.parse(at)), target.invoice_number, target.txnId, honoluluToday(at), '0.00', target.method,
      'undo', s(place), at, target.payment_id, s(target.customer)];
  }
  // Undo for an invoice record: one void row for its NEWEST live payment (undo again for the one before).
  // Store credit: undoing credit_used gives the credit back; undoing a credit_given (an automatic move) brings back "Refund due $X".
  // A credit_given goes through undoCredit's spent check. opts: { paymentRows, records, ctx } as for creditBalances.
  function undoRows(record, now, place, opts) {
    const last = [...(record.paymentsLive || [])].sort(newestFirst)[0];
    if (!last) return [];
    return last.method === 'credit_given' ? [undoCredit(last, now, place, opts)] : [buildVoidRow(last, now, place)];
  }
  // undoCredit(row, now, place, { paymentRows, records, ctx }) -> the void row for one credit_given (a Give credit row has no sale, so
  // History undoes it here; undoRows uses it for automatic moves). Throws a plain sentence unless opts.paymentRows (the Payments tab,
  // read fresh) shows the owner's balance still holds the whole amount. row: a parsed Payments row (paymentRows / paymentsLive).
  function undoCredit(row, now, place, opts) {
    const o = opts || {};
    if (!o.paymentRows) throw new Error('Read the Payments tab again before undoing store credit.');
    const bal = creditBalances(o.paymentRows, o.records, o.ctx)[resolveCredit(row.customer, o.ctx)] || 0;
    const spent = cents(row.amount) - Math.max(0, bal);
    if (spent > 0) throw new Error(`${usd(spent)} of this store credit is already used, so it cannot be undone. Undo that store credit payment first.`);
    return buildVoidRow(row, now, place);
  }
  const paymentRows = rows => (rows || []).filter(r => r && s(r[0]) && s(r[0]) !== PAYMENT_COLUMNS[0]).map(r => { // blank or header out
    const o = {};
    PAYMENT_COLUMNS.forEach((c, i) => { o[c] = s(r[i]); });
    o.amount = money(o.amount);
    return o;
  });
  const parsePayments = rows => paymentRows(rows).filter(o => !MARKS[o.method]);
  // A mark: kind 'email_draft', 'edit', 'cancel', 'uncancel', 'print', 'pdf' (saved/downloaded) or 'pdf_open', amount 0, never a payment.
  function buildMarkRow(m, now) {
    if (!MARKS[m.kind]) throw new Error('mark must be email_draft, email_sent, edit, cancel, uncancel, print, pdf, pdf_open or paylink');
    const at = (now ? new Date(now) : new Date()).toISOString();
    return [m.id ? s(m.id) : 'mark_' + Date.parse(at).toString(36) + Math.random().toString(36).slice(2, 8), s(m.invoice_number), s(m.txnId),
      honoluluToday(at), '0.00', m.kind, s(m.note), s(m.place), at, '', ''];
  }
  const BEFORE = 'before:';
  // The note for an edit mark: the sale's Transactions rows before the edit. Over Sheets' cell limit: no copy (the edit still saves).
  const beforeNote = rows => { const t = BEFORE + JSON.stringify(rows || []); return t.length <= 45000 ? t : ''; };
  function parseMarks(rows) {
    const out = { drafts: {}, edits: {}, cancels: {}, before: {}, prints: {}, pdfs: {}, log: {}, sent: {}, paylinks: {}, editLog: {} };
    for (const o of paymentRows(rows)) {
      // Every edit mark with its time and the rows before it (null when it has no readable copy): the pay-link check (payLinkStale).
      if (o.method === 'edit' && o.txnId) {
        let before = null;
        if (o.note.startsWith(BEFORE)) { try { before = JSON.parse(o.note.slice(BEFORE.length)); } catch (_) { /* cut off: no copy */ } }
        (out.editLog[o.txnId] = out.editLog[o.txnId] || []).push({ at: o.recorded_at, date: o.date, rows: Array.isArray(before) ? before : null });
      }
      // An edit mark may carry the sale's rows as they were before that edit ("before:" + JSON): History shows that copy.
      if (o.method === 'edit' && o.txnId && o.note.startsWith(BEFORE)) {
        try { (out.before[o.txnId] = out.before[o.txnId] || []).push({ date: o.date, at: o.recorded_at, rows: JSON.parse(o.note.slice(BEFORE.length)) }); } catch (_) { /* a cut-off copy is skipped */ }
      }
      if (o.method === 'cancel' || o.method === 'uncancel') { // newest recorded_at wins; a later row wins a tie
        const prev = out.cancels[o.txnId];
        if (o.txnId && !(prev && prev.at > o.recorded_at)) out.cancels[o.txnId] = { cancelled: o.method === 'cancel', at: o.recorded_at, date: o.date };
        continue;
      }
      const key = o.txnId || o.invoice_number, bucket = out[MARKS[o.method]];
      if (o.method === 'paylink') { // newest recorded_at wins; the timeline lists each one
        const i = o.note.lastIndexOf('|'), prev = out.paylinks[key];
        if (key && i > 0 && !(prev && prev.recorded_at > o.recorded_at)) out.paylinks[key] = { url: o.note.slice(0, i), helcimInvoiceId: o.note.slice(i + 1), recorded_at: o.recorded_at };
        if (key) (out.log[key] = out.log[key] || []).push({ kind: o.method, date: o.date, at: o.recorded_at, place: o.place, note: o.note });
        continue;
      }
      // Every print, PDF and email draft, one entry each, for the timeline (log[key] = [{ kind, date, at, place, note }]).
      if (key && LOGGED.has(o.method)) (out.log[key] = out.log[key] || []).push({ kind: o.method, date: o.date, at: o.recorded_at, place: o.place, note: o.note });
      if (bucket && key && !(bucket[key] >= o.date)) bucket[key] = o.date;
    }
    return out;
  }
  // The contract the stock poll mirrors: txnIds whose newest cancel/uncancel mark is a cancel.
  const cancelledIds = rows => new Set(Object.entries(parseMarks(rows).cancels).filter(([, c]) => c.cancelled).map(([id]) => id));
  // What Helcim reports paid on an invoice that has a pay link, as at most one new Payments row (Trevor's rulings, 2026-11-04).
  // record: the derived invoice (needs balance, total, number, txnId). statusResult: one entry of the app's helcim.status results.
  // allPaymentRows: every Payments row (raw), live or voided, so a payment Trevor undid is never recorded again.
  // payment_id helcim_<helcimInvoiceId>_<appliedCents> is the same on every register, so two registers add it once (livePayments).
  // Returns { rows, needsLook }: needsLook is a plain sentence for the invoice, never written.
  function helcimPaymentRows(record, statusResult, allPaymentRows, place, now) {
    const none = { rows: [], needsLook: '' };
    if (!statusResult || !statusResult.ok) return { rows: [], needsLook: s(statusResult && statusResult.message) || 'Helcim could not be checked' };
    const hid = s(statusResult.helcimInvoiceId != null ? statusResult.helcimInvoiceId : record.helcimInvoiceId);
    const applied = Math.min(cents(Number(statusResult.amountPaid) || 0), cents(record.total));
    const prefix = `helcim_${hid}_`;
    const mine = paymentRows(allPaymentRows).filter(o => o.payment_id.startsWith(prefix));
    const prev = mine.reduce((a, o) => Math.max(a, parseInt(o.payment_id.slice(prefix.length), 10) || 0), 0);
    if (applied <= prev) return none;
    if (s(statusResult.invoiceNumber) !== s(record.number)) return { rows: [], needsLook: 'Helcim number does not match' };
    const amount = applied - prev;
    if (amount > cents(record.balance)) return { rows: [], needsLook: 'Helcim paid more than the balance' };
    const named = new Set(mine.flatMap(o => o.note.split(/[^A-Za-z0-9]+/)));
    const fresh = (statusResult.cardTxns || []).map(c => s(c && c.id)).filter(id => id && !named.has(id));
    const card = fresh.length > 0;
    const note = `${card ? 'Card ' + fresh.join(', ') : 'Bank transfer'}. Helcim invoice ${hid}`;
    return { rows: [buildPaymentRow({ payment_id: prefix + applied, invoice_number: record.number, txnId: record.txnId, amount: amount / 100,
      method: card ? 'helcim_card' : 'helcim_ach', note, place }, now)], needsLook: '' };
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
  function derive(txns, payments, today, drafts, cancels, editLog) { // cancels, editLog: parseMarks(...).cancels / .editLog
    today = todayIso(today);
    payments = payments || [];
    const live = livePayments(payments);
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
      const gone = cancels && cancels[t.txnId] && cancels[t.txnId].cancelled ? cancels[t.txnId] : null;
      const mine = (ids, nums) => live.filter(p => ids.has(p.txnId) || (!p.txnId && nums.has(p.invoice_number)));
      if (kind === 'quote') { // a deposit on a quote (Trevor, Nov 1): payment rows on the quote; the sale made from it counts them
        r.paymentsLive = mine(new Set([t.txnId]), new Set(t.number ? [t.number] : []));
        r.deposit = Math.min(r.paymentsLive.reduce((a, p) => a + cents(p.amount), 0), cents(t.total)) / 100;
      }
      if (kind === 'receipt') r.creditUsed = live.filter(p => p.method === 'credit_used' && p.txnId === t.txnId).reduce((a, p) => a + cents(p.amount), 0) / 100;
      if (kind !== 'invoice') { r.state = gone ? 'cancelled' : kind; if (gone) r.cancelledAt = gone.date; return r; }
      const ids = new Set(), nums = new Set();
      for (const c of chain(t)) {
        ids.add(c.txnId); if (c.number) nums.add(c.number);
        const q = byId.get(c.fromQuote); // the quote this invoice was made from: its deposit counts here
        if (q && q.docType === 'quote') { ids.add(q.txnId); if (q.number) nums.add(q.number); }
      }
      r.paymentsLive = mine(ids, nums);
      const latest = r.paymentsLive.filter(p => p.method !== 'credit_given').sort(newestFirst)[0];
      const sum = Math.max(0, r.paymentsLive.reduce((a, p) => a + signedCents(p), 0)); // partial payments add up; credit_given takes off
      const sumOf = m => r.paymentsLive.filter(p => p.method === m).reduce((a, p) => a + cents(p.amount), 0);
      r.movedToCredit = sumOf('credit_given') / 100; // dollars, like paid / overpaid
      r.movedText = r.movedToCredit > 0 ? 'Moved ' + usd(cents(r.movedToCredit)) + ' to store credit' : '';
      r.creditUsed = sumOf('credit_used') / 100;
      // Automatic moves ever written for THIS sale (live or undone): autoCreditRow's id index. creditUndone: staff undid the NEWEST one
      // and the sale has not been edited since that Undo (a newer 'edit' mark in editLog means a new overpay, which moves again).
      const autoRows = payments.filter(p => p.method === 'credit_given' && !p.voids && p.txnId === t.txnId);
      const newestAuto = [...autoRows].sort(newestFirst)[0];
      const undoAt = newestAuto ? payments.filter(p => p.voids === newestAuto.payment_id).map(p => p.recorded_at).sort().pop() : '';
      const editAt = ((editLog || {})[t.txnId] || []).map(e => s(e.at)).sort().pop() || '';
      r.lastEditAt = editAt; // newest 'edit' mark (ISO): History shows "Store credit due" only for an overpay from an edit after the credit release
      r.creditMoves = new Set(autoRows.map(p => p.payment_id)).size;
      r.creditUndone = !!undoAt && !(editAt > undoAt);
      r.paid = Math.min(sum, cents(t.total)) / 100;
      r.overpaid = Math.max(0, sum - cents(t.total)) / 100; // more taken than the total (an edit lowered it): Refund due
      r.paidDate = latest ? latest.date : '';
      r.paidMethod = latest ? latest.method : '';
      r.balance = Math.max(0, (cents(t.total) - sum) / 100);
      r.dueDate = t.date ? addDays(t.date, NET_DAYS) : '';
      const next = replacedBy.get(t.txnId);
      if (next) { r.state = 'void'; r.replacedBy = next.number || next.txnId; r.balance = 0; r.overpaid = 0; return r; }
      if (gone) { r.state = 'cancelled'; r.cancelledAt = gone.date; r.balance = 0; return r; }
      if (r.balance <= 0) { r.state = 'paid'; return r; }
      // Trevor: money owed on invoices dated before 2026 is never tallied or flagged; it shows only on that invoice.
      if (t.date && t.date < COUNT_FROM) { r.state = 'old'; return r; }
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
      (qd.length >= 3 && (r._ph != null ? r._ph : r.phone.replace(/\D/g, '')).includes(qd)));
  }

  // ---- QuickBooks history (read-only; Drive "MPE QuickBooks History.json.gz") ----
  // qboRecords(json) maps once per download into History's record shape, source 'qbo', with the lowercase search strings
  // built here (a search then only calls includes()). addQbo(model, mapped, today) merges and derives the state per load.
  const QBO_TITLES = { invoice: 'Invoice', quote: 'Quote', receipt: 'Receipt' };
  function qboRecords(json) {
    const out = [];
    for (const q of (json && json.records) || []) {
      const kind = q.kind === 'invoice' || q.kind === 'quote' ? q.kind : q.kind === 'receipt' ? 'receipt' : '';
      if (!kind) continue;
      const lines = (Array.isArray(q.lines) ? q.lines : []).map(s).filter(Boolean);
      const street = lines.join(', ');
      const items = (q.items || []).map(i => ({ pn: s(i.pn), desc: s(i.desc), qty: s(i.qty), ea: money(i.ea), sub: money(i.sub),
        serials: (i.serials || []).map(x => s(x).toUpperCase()).filter(Boolean), origEa: 0, off: 0 }));
      const number = s(q.number), name = s(q.name), company = s(q.company), phone = s(q.phone), email = s(q.email);
      const r = {
        source: 'qbo', txnId: s(q.txnId) || 'qbo:' + s(q.qboId), customerId: s(q.customerId), number, docType: kind, kind, date: isoDate(q.date), time: '',
        name, company, street, addrLines: lines, city: s(q.city), region: s(q.state), zip: s(q.zip),
        addr: [street, s(q.city), s(q.state), s(q.zip)].filter(Boolean).join(', '), phone, email,
        total: money(q.total), tax: money(q.tax), fromQuote: '', items, presell: false, contactConflict: false, completedContact: null,
        qboStatus: s(q.status).toLowerCase(), qboBalance: money(q.balance), qboDue: isoDate(q.dueDate), qboExpires: isoDate(q.expires),
        draftMade: false, draftText: '', paymentsLive: [], _ph: phone.replace(/\D/g, ''),
      };
      r._hay = [r.txnId, number, r.date, name, company, phone, email, r.addr, s(q.total), QBO_TITLES[kind],
        ...items.flatMap(i => [i.pn, i.desc, i.serials.join(' ')])].filter(Boolean).join(' ').toLowerCase();
      r._serialHay = items.flatMap(i => i.serials).map(alnum).filter(Boolean).join(' ');
      out.push(r);
    }
    return out;
  }
  // Money owed: only an open QuickBooks invoice dated 2026-01-01 or later counts (state unpaid/dueSoon/overdue, due date = QuickBooks'
  // dueDate). Earlier ones are 'old' (never tallied, no red). Void is 'void' with no replacement. Nothing here touches Payments.
  function qboState(r, today) {
    if (r.kind !== 'invoice') { r.state = r.kind; return r; }
    const total = cents(r.total), left = Math.max(0, cents(r.qboBalance));
    r.dueDate = r.qboDue || (r.date ? addDays(r.date, NET_DAYS) : '');
    r.daysLate = 0; r.paidDate = ''; r.paidMethod = '';
    if (r.qboStatus === 'void') { r.state = 'void'; r.balance = 0; r.paid = 0; return r; }
    if (r.qboStatus === 'paid' || left <= 0) { r.state = 'paid'; r.balance = 0; r.paid = r.total; return r; }
    r.balance = left / 100; r.paid = Math.max(0, (total - left) / 100);
    if (r.date && r.date < COUNT_FROM) { r.state = 'old'; return r; }
    const days = r.dueDate ? dayNum(r.dueDate) - dayNum(today) : Infinity;
    r.daysLate = days < 0 ? -days : 0;
    r.state = days < 0 ? 'overdue' : days <= SOON_DAYS ? 'dueSoon' : 'unpaid';
    return r;
  }
  // A counter document made before Oct 31 is on the sheet AND in QuickBooks with the same number: keep the sheet one, but an owing
  // sheet invoice takes QuickBooks' payments (Trevor, Nov 1: paid in QuickBooks showed red). Many counter "invoices" went to
  // QuickBooks as a paid sales receipt with the same number: that receipt marks the invoice paid and is not shown twice.
  // Copies, so a re-merge starts clean.
  const OWING = new Set(['unpaid', 'dueSoon', 'overdue', 'old']);
  function mergeQbo(sheet, mapped, today) {
    today = todayIso(today);
    const key = r => r.kind + '|' + s(r.number).toLowerCase();
    const have = new Set(sheet.filter(r => r.number).map(key));
    const qBy = kind => new Map(mapped.filter(r => r.kind === kind && r.number).map(r => [s(r.number).toLowerCase(), r]));
    const qInv = qBy('invoice'), qRcpt = qBy('receipt'), used = new Set();
    addQboBuyers(sheet, mapped);
    const merged = sheet.map(r => {
      if (r.kind !== 'invoice' || !OWING.has(r.state) || !r.number) return r;
      const n = s(r.number).toLowerCase(), q = qInv.get(n), rc = q ? null : qRcpt.get(n);
      if (rc) { used.add(rc); return { ...r, state: 'paid', paidInQbo: true, balance: 0, paid: r.total, daysLate: 0 }; }
      if (!q) return r;
      const left = Math.max(0, cents(q.qboBalance));
      if (q.qboStatus === 'void' || q.qboStatus === 'paid' || left <= 0)
        return { ...r, state: 'paid', paidInQbo: true, balance: 0, paid: r.total, daysLate: 0 };
      if (left >= cents(r.balance) || cents(q.total) !== cents(r.total)) return r; // part paid: only the same document (same total)
      return { ...r, paidInQbo: true, balance: left / 100, paid: Math.max(0, (cents(r.total) - left) / 100) };
    });
    const extra = [];
    for (const r of mapped) if (!used.has(r) && !(r.number && have.has(key(r)))) extra.push(qboState(r, today));
    return merged.concat(extra);
  }
  // Display-only "QuickBooks buyer": a register sale (not a quote) with no buyer, or the Jana Yamashiro placeholder, whose serials
  // (uppercase letters and digits, 4+ characters) appear in exactly ONE QuickBooks invoice or receipt (never an estimate) gets
  // r.qboBuyer = { name, customerId } and that name in its search text. Two or more different documents: nothing. One pass builds
  // serial -> documents; nothing is written anywhere. Idempotent: a reload recomputes from the untouched base search text.
  const PLACEHOLDER_BUYER = 'jana yamashiro';
  const snKey = v => s(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  function addQboBuyers(sheet, mapped) {
    const docs = new Map(); // serial key -> Map(txnId -> record)
    for (const q of mapped) {
      if (q.kind === 'quote') continue;
      for (const i of q.items) for (const x of i.serials) {
        const k = snKey(x);
        if (k.length < 4) continue;
        if (!docs.has(k)) docs.set(k, new Map());
        docs.get(k).set(q.txnId, q);
      }
    }
    for (const r of sheet) {
      if (r._hayBase == null) r._hayBase = r._hay;
      r._hay = r._hayBase;
      r.qboBuyer = null;
      if (r.source === 'qbo' || r.kind === 'quote' || !docs.size) continue;
      if (![r.name, r.company].filter(Boolean).every(x => x.toLowerCase() === PLACEHOLDER_BUYER)) continue; // an entered buyer stays
      const hit = new Map();
      for (const i of r.items) for (const x of i.serials) for (const [id, q] of docs.get(snKey(x)) || []) hit.set(id, q);
      const q = hit.size === 1 ? [...hit.values()][0] : null, name = q && (q.company || q.name);
      if (!name) continue;
      r.qboBuyer = { name, customerId: q.customerId };
      r._hay = r._hayBase + ' ' + name.toLowerCase();
    }
  }

  // ---- Customers ----
  const CUSTOMER_COLUMNS = Object.freeze(['Company', 'Contact', 'Phone', 'Email', 'Street', 'City', 'State', 'Zip', 'Added', 'QBO Id']);
  // The register's customer key (POS/index.html custIndex(): 'p:' + phone digits, a leading 1 dropped, + '|' + lowercased company-or-name).
  // Copied, not shared: if the register's rule changes, change this too.
  const digits10 = v => s(v).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const customerKey = (phone, company, name) => { const pd = digits10(phone); return (pd ? 'p:' + pd : '') + '|' + s(company || name).toLowerCase(); };
  // "Added" as the register writes it (new Date().toLocaleString(), en-US), read in the shop's own time zone.
  const addedText = now => new Date(now == null ? Date.now() : now).toLocaleString('en-US', { timeZone: 'Pacific/Honolulu' });
  // One Customers-tab row from the edit form: the 9 register columns + J. J is the QuickBooks id when the customer has one. A customer
  // with no QuickBooks id has J blank, except when the edit changes its register key (phone or company): then J holds the customer's
  // own group id ('k:' + old key, from buildCustomers) so the edited row stays with the same customer and its records.
  function buildCustomerRow(f, ref, now) {
    const row = [f.company, f.name, f.phone, f.email, f.street, f.city, f.region, f.zip].map(s);
    if (!row[0] && !row[1]) throw new Error('A customer needs a name or a company');
    return [...row, addedText(now), s(ref)];
  }
  // Rows (the tab, header allowed) -> { company, name, phone, email, street, city, region, zip, added (ISO), qboId, order }.
  function parseCustomerRows(rows) {
    const out = [];
    (rows || []).forEach((r, order) => {
      if (!r || (order === 0 && s(r[0]).toLowerCase() === 'company') || !(s(r[0]) || s(r[1]))) return;
      out.push({ company: s(r[0]), name: s(r[1]), phone: s(r[2]), email: s(r[3]), street: s(r[4]), city: s(r[5]), region: s(r[6]), zip: s(r[7]),
        added: isoDate(r[8]), ref: s(r[9]), order });
    });
    return out;
  }
  const newerRow = (a, b) => (b.added > a.added || (b.added === a.added && b.order > a.order) ? b : a);
  const joinAddr = c => [c.street, [c.city, c.region, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); // display only
  // qbo: the file's customers array; sheetRows: Customers tab rows; records: model.records (QuickBooks merged in, states derived).
  // Returns customers, newest activity first: contact fields, addr (display), balance / overdue (owed rule), records (unsorted), edited.
  // The grouping both buildCustomers and store credit use: QuickBooks customers, then Customers-tab rows with J (renames), then
  // rows without J. alias: register key -> group ({ id: 'q:<id>' | 'k:<key>' }).
  function customerGroups(qbo, sheetRows) {
    const groups = new Map(), alias = new Map();
    const make = (id, qboId) => { let g = groups.get(id); if (!g) { g = { id, qboId, q: null, rows: [], records: [] }; groups.set(id, g); } return g; };
    const claim = (key, g) => { if (key !== '|' && !alias.has(key)) alias.set(key, g); return g; };
    const byKey = key => alias.get(key) || claim(key, make('k:' + key, ''));
    for (const q of qbo || []) {
      const id = s(q.id);
      if (!id) continue;
      const g = make('q:' + id, id);
      g.q = q;
      claim(customerKey(q.phone || q.mobile, q.company, q.name), g);
    }
    const sheet = parseCustomerRows(sheetRows);
    for (const row of sheet) if (row.ref) {
      const own = row.ref.startsWith('k:'); // a customer with no QuickBooks id, edited to a new key
      const g = make(own ? row.ref : 'q:' + row.ref, own ? '' : row.ref);
      g.rows.push(row);
      claim(customerKey(row.phone, row.company, row.name), g);
      if (own) claim(row.ref.slice(2), g);
    }
    for (const row of sheet) if (!row.ref) {
      const key = customerKey(row.phone, row.company, row.name);
      if (key !== '|') byKey(key).rows.push(row);
    }
    return { groups, alias, make, byKey };
  }
  function buildCustomers({ qbo, sheetRows, records }) {
    const { groups, make, byKey } = customerGroups(qbo, sheetRows);
    const qLines = q => (Array.isArray(q.lines) ? q.lines : []).map(s).filter(Boolean);
    for (const r of records || []) {
      const cid = r.source === 'qbo' ? s(r.customerId) : r.kind === 'receipt' && r.qboBuyer ? s(r.qboBuyer.customerId) : ''; // W3b: a matched register sale joins that customer
      if (cid) { make('q:' + cid, cid).records.push(r); continue; }
      if (s(r.name).toLowerCase() === PLACEHOLDER_BUYER && !s(r.company) && !s(r.phone)) continue; // the placeholder buyer is nobody's customer
      const key = customerKey(r.phone, r.company, r.name);
      if (key !== '|') byKey(key).records.push(r);
    }
    const out = [];
    for (const g of groups.values()) {
      let last = '', seen = null, buyer = null;
      for (const r of g.records) {
        if (r.date > last) last = r.date;
        if (r.source !== 'qbo' && r.qboBuyer) { buyer = buyer || r.qboBuyer; continue; } // its own contact is the placeholder: never names a customer
        if (!seen || (r.date || '') > (seen.date || '')) seen = r;
      }
      const row = g.rows.length ? g.rows.reduce(newerRow) : null;
      for (const r of g.rows) if (r.added > last) last = r.added;
      const q = g.q;
      const from = row || (q && { company: s(q.company), name: [s(q.given), s(q.family)].filter(Boolean).join(' ') || (s(q.company) ? '' : s(q.name)),
        phone: s(q.phone || q.mobile), email: s(q.email), street: qLines(q).join(', '), city: s(q.city), region: s(q.state), zip: s(q.zip) })
        || (seen && { company: seen.company, name: seen.name, phone: seen.phone, email: seen.email, street: seen.street, city: seen.city,
          region: s(seen.region) || '', zip: seen.zip }) || (buyer && { name: s(buyer.name) }) || {};
      if (!(s(from.company) || s(from.name))) continue; // nothing to call it by
      const c = { id: g.id, txnId: g.id, qboId: g.qboId, company: s(from.company), name: s(from.name), phone: s(from.phone), email: s(from.email),
        street: s(from.street), city: s(from.city), region: s(from.region), zip: s(from.zip), edited: !!row, inactive: !!(q && q.active === false),
        last, count: g.records.length, records: g.records };
      const owed = owedSummary(g.records);
      c.balance = owed.total; c.overdue = owed.overdue;
      c.addr = joinAddr(c);
      c._hay = [c.company, c.name, c.phone, c.email, ...(q ? [q.name, q.company, q.given, q.family, q.phone, q.mobile, q.email] : []),
        ...g.rows.flatMap(x => [x.company, x.name, x.phone, x.email])].map(s).filter(Boolean).join(' ').toLowerCase();
      c._ph = [c.phone, q && q.phone, q && q.mobile, ...g.rows.map(x => x.phone)].map(digits10).filter(Boolean).join(' ');
      out.push(c);
    }
    return out.sort((a, b) => lt(b.last, a.last) || lt((a.company || a.name).toLowerCase(), (b.company || b.name).toLowerCase()));
  }
  const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---- Store credit (Payments methods credit_given / credit_used; column K = owner; the balance is never stored) ----
  // ctx everywhere below: the same { qbo, sheetRows } object History passes to buildCustomers (optional; without it no renames resolve).
  const aliasMemo = new WeakMap();
  const aliasOf = ctx => {
    if (!ctx || typeof ctx !== 'object') return new Map();
    if (!aliasMemo.has(ctx)) aliasMemo.set(ctx, customerGroups(ctx.qbo, ctx.sheetRows).alias);
    return aliasMemo.get(ctx);
  };
  // A stored K read today: a register key that a QuickBooks customer or a Customers-tab rename has since claimed moves to that group.
  const resolveCredit = (k, ctx) => { k = s(k); const g = k.startsWith('k:') && aliasOf(ctx).get(k.slice(2)); return g ? g.id : k; };
  // creditKey(who, ctx) -> column K for a customer, '' when there is none. who: a customer (buildCustomers), a record, or the register's
  // fields ({ qboId | customerId, phone, company, name }). QuickBooks id -> 'q:<id>'; else the register key through the same alias map
  // as buildCustomers, so the value equals that customer's buildCustomers id. Blank buyer or the Jana placeholder -> ''.
  // History and the register call only this.
  function creditKey(who, ctx) {
    const w = who || {}, qid = s(w.qboId || w.customerId);
    if (qid) return 'q:' + qid;
    if (!(s(w.name) || s(w.company)) || isPlaceholderBuyer(w)) return '';
    const key = customerKey(w.phone, w.company, w.name), g = aliasOf(ctx).get(key);
    return g ? g.id : 'k:' + key;
  }
  // creditBalances(paymentRows, records, ctx) -> { [creditKey]: cents }: live credit_given minus live credit_used per owner. Negative =
  // overdrawn (show "Credit overdrawn -$X"). a cancelled sale undoes all it did to credit (its credit_used comes back, its automatic credit_given drops): its txnId has a cancel
  // mark, or it is a live payment of a cancelled record (records: derived, optional; this covers a cancelled replacement invoice).
  // A void (replaced) invoice passes its payments to its replacement, so credit used on it stays spent there: nothing counts twice.
  function creditBalances(rows, records, ctx) {
    const live = livePayments(paymentRows(rows).filter(o => CREDIT[o.method]));
    const gone = cancelledIds(rows), back = new Set();
    for (const r of records || []) if (r.state === 'cancelled') {
      gone.add(r.txnId);
      for (const p of r.paymentsLive || []) back.add(p.payment_id);
    }
    const out = {};
    for (const p of live) {
      const k = resolveCredit(p.customer, ctx);
      if (!k || back.has(p.payment_id) || gone.has(p.txnId)) continue; // Give credit rows have no txnId and always count
      out[k] = (out[k] || 0) + (p.method === 'credit_given' ? 1 : -1) * cents(p.amount);
    }
    return out;
  }
  // creditCap(freshRows, key, dueCents, records, ctx) -> the most credit_used cents allowed now: min(balance, amount due), never below 0.
  const creditCap = (rows, key, dueCents, records, ctx) =>
    Math.max(0, Math.min(creditBalances(rows, records, ctx)[resolveCredit(key, ctx)] || 0, Math.round(Number(dueCents) || 0)));
  // autoCreditRow(record, overpaidCents, customerKey, now, place) -> the automatic credit_given row for an edit that overpaid a sale, or
  // null (nothing over, or no customer). record: derived from fresh rows AFTER the save. Fixed id credit_<txnId>, so two registers
  // write it once; a later edit that overpays again gets credit_<txnId>_2, _3... (record.creditMoves), so it is not lost.
  function autoCreditRow(record, overpaidCents, key, now, place) {
    const c = Math.round(Number(overpaidCents) || 0);
    if (!(c > 0) || !s(key) || !record || !s(record.txnId)) return null;
    const n = record.creditMoves || 0;
    return buildPaymentRow({ payment_id: 'credit_' + record.txnId + (n ? '_' + (n + 1) : ''), invoice_number: record.number, txnId: record.txnId,
      amount: c / 100, method: 'credit_given', note: 'Overpaid after edit of ' + (s(record.number) || record.txnId), place, customer: key }, now);
  }
  // creditUseRow(sale, amountCents, customerKey, now, place) -> one credit_used row paying sale ({ txnId, number, kind }). A receipt
  // (the register) gets the fixed id credit_used_<receipt txnId>; an invoice (History Take payment) a new id each time. Cap it first (creditCap).
  function creditUseRow(sale, amountCents, key, now, place) {
    const receipt = sale.kind !== 'invoice' && sale.kind !== 'quote', at = Date.parse((now ? new Date(now) : new Date()).toISOString());
    return buildPaymentRow({ payment_id: receipt ? 'credit_used_' + s(sale.txnId) : newPaymentId(at).replace(/^pay_/, 'credit_used_'),
      invoice_number: sale.number, txnId: sale.txnId, amount: Math.round(Number(amountCents) || 0) / 100, method: 'credit_used',
      note: 'Store credit', place, customer: key }, now);
  }
  // pendingCreditMoves(records, ctx) -> [{ record, key, cents }]: sales that show Refund due, now have a customer and were never undone
  // by staff. History writes autoCreditRow for each on load (the retry when the credit row failed or the customer came later).
  const pendingCreditMoves = (records, ctx) => (records || []).flatMap(r => {
    if (r.kind !== 'invoice' || r.source === 'qbo' || r.state === 'void' || r.state === 'cancelled' || r.creditUndone) return [];
    const c = cents(r.overpaid || 0), key = c > 0 ? creditKey(r, ctx) : '';
    return key ? [{ record: r, key, cents: c }] : [];
  });

  // One call for the page: rows in, ready model out. displayRows: optional (defaults to the page's
  // MPETransactionContact.displayRows) so CUSTOMER_UPDATE fixes and conflict flags match History.
  async function create({ txnRows, paymentRows, drafts, today, displayRows }) {
    const owner = typeof globalThis === 'object' ? globalThis.MPETransactionContact : null;
    const fn = displayRows || (owner && owner.displayRows && (rows => owner.displayRows(rows)));
    let rows = txnRows, states = null;
    if (fn) { const d = await fn(txnRows); rows = d.rows; states = d.states; }
    const marks = parseMarks(paymentRows);
    const records = derive(parseTransactions(rows, states), parsePayments(paymentRows), today, drafts, marks.cancels, marks.editLog);
    const model = {
      records,
      list: (name, query) => search(filter(model.records, name), query),
      owedSummary: () => owedSummary(model.records),
      search: q => search(model.records, q),
      // Merge mapped QuickBooks records (qboRecords) in; model.records is a new array afterwards.
      addQbo(mapped, now) { model.records = mergeQbo(records, mapped || [], now || today); return model.records; },
    };
    return model;
  }

  // ---- Missing info (F02): register sales that sold a serial-numbered item but lack a buyer or one contact field. Read-only; writes nothing.
  // field: 'any' | 'name' | 'phone' | 'address' | 'email'. Quotes, void/cancelled and QuickBooks-only records never qualify.
  // A name is missing when name and company are blank, or the register's stand-in buyer (D10) with no company or phone.
  const isPlaceholderBuyer = r => s(r.name).toLowerCase() === PLACEHOLDER_BUYER && !s(r.company) && !s(r.phone);
  const MISSING_TESTS = {
    name: r => isPlaceholderBuyer(r) || !(s(r.name) || s(r.company)),
    phone: r => !s(r.phone), email: r => !s(r.email), address: r => !s(r.street) && !s(r.city),
  };
  function missingInfo(records, field) {
    const tests = field && MISSING_TESTS[field] ? [MISSING_TESTS[field]] : Object.values(MISSING_TESTS);
    return records.filter(r => r.source !== 'qbo' && r.kind !== 'quote' && r.state !== 'void' && r.state !== 'cancelled'
      && (r.items || []).some(i => (i.serials || []).some(x => s(x))) && tests.some(t => t(r)));
  }
  // F04 / C4: "Emailed <date>, changed since". Returns the email's date (YYYY-MM-DD) when the newest edit is newer than the newest email_sent, else ''.
  // Full recorded_at on both sides: compare them. Either side date-only (older marks): changed only if the edit's date is later than the email's.
  // Ties, missing marks, an email_draft alone and any malformed time or date: no label. Marks keyed by the old document number still count.
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  function emailedChangedSince(r, marks) {
    const m = marks || {}, keys = [r.txnId, r.number].filter(Boolean);
    const pick = (src) => keys.flatMap(k => (src && src[k]) || []);
    const sent = pick(m.log).filter(e => e.kind === 'email_sent').map(e => ({ at: s(e.at), date: s(e.date) || s(e.at).slice(0, 10) }));
    if (!sent.length) for (const k of keys) if (m.sent && m.sent[k]) sent.push({ at: '', date: s(m.sent[k]) }); // legacy: date only
    const edits = pick(m.before).map(e => ({ at: s(e.at), date: s(e.date) || s(e.at).slice(0, 10) }));
    for (const k of keys) if (m.edits && m.edits[k]) edits.push({ at: '', date: s(m.edits[k]) });
    if (!sent.length || !edits.length) return '';
    const bad = e => (e.at && Number.isNaN(Date.parse(e.at))) || !DAY.test(e.date);
    if (sent.some(bad) || edits.some(bad)) return '';
    const newest = list => list.reduce((a, b) => (!a || (a.at && b.at ? Date.parse(b.at) > Date.parse(a.at) : b.date > a.date) ? b : a), null);
    const mail = newest(sent), edit = newest(edits);
    const changed = mail.at && edit.at ? Date.parse(edit.at) > Date.parse(mail.at) : edit.date > mail.date;
    return changed ? mail.date : '';
  }
  // ---- Item edits in History (F03, C3 money; integer cents) ----
  const usd = c => '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const liveCents = r => (r.paymentsLive || []).reduce((a, p) => a + signedCents(p), 0);
  // The panel's line for an invoice that took more than its total: 'Store credit due $X' (plus ' · add a customer' with no buyer), else ''.
  // Trevor (Nov 5): never "refund"; an overpayment is store credit.
  const refundDue = r => (r && r.kind === 'invoice' && r.state !== 'void' && r.state !== 'cancelled' && cents(r.overpaid || 0) > 0
    ? 'Store credit due ' + usd(cents(r.overpaid)) + ((s(r.company) || s(r.name)) && !isPlaceholderBuyer(r) ? '' : ' · add a customer') : '');
  // The Editing bar's money line for record (as loaded, before the edit) at a new total. Paid before the edit is the record's own paid
  // (QuickBooks-recognized paid included) plus anything already over the total (R7); it is never recomputed from the new total.
  // Returns { kind, cents, text }. Overpaid (D18): kind 'credit', "Becomes store credit $X" when there is a customer, else
  // "Add a customer to keep $X as credit" (needsCustomer: true; saved that way the panel shows refundDue's "Refund due $X").
  // customer: the fields the edit's customer editor holds now (optional; defaults to the record's own buyer).
  function editMoney(r, newTotalCents, originalTotalCents, customer) {
    const now = Math.round(Number(newTotalCents)), was = Number.isFinite(Number(originalTotalCents)) ? Math.round(Number(originalTotalCents)) : cents(r.total);
    if (!Number.isFinite(now)) return { kind: 'unknown', cents: 0, text: '' };
    if (r.kind === 'invoice') {
      const paid = cents(r.paid || 0) + cents(r.overpaid || 0);
      if (paid <= 0) return { kind: 'newTotal', cents: now, text: 'New total ' + usd(now) };
      if (paid > now) return creditKey(customer || r) ? { kind: 'credit', cents: paid - now, text: 'Becomes store credit ' + usd(paid - now) }
        : { kind: 'credit', cents: paid - now, text: 'Add a customer to keep ' + usd(paid - now) + ' as credit', needsCustomer: true };
      return now === paid ? { kind: 'paid', cents: 0, text: 'Paid in full' } : { kind: 'owed', cents: now - paid, text: 'Still owed ' + usd(now - paid) };
    }
    if (r.kind === 'quote') {
      const dep = liveCents(r);
      if (dep <= 0) return { kind: 'newTotal', cents: now, text: 'New total ' + usd(now) };
      return dep > now ? { kind: 'depositExceeds', cents: dep - now, text: 'Deposit exceeds total, ' + usd(dep - now) } : { kind: 'balance', cents: now - dep, text: 'Balance due ' + usd(now - dep) };
    }
    const d = now - was;
    return { kind: 'difference', cents: d, text: 'Difference ' + (d > 0 ? '+' : d < 0 ? '-' : '') + usd(d) };
  }
  // R5 / A5: a pay link is stale when an edit after it changed the total. The total when the link was made is the before-rows TXN
  // total (column M) of the FIRST edit after the link; it is compared with the current total. An edit after the link with no readable
  // copy (or a date-only legacy edit dated after the link's day) counts as stale: the total cannot be proved.
  function payLinkStale(r, marks) {
    const m = marks || {}, link = (m.paylinks || {})[r.txnId] || (m.paylinks || {})[r.number];
    if (!link) return false;
    const linkAt = Date.parse(link.recorded_at);
    if (!Number.isFinite(linkAt)) return false;
    const log = (m.editLog || {})[r.txnId] || [];
    if (log.some(e => !Number.isFinite(Date.parse(e.at)) && s(e.date) > honoluluToday(linkAt))) return true; // date-only edit after the link's day
    const after = log.filter(e => Date.parse(e.at) > linkAt).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!after.length) return !log.length && !!(m.edits && m.edits[r.txnId] > honoluluToday(linkAt));
    const txn = (after[0].rows || []).find(row => s(row && row[0]).toUpperCase() === 'TXN');
    return !txn || cents(money(txn[12])) !== cents(r.total);
  }
  return { CREDIT_LABELS, creditKey, resolveCredit, creditBalances, creditCap, undoCredit, autoCreditRow, creditUseRow, pendingCreditMoves, refundDue, editMoney, payLinkStale, missingInfo, emailedChangedSince, isPlaceholderBuyer, transactionRowsFingerprint, transactionBlockEnd, NET_DAYS, SOON_DAYS, METHODS, PAYMENT_COLUMNS, parseTransactions, parsePayments, parseMarks, cancelledIds, buildMarkRow, buildPaymentRow, helcimPaymentRows,
    buildVoidRow, beforeNote, undoRows, honoluluToday, qboRecords, mergeQbo, COUNT_FROM, CUSTOMER_COLUMNS, customerKey, buildCustomerRow, parseCustomerRows, buildCustomers, livePayments, derive, filter, owedSummary, search, create };
});
