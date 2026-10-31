'use strict';

// Fills POS/document-template.html (the one shared template) with a sale: the counter's copy of Ledger's
// render_official_html (Ledger/tools/ledger_recipient_document.py). Pure: no file, no network, no Electron. The markup comes
// from the template; this file only works out the values. Keep it line for line with the Python, because
// test/document-renderer.test.js requires byte-identical output for the cases in Ledger/tests/fixtures/document_parity.json.

const PIECE = /<template data-name="([^"]+)">\n([\s\S]*?)\n<\/template>/g;
const SLOT = /\{\{(\w+)\}\}/g;

const TEXT_FIELDS = ['shop_name', 'address_1', 'address_2', 'phone', 'email', 'invoice_footer_1', 'invoice_footer_2', 'quote_footer',
  'receipt_footer', 'default_terms', 'closing'];
// The wording used until the counter has a saved copy of Ledger's Document settings: Ledger's own defaults
// (Ledger/tools/ledger_document_settings.py). The parity test renders with these and compares to Ledger's bytes.
const DEFAULT_SETTINGS = Object.freeze({
  shop_name: 'Maui Power Equipment',
  address_1: '970 Lower Main St',
  address_2: 'Wailuku, HI 96793',
  phone: '(808) 249-2730',
  email: 'info@mauipowerequipment.com',
  invoice_footer_1: 'Please either pay via the link (surcharge added for credit cards) or send a check made payable to:',
  invoice_footer_2: 'Maui Power Equipment Inc., 970 Lower Main St, Wailuku HI 96793',
  quote_footer: 'Quotes are valid for {valid_days} days from issued date. However, Maui Power Equipment maintains the right to adjust prices in response to extreme increases in product or freight cost.',
  receipt_footer: '',
  default_terms: 'Net 30',
  closing: 'Mahalo for your business.',
  quote_valid_days: 30,
  style: 'counter',
});
const GE_TAX_LABEL = 'GE tax (4.712%)';
const TITLES = Object.freeze({ invoice: 'Invoice', quote: 'Quote', receipt: 'Receipt' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EXTRA_LIMITS = { po: 200, terms: 200, ordered_by: 200, bill_to: 500, paid: 20, revised_on: 10, valid_until: 10 };

class DocumentRenderError extends Error {}

function parseTemplate(text) {
  const pieces = new Map();
  for (const match of String(text).matchAll(PIECE)) pieces.set(match[1], match[2]);
  return pieces;
}

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ---- exact decimals (Python's Decimal): an integer count of 10^-scale ----
function dec(value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) throw new DocumentRenderError('Amount is not a plain decimal');
  const fraction = match[3] || '';
  return { n: BigInt(match[1] + match[2] + fraction), scale: fraction.length };
}
const align = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return [a.n * 10n ** BigInt(scale - a.scale), b.n * 10n ** BigInt(scale - b.scale), scale];
};
const isZero = (a) => a.n === 0n;
const isOne = (a) => a.n === 10n ** BigInt(a.scale);
const mul = (a, b) => ({ n: a.n * b.n, scale: a.scale + b.scale });
const sub = (a, b) => { const [x, y, scale] = align(a, b); return { n: x - y, scale }; };
const maxZero = (a) => (a.n < 0n ? { n: 0n, scale: 2 } : a);

function money(value) {
  const a = typeof value === 'object' ? value : dec(value);
  let cents;
  if (a.scale <= 2) cents = a.n * 10n ** BigInt(2 - a.scale);
  else {
    const divisor = 10n ** BigInt(a.scale - 2);
    if (a.n % divisor !== 0n) throw new DocumentRenderError('Artifact money must have exact cents');
    cents = a.n / divisor;
  }
  const negative = cents < 0n;
  const digits = (negative ? -cents : cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${negative ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

// ---- dates (ISO text in, long text out; no time zones involved) ----
function isoParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) throw new DocumentRenderError('Date is not ISO');
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31) throw new DocumentRenderError('Date is not ISO');
  return parts;
}
function longDate(value) {
  const [year, month, day] = isoParts(value);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}
function plusDays(value, days) {
  const [year, month, day] = isoParts(value);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function numericDate(value) {
  const [year, month, day] = isoParts(value);
  return [String(month).padStart(2, '0'), String(day).padStart(2, '0'), String(year).padStart(4, '0')];
}

// ---- Bill to: Ledger's _bill_to_v2 ----
const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]');
const wordsOf = (value) => new Set(String(value).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
const isSubset = (small, big) => [...small].every((word) => big.has(word));
function addressText(customer) {
  const structured = customer.billing_address;
  if (structured === undefined || structured === null) return customer.address || '';
  const region = [String(structured.region).trim(), String(structured.postal_code).trim()].filter(Boolean).join(' ');
  const locality = [String(structured.city).trim(), region].filter(Boolean).join(', ');
  return [...structured.lines.map((line) => String(line).trim()).filter(Boolean), ...(locality ? [locality] : [])].join('\n');
}
function billToLines(customer) {
  const address = addressText(customer).split(LINE_BREAK).map((line) => line.trim()).filter(Boolean);
  const said = address.filter((line) => !/\d/.test(line)).map(wordsOf);
  const top = [];
  for (const value of [customer.name, customer.company]) {
    const words = wordsOf(value);
    if (words.size && !said.some((line) => isSubset(words, line))) {
      top.push(value);
      said.push(words);
    }
  }
  return [...top, ...address, ...[customer.phone, customer.email].filter(Boolean)];
}

function officialExtras(extras) {
  const clean = {};
  for (const [key, limit] of Object.entries(EXTRA_LIMITS)) {
    const value = extras && extras[key];
    if (typeof value === 'string' && value.trim()) clean[key] = Array.from(value.trim()).slice(0, limit).join('');
  }
  const revision = extras && extras.revision;
  if (Number.isInteger(revision) && revision >= 1) clean.revision = revision;
  return clean;
}

// Ledger's wording exactly as Ledger validates it, or null when a copy is missing or not whole.
function strictSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of TEXT_FIELDS) {
    if (typeof value[key] !== 'string') return null;
    out[key] = value[key].split(/\s+/).filter(Boolean).join(' ');
  }
  if (!out.shop_name || !Number.isInteger(value.quote_valid_days) || value.quote_valid_days < 1 || value.quote_valid_days > 365
      || !['counter', 'clean'].includes(value.style)) return null;
  out.quote_valid_days = value.quote_valid_days;
  out.style = value.style;
  return out;
}

// What to print with: Ledger's wording, or the built-in defaults when there is no whole copy.
function cleanSettings(value) {
  return strictSettings(value) || { ...DEFAULT_SETTINGS };
}

// copy: absent prints as before (Ledger parity); 'customer' keeps only the PO line, 'merchant' keeps the whole signature box.
// Each copy is labeled when the template has the counter.copy piece (an older cached template simply has no label).
function renderOfficialHtml(template, facts, extras, settings, copy) {
  const pieces = template instanceof Map ? template : parseTemplate(template);
  const piece = (name) => {
    if (!pieces.has(name)) throw new DocumentRenderError(`Template piece ${name} is missing`);
    return pieces.get(name);
  };
  const fill = (name, values = {}) => piece(name).replace(SLOT, (_all, slot) => {
    if (values[slot] === undefined) throw new DocumentRenderError(`Template slot ${slot} has no value`);
    return values[slot];
  });
  const cfg = cleanSettings(settings);
  const extra = officialExtras(extras);
  const { issued, totals, customer } = facts;
  const kind = issued.document_type;
  if (!Object.hasOwn(TITLES, kind)) throw new DocumentRenderError('Unknown document type');
  const title = TITLES[kind];
  const number = issued.document_number;
  const day = issued.document_date;
  const style = cfg.style;
  const bill = extra.bill_to !== undefined
    ? extra.bill_to.split(LINE_BREAK).map((line) => line.trim()).filter(Boolean)
    : billToLines(customer);
  const terms = extra.terms || cfg.default_terms;
  const validUntil = longDate(extra.valid_until || plusDays(day, cfg.quote_valid_days));
  const items = facts.lines.filter((line) => line.kind !== 'note');
  const multi = items.some((line) => !isOne(dec(line.quantity)) || !isZero(dec(line.discount_amount)));
  const rows = [];
  const above = [];
  for (const line of facts.lines) {
    if (line.kind === 'note') {
      if (style === 'clean') rows.push(fill('clean.row.note', { text: escape(line.description) }));
      else above.push(fill('counter.row.note', { text: escape(line.description) }));
      continue;
    }
    const serials = line.serials.length ? escape(line.serials.join(', ').toUpperCase()) : '';
    const off = !isZero(dec(line.discount_amount));
    if (style === 'clean') {
      rows.push(fill('clean.row', {
        part: escape(line.part_number), description: escape(line.description),
        serials: serials ? fill('clean.serial', { serials }) : '', qty: escape(line.quantity),
        unit: escape(money(line.unit_amount)),
        disc: off ? fill('clean.disc', { was: escape(money(line.original_unit_amount)), save: escape(money(line.discount_amount)) }) : '',
        amount: escape(money(line.line_total)),
      }));
      continue;
    }
    let each = '';
    if (off) each = fill('counter.orig', { was: escape(money(line.original_unit_amount)), unit: escape(money(line.unit_amount)) });
    else if (multi && !isOne(dec(line.quantity))) each = escape(money(line.unit_amount));
    const saved = off ? fill('counter.off', { amount: escape(money(mul(dec(line.discount_amount), dec(line.quantity)))) }) : '';
    let shown = line.description;   // the brand prints above the part number, so it is not repeated in front of the description
    if (line.make && shown.toLowerCase().startsWith(`${line.make.toLowerCase()} `)) shown = shown.slice(line.make.length + 1).trimStart();
    const part = line.make ? fill('counter.part.make', { make: escape(line.make), part: escape(line.part_number) }) : escape(line.part_number);
    rows.push(fill('counter.row', {
      part, description: escape(shown) + (serials ? fill('counter.serial', { serials }) : ''), each, qty: escape(line.quantity), saved,
      amount: escape(money(line.line_total)),
    }));
  }
  rows.unshift(...above);   // counter style: the customer note is the first line of the order
  const total = dec(totals.total);
  const sums = [['Subtotal', totals.subtotal, '']];
  for (const [label, key] of [['Card fee', 'card_fee'], ['Rounding', 'rounding']]) {
    if (!isZero(dec(totals[key]))) sums.push([label, totals[key], '']);
  }
  sums.push([isZero(dec(totals.tax)) ? 'GE tax' : GE_TAX_LABEL, totals.tax, '']);
  sums.push(['Total', totals.total, '.total']);
  if (kind === 'invoice') {
    const paid = dec(extra.paid === undefined ? '0.00' : extra.paid);
    if (style === 'clean' || !isZero(paid)) sums.push(['Amount paid', paid, ''], ['Balance due', maxZero(sub(total, paid)), '.due']);
  }
  const sumsHtml = sums.map(([label, value, level]) => fill(`${style}.sum${level}`, { label: escape(label), amount: escape(money(value)) })).join('');
  const revised = (extra.revision === undefined ? 1 : extra.revision) >= 2 && extra.revised_on
    ? fill('revised', { date: escape(longDate(extra.revised_on)) }) : '';
  const words = (text) => text.split('{terms}').join(terms).split('{valid_until}').join(validUntil).split('{valid_days}').join(String(cfg.quote_valid_days));
  // Quotes print no fine print (Trevor, Oct 31); quote_footer stays a setting so saved wording still loads.
  const footerKeys = { invoice: ['invoice_footer_1', 'invoice_footer_2'], quote: [], receipt: ['receipt_footer'] }[kind];
  const footers = footerKeys.map((key) => words(cfg[key])).filter(Boolean);
  const contact = [cfg.phone, cfg.email].filter(Boolean).join(' · ');
  const page = {
    title: escape(title), number: escape(number), shop_name: escape(cfg.shop_name), css: piece(`${style}.css`), revised,
    rows: rows.join(''), sums: sumsHtml,
  };
  const lines = (values) => values.map((text) => fill('line', { text: escape(text) })).join('');
  const paragraphs = (values) => values.map((text) => fill('p', { text: escape(text) })).join('');
  if (style === 'clean') {
    const factRows = [['Date', longDate(day)]];
    if (kind === 'invoice') {
      if (issued.due_date) factRows.push(['Due date', longDate(issued.due_date)]);
      factRows.push(['Terms', terms]);
    } else if (kind === 'quote') factRows.push(['Valid until', validUntil]);
    for (const [label, key] of [['PO / Job', 'po'], ['Ordered by', 'ordered_by']]) {
      if (extra[key] !== undefined) factRows.push([label, extra[key]]);
    }
    const questions = [contact ? `Questions? ${contact}.` : '', cfg.closing].filter(Boolean).join(' ');
    return fill('clean.page', {
      ...page,
      shop_lines: [cfg.address_1, cfg.address_2, contact].filter(Boolean).map((text) => fill('clean.shop_line', { text: escape(text) })).join(''),
      bill: bill.map(escape).join(piece('sep.br')),
      facts: factRows.map(([label, value]) => fill('clean.fact', { label: escape(label), value: escape(value) })).join(''),
      message: facts.message ? fill('clean.message', { text: escape(facts.message) }) : piece('clean.message.none'),
      pay: paragraphs([...footers, ...(questions ? [questions] : [])]),
    });
  }
  // Counter style. Bill to: the company (or the person) and the address. The middle column is always the contact: the person's
  // name (again, when the customer is only a person), phone and email.
  const contactName = extra.ordered_by || customer.name;
  const billLines = extra.bill_to !== undefined ? bill
    : billToLines({ ...customer, phone: '', email: '', ...(wordsOf(customer.company).size ? { name: '' } : {}) });
  const contactLines = [contactName, customer.phone, customer.email].filter(Boolean);
  const box = [];
  if (kind === 'invoice') {
    box.push(['Invoice #', number]);
    if (issued.due_date) {
      const [mm, dd, yy] = numericDate(issued.due_date);
      box.push(['Due date', `${mm}/${dd}/${yy}`]);
    }
    box.push(['Terms', terms]);
  } else if (kind === 'quote') {
    const [mm, dd, yy] = numericDate(extra.valid_until || plusDays(day, cfg.quote_valid_days));
    box.push(['Quote #', number]);
    if (extra.valid_until === undefined) box.push(['Valid for', `${cfg.quote_valid_days} days`]);
    box.push(['Expires', `${mm}/${dd}/${yy}`]);
  } else box.push(['Receipt #', number]);
  const address = [cfg.address_1, cfg.address_2].filter(Boolean).map(escape).join(piece('sep.dot'));
  const contactHtml = escape(contact).split(' · ').join(piece('sep.dot'));
  const infoBlocks = (billLines.length ? fill('counter.bill', { name: escape(billLines[0]), rest: lines(billLines.slice(1)) }) : '')
    + (contactLines.length ? fill('counter.ordered', { label: kind === 'quote' ? 'Requested by' : 'Ordered by', lines: lines(contactLines) }) : '')
    + fill('counter.box', { rows: box.map(([label, value]) => fill('counter.boxrow', { label: escape(label), value: escape(value) })).join('') });
  return fill('counter.page', {
    ...page,
    contact: address + (address && contact ? piece('sep.br') : '') + contactHtml,
    logo: piece('logo'), date: escape(longDate(day)),
    numbered: kind === 'receipt' ? fill('counter.no', { number: escape(number) }) : '',
    info: kind === 'receipt' ? '' : fill('counter.info', { content: infoBlocks }),
    ea: multi ? piece('counter.ea') : '',
    note: facts.message ? fill('counter.note', { text: escape(facts.message) }) : '',
    closing: escape(cfg.closing),
    after: bill.length && kind === 'receipt' ? fill('counter.cust', { lines: lines(bill) }) : '',
    pay: footers.length ? fill('counter.pay', { paragraphs: paragraphs(footers) }) : '',
    sig: (kind === 'invoice' && copy !== 'customer' ? fill('counter.sig', { po: escape(extra.po || '') }) : '')
      // The customer copy keeps the PO (when there is one) without the signature lines.
      + (kind === 'invoice' && copy === 'customer' && extra.po && pieces.has('counter.po') ? fill('counter.po', { po: escape(extra.po) }) : '')
      + (copy && pieces.has('counter.copy') ? fill('counter.copy', { label: copy === 'customer' ? 'Customer copy' : 'Merchant copy' }) : ''),
  });
}

module.exports = {
  DEFAULT_SETTINGS,
  DocumentRenderError,
  cleanSettings,
  longDate,
  parseTemplate,
  renderOfficialHtml,
  strictSettings,
};
