/* Gmail draft pieces shared by the register (index.html) and the Ledger page (ledger.html): base64 helpers, the MIME
 * builder and the email body. Moved here from index.html (one change: checkoutTotals is skipped when frozen totals are given) so both pages use ONE copy. buildEmailBody needs the
 * register's checkoutTotals only when order.ledgerTotals is absent; _emailIdentity needs the register's desktopGoogleAvailable.
 * Classic script: the functions are page globals, as they were inline. Test: node POS/test_email_document.cjs */
function _bytesToB64(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function _b64UrlUtf8(str) {
  return _bytesToB64(new TextEncoder().encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _blobToB64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
}
function _buildEmailMime(to, subject, bodyText, filename, pdfB64, bodyHtml = '', from = '') {
  const boundary = 'mpe_' + Date.now();
  const alternative = boundary + '_body';
  const header = value => String(value || '').replace(/[\r\n]/g, ' ');
  const encoded = value => _bytesToB64(new TextEncoder().encode(value)).match(/.{1,76}/g)?.join('\r\n') || '';
  return [
    'MIME-Version: 1.0',
    'To: ' + header(to),
    ...(from ? ['From: ' + header(from)] : []),
    'Subject: =?UTF-8?B?' + _bytesToB64(new TextEncoder().encode(header(subject))) + '?=',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '', '--' + boundary,
    'Content-Type: multipart/alternative; boundary="' + alternative + '"',
    '', '--' + alternative,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', encoded(bodyText),
    ...(bodyHtml ? ['', '--' + alternative,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64', '', encoded(bodyHtml)] : []),
    '', '--' + alternative + '--',
    '', '--' + boundary,
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="' + header(filename).replace(/["\\]/g, '_') + '"',
    '', pdfB64.match(/.{1,76}/g)?.join('\r\n') || '',
    '', '--' + boundary + '--', ''
  ].join('\r\n');
}

async function _emailIdentity(token) {
  if (desktopGoogleAvailable()) {
    if (typeof window.mpeDesktop.google.gmailIdentity !== 'function') {
      throw new Error('This POS Desktop needs an update to load your Gmail signature. Use the browser POS for this email.');
    }
    return window.mpeDesktop.google.gmailIdentity();
  }
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs?fields=sendAs(sendAsEmail,isDefault,isPrimary,signature)', {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error('Sign in again to allow POS to read your Gmail signature.');
    error.emailConsentRequired = true;
    throw error;
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Could not read your Gmail signature.');
  const aliases = data.sendAs || [];
  const sender = aliases.find(alias => alias.isDefault) || aliases.find(alias => alias.isPrimary);
  if (!sender?.sendAsEmail) throw new Error('Gmail did not return your default From address.');
  return { email: sender.sendAsEmail, accountEmail: aliases.find(alias => alias.isPrimary)?.sendAsEmail || sender.sendAsEmail, signature: sender.signature || '' };
}

function buildEmailBody(order, title, number, dateStr, signature = '') {
  // A short summary, not a copy of the invoice: the attached PDF is the document.
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = value => '$' + Number(value).toFixed(2);
  const items = order.items || [];
  const frozenTotals = order.ledgerTotals;
  const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.sub) || 0), 0);
  const total = frozenTotals ? Number(frozenTotals.total) : checkoutTotals(subtotal, !!order.toggles?.cardFee).total;
  const kind = String(title).toLowerCase();
  const plus30 = () => {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + 30);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const names = items.filter(item => String(item.desc || item.pn || '').trim()).map(item => {
    const qty = parseFloat(item.qty) || 1;
    return String(item.desc || item.pn).trim() + (qty !== 1 ? ` (${qty})` : '');
  });
  const itemText = names.length > 5 ? names.slice(0, 5).join(', ') + `, and ${names.length - 5} more` : names.join(', ');
  const rows = [['Date', dateStr]];
  if (kind === 'invoice') rows.push(['Due', plus30()]);
  if (kind === 'quote') rows.push(['Valid until', plus30()]);
  rows.push(['Items', itemText], ['Total', money(total)]);
  const shown = rows.filter(([, value]) => value);
  const greeting = 'Aloha' + (order.customer?.name ? ' ' + order.customer.name : '') + ',';
  const intro = `Your ${kind} ${number} from Maui Power Equipment is attached.`;
  const cell = 'padding:3px 16px 3px 0;vertical-align:top;text-align:left';
  const table = `<table style="border-collapse:collapse;font-size:14px;margin:8px 0 4px">` +
    shown.map(([label, value]) => `<tr><td style="${cell};color:#555">${esc(label)}</td>` +
      `<td style="${cell}${label === 'Total' ? ';font-weight:bold' : ''}">${esc(value)}</td></tr>`).join('') + `</table>`;
  // The summary sits before the signature, so Gmail swapping the signature never touches it.
  const signatureHtml = signature ? `<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signature}</div>` : '';
  const html = `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">` +
    `<p>${esc(greeting)}</p><p>${esc(intro)}</p>${table}${signatureHtml}</div>`;
  const signatureDoc = new DOMParser().parseFromString(signature.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:div|p|tr)>/gi, '\n'), 'text/html');
  const text = [greeting, intro, shown.map(([label, value]) => `${label}: ${value}`).join('\n'),
    signatureDoc.body.textContent.trim()].filter(Boolean).join('\n\n');
  return { html, text };
}
