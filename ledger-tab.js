'use strict';
// Ledger tab for the browser register (the app has its own native tab, POSDesktop/src/pos-tabs.js).
// First in the sale tab row, never closed, no count. It shows ledger.html in one iframe over the
// sale area, kept loaded so search, selection and scroll survive. The Ledger page asks for a new
// sale tab with parent.postMessage({ kind, txn }, location.origin); only that exact same-origin
// frame is heard, and the register opens a NEW tab for it, so a sale in progress is never cleared.
// Scanner: a keyboard-wedge scan typed while Ledger shows goes through the register's own burst test
// (scanKeydown = onHardwareScanKeydown, attached in the frame), lands on the last sale tab, and onScan shows
// that tab; Ledger's search box gets its old text back. Ordinary typing stays in Ledger.
// Test: node POS/test_ledger_tab.cjs
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MPELedgerTab = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = Object.freeze(['quote-to-sale', 'copy-sale', 'new-invoice', 'edit']);
  const MAX_TXN_CHARS = 200000;
  const BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 7h6"/></svg>';

  // Same rule as POSDesktop/src/pos-tabs.js ledgerSaleRequest (a desktop test checks they agree).
  function saleMessage(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !KINDS.includes(data.kind)) return null;
    if (!data.txn || typeof data.txn !== 'object' || Array.isArray(data.txn)) return null;
    let text;
    try { text = JSON.stringify(data.txn); } catch (e) { return null; }
    if (typeof text !== 'string' || text.length > MAX_TXN_CHARS) return null;
    const txn = JSON.parse(text);
    if (data.kind !== 'new-invoice' && (typeof txn.txnId !== 'string' || !txn.txnId.trim())) return null;
    return { kind: data.kind, txn };
  }

  // tabs: the tab row; header: the bar the frame sits under; host: the positioned register root.
  function install({ document, window, tabs, header, host, src = 'ledger.html', onShow, onOpenSale, scanKeydown, onScan }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cv-tab cv-ledger-tab';
    button.dataset.cvLedger = '1';
    button.title = 'Ledger';
    button.innerHTML = BOOK + '<span>Ledger</span>';
    let frame = null, shown = false;
    // An iframe keeps its 150px default height even with top and bottom set, so its height is set here too.
  const place = () => { if (frame) { frame.style.top = header.offsetHeight + 'px'; frame.style.height = Math.max(0, host.clientHeight - header.offsetHeight) + 'px'; } };
    function show() {
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'cv-ledger-frame';
        frame.title = 'Ledger';
        frame.src = src;
        if (scanKeydown) frame.addEventListener('load', () => forwardScans(frame.contentWindow, scanKeydown, onScan));
        host.append(frame);
      }
      place();
      frame.hidden = false;
      shown = true;
      button.classList.add('active');
      if (onShow) onShow();
    }
    function hide() {
      if (frame) frame.hidden = true;
      shown = false;
      button.classList.remove('active');
    }
    button.onclick = show;
    tabs.prepend(button);
    window.addEventListener('resize', () => { if (shown) place(); });
    window.addEventListener('message', (event) => {
      if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      const sale = saleMessage(event.data);
      if (sale) onOpenSale(sale);
    });
    return { show, hide, isShown: () => shown, button };
  }

  // Every key in the Ledger frame passes the register's scanner test first. A proven scan ends with the register
  // preventing its Enter/Tab; then the field it restored tells Ledger, and the sale tab is shown.
  function forwardScans(win, scanKeydown, onScan) {
    if (!win) return;
    win.addEventListener('keydown', (event) => {
      const before = event.defaultPrevented;
      scanKeydown(event);
      if (before || !event.defaultPrevented || (event.key !== 'Enter' && event.key !== 'Tab')) return;
      const field = win.document.activeElement;
      if (field && field.tagName === 'INPUT') field.dispatchEvent(new win.Event('input', { bubbles: true }));
      if (onScan) onScan();
    }, true);
  }

  return { KINDS, saleMessage, install, forwardScans };
});
