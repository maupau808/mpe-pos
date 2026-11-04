/* The email window, shared by History (ledger.html) and the register (index.html). Classic script: window.MPEEmailWindow.
 * open(opts) shows To / Cc / Bcc / Subject / Message on the left and, on the right, the email as the customer sees it with the
 * document below it. Send runs opts.send(fields) only when a person presses it (Trevor, 2026-11-04; Claude never sends).
 * Save draft keeps the version in progress on this computer (localStorage), not in Gmail; Send clears it.
 *   opts: { key, heading, from, accountEmail, to, subject, message, signature, pages: [html], attachment, send: async fields => void }
 *   fields: { to, cc, bcc, subject, message, text, html }   resolves { sent: true, to } or null when closed.
 * Needs email-draft.js (buildTypedEmail, parseEmailList). Test: node POS/test_email_window.cjs */
(function (root) {
  'use strict';
  const PREFIX = 'mpeEmailDraftV1:';
  // Failsafe (Trevor, 2026-11-04): Send works only when the signed-in Google account AND the From address are the shop's.
  const SHOP = 'info@mauipowerequipment.com';
  const wrongAccount = o => {
    const bad = [o.accountEmail, o.from].map(v => String(v || '').trim().toLowerCase()).find(v => v !== SHOP);
    return bad === undefined ? '' : `Send only works from ${SHOP}. This computer is signed in as ${bad || 'an unknown account'}. Sign in to Google with ${SHOP}, then press Email again.`;
  };
  const CSS = `
.mew,dialog.mew{width:min(1180px,calc(100% - 24px));max-width:none;height:calc(100% - 24px);max-height:none;margin:auto;padding:0;border:1px solid #c9d2c7;border-radius:8px;
  background:#fffdfa;color:#202c24;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.mew::backdrop{background:rgba(20,28,22,.45)}
.mew[open]{display:grid;grid-template-columns:minmax(300px,380px) 1fr}
.mew *{box-sizing:border-box}
.mew [hidden]{display:none!important}
.mew .l{display:flex;flex-direction:column;gap:10px;padding:18px;border-right:1px solid #e6ebe4;overflow:auto}
.mew h2{font-size:17px;margin:0}
.mew .from{font-size:12.5px;color:#5f6b61}
.mew label{display:block;font-size:13px;font-weight:600;color:#4f5d52}
.mew input,.mew textarea{display:block;width:100%;margin-top:3px;padding:7px 9px;border:1px solid #d5ddd3;border-radius:5px;background:#fff;font:inherit;color:inherit}
.mew textarea{flex:1;min-height:180px;resize:none}
.mew .grow{flex:1;display:flex;flex-direction:column}
.mew .link{background:none;border:0;padding:0;color:#2f4339;text-decoration:underline;font:inherit;font-size:13px;cursor:pointer;align-self:flex-start}
.mew .hint{font-size:12.5px;color:#5f6b61}
.mew .err{min-height:18px;font-size:13px;color:#b3261e}
.mew .ok{font-size:13px;color:#2f4339}
.mew .btns{display:flex;gap:8px;align-items:center}
.mew .btn{height:38px;padding:0 16px;border:1px solid #d5ddd3;border-radius:6px;background:#fff;font:inherit;font-weight:600;cursor:pointer}
.mew .btn.primary{background:#2f4339;border-color:#2f4339;color:#fff}
.mew .btn:disabled{opacity:.55;cursor:default}
.mew .btns .sp{flex:1}
.mew .r{overflow:auto;background:#f2f5f0;padding:18px;display:flex;flex-direction:column;gap:14px}
.mew .r>*{flex-shrink:0}
.mew .card{background:#fff;border:1px solid #d5ddd3;border-radius:6px}
.mew .hdr{padding:10px 14px;border-bottom:1px solid #e6ebe4;font-size:13px;color:#4f5d52;display:grid;grid-template-columns:auto 1fr;gap:2px 10px}
.mew .hdr b{color:#202c24;font-weight:600}
.mew .body{display:block;width:100%;height:260px;border:0}
.mew .att{font-size:13px;font-weight:600;color:#4f5d52}
.mew .page{display:block;width:816px;height:1056px;border:0;background:#fff;transform-origin:0 0}
.mew .pagebox{overflow:hidden;border:1px solid #d5ddd3;background:#fff}
@media (max-width:760px){.mew[open]{grid-template-columns:1fr;overflow:auto}.mew .l{border-right:0}.mew .r{overflow:visible}}`;
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const time = ms => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const store = () => { try { return root.localStorage; } catch (_) { return null; } };
  function readSaved(key) { try { const v = JSON.parse(store().getItem(PREFIX + key) || 'null'); return v && typeof v === 'object' ? v : null; } catch (_) { return null; } }
  function writeSaved(key, v) { try { store().setItem(PREFIX + key, JSON.stringify(v)); return true; } catch (_) { return false; } }
  function dropSaved(key) { try { store().removeItem(PREFIX + key); } catch (_) { /* blocked storage */ } }

  // Checks the fields; returns the error text, or '' when they can be sent.
  function check(f) {
    const to = root.parseEmailList(f.to), cc = root.parseEmailList(f.cc), bcc = root.parseEmailList(f.bcc);
    if (!to.list.length) return 'Type the customer’s email address in To.';
    const bad = to.bad || cc.bad || bcc.bad;
    if (bad) return `“${bad}” is not an email address.`;
    if (to.list.length + cc.list.length + bcc.list.length > 20) return 'Too many addresses. Use 20 or fewer.';
    if (!String(f.subject || '').trim()) return 'Type a subject.';
    return '';
  }

  function open(opts) {
    opts = { ...opts, cannotSend: wrongAccount(opts) || opts.cannotSend || '' };
    const doc = root.document;
    if (!doc.getElementById('mewStyle')) { const st = doc.createElement('style'); st.id = 'mewStyle'; st.textContent = CSS; doc.head.append(st); }
    const d = doc.createElement('dialog');
    d.className = 'mew';
    d.setAttribute('aria-label', opts.heading || 'Email');
    d.innerHTML = `
      <div class="l">
        <div><h2>${esc(opts.heading || 'Email')}</h2>${opts.from ? `<div class="from">From ${esc(opts.from)}</div>` : ''}</div>
        <div class="saved hint" hidden></div>
        <label>To<input name="to" autocomplete="off" spellcheck="false"></label>
        <button type="button" class="link" data-a="ccbcc">Add Cc or Bcc</button>
        <label data-cc hidden>Cc<input name="cc" autocomplete="off" spellcheck="false"></label>
        <label data-cc hidden>Bcc<input name="bcc" autocomplete="off" spellcheck="false"></label>
        <label>Subject<input name="subject" autocomplete="off"></label>
        <label class="grow">Message<textarea name="message"></textarea></label>
        ${opts.signature ? '<div class="hint">Your Gmail signature goes below the message.</div>' : ''}
        ${opts.cannotSend ? `<div class="err">${esc(opts.cannotSend)}</div>` : ''}
        <div class="err" role="alert"></div>
        <div class="btns"><button type="button" class="btn primary" data-a="send"${opts.cannotSend ? ' disabled' : ''}>Send</button><button type="button" class="btn" data-a="save">Save draft</button><span class="sp"></span><button type="button" class="btn" data-a="close">Close</button></div>
      </div>
      <div class="r">
        <div class="card"><div class="hdr"><span>To</span><b data-p="to"></b><span data-p="cclabel" hidden>Cc</span><b data-p="cc" hidden></b><span>Subject</span><b data-p="subject"></b></div>
          <iframe class="body" sandbox="allow-same-origin" title="Email preview"></iframe></div>
        <div class="att">Attached: ${esc(opts.attachment || 'document.pdf')}</div>
        ${(opts.pages || []).map(() => '<div class="pagebox"><iframe class="page" sandbox="allow-same-origin" tabindex="-1" title="Attached document"></iframe></div>').join('')}
      </div>`;
    doc.body.append(d);
    const $ = sel => d.querySelector(sel), field = n => $(`[name="${n}"]`);
    const names = ['to', 'cc', 'bcc', 'subject', 'message'];
    const values = () => Object.fromEntries(names.map(n => [n, field(n).value]));
    const start = { to: opts.to || '', cc: '', bcc: '', subject: opts.subject || '', message: opts.message || '' };
    const saved = opts.key ? readSaved(opts.key) : null;
    const fill = v => names.forEach(n => { field(n).value = v[n] || ''; });
    fill(saved || start);
    let clean = JSON.stringify(values()), busy = false;
    const showCc = on => { d.querySelectorAll('[data-cc]').forEach(el => { el.hidden = !on; }); $('[data-a="ccbcc"]').hidden = on; };
    showCc(!!(field('cc').value || field('bcc').value));
    function savedNote(at) {
      const el = $('.saved');
      el.hidden = !at;
      el.innerHTML = at ? `Your saved draft from ${esc(time(at))}. <button type="button" class="link" data-a="restart">Start over</button>` : '';
    }
    savedNote(saved && saved.savedAt);
    // Preview: the email as sent (message + signature) and each document page, scaled to the column.
    let timer = 0;
    function preview() {
      const v = values(), mail = root.buildTypedEmail(v.message, opts.signature || '');
      $('[data-p="to"]').textContent = v.to; $('[data-p="subject"]').textContent = v.subject;
      $('[data-p="cc"]').textContent = v.cc; $('[data-p="cc"]').hidden = $('[data-p="cclabel"]').hidden = !v.cc.trim();
      $('.body').srcdoc = '<!doctype html><meta charset="utf-8"><body style="margin:12px 14px">' + mail.html;
    }
    const pages = [...d.querySelectorAll('.page')];
    // No scripts run in the page frames; same-origin only so the frame can be sized to the whole document.
    pages.forEach((f, i) => { f.onload = () => { try { f.style.height = Math.max(1056, f.contentDocument.documentElement.scrollHeight) + 'px'; } catch (_) { /* keep 1056 */ } scale(); }; f.srcdoc = opts.pages[i]; });
    function scale() {
      const w = $('.r').clientWidth - 38;
      pages.forEach(f => { const z = Math.min(1, w / 816), h = parseFloat(f.style.height) || 1056; f.style.transform = `scale(${z})`; f.parentNode.style.height = Math.ceil(h * z) + 'px'; f.parentNode.style.width = Math.ceil(816 * z) + 'px'; });
    }
    preview();
    const err = t => { $('.err').textContent = t || ''; };
    return new Promise(resolve => {
      function finish(result) { root.removeEventListener('resize', scale); d.close(); d.remove(); resolve(result); }
      function tryClose() {
        if (busy) return;
        if (JSON.stringify(values()) !== clean && !root.confirm('Close without saving your changes? Press Save draft first to keep them.')) return;
        finish(null);
      }
      d.addEventListener('cancel', e => { e.preventDefault(); tryClose(); });
      d.addEventListener('input', () => { err(''); clearTimeout(timer); timer = setTimeout(preview, 150); });
      d.addEventListener('click', async e => {
        const a = e.target.closest('[data-a]') && e.target.closest('[data-a]').dataset.a;
        if (!a || busy) return;
        if (a === 'ccbcc') { showCc(true); field('cc').focus(); }
        if (a === 'close') tryClose();
        if (a === 'restart') { fill(start); showCc(false); if (opts.key) dropSaved(opts.key); savedNote(0); clean = JSON.stringify(values()); preview(); }
        if (a === 'save') {
          const at = Date.now();
          if (!opts.key || !writeSaved(opts.key, { ...values(), savedAt: at })) return err('The draft could not be saved on this computer.');
          clean = JSON.stringify(values()); savedNote(at); err('');
        }
        if (a === 'send') {
          const v = values(), why = wrongAccount(opts) || check(v);
          if (why) return err(why);
          const mail = root.buildTypedEmail(v.message, opts.signature || '');
          const list = k => root.parseEmailList(v[k]).list.join(', ');
          busy = true; err('');
          const btn = $('[data-a="send"]'); btn.disabled = true; btn.textContent = 'Sending…';
          d.querySelectorAll('.btn').forEach(b => { b.disabled = true; });
          try {
            await opts.send({ to: list('to'), cc: list('cc'), bcc: list('bcc'), subject: v.subject.trim(), message: v.message, text: mail.text, html: mail.html });
            if (opts.key) dropSaved(opts.key);
            busy = false; finish({ sent: true, to: list('to') });
          } catch (x) {
            busy = false;
            d.querySelectorAll('.btn').forEach(b => { b.disabled = false; });
            btn.textContent = 'Send';
            err(`It did not send. ${(x && x.message) || ''} Nothing was lost; try again.`.replace(/\s+/g, ' '));
          }
        }
      });
      root.addEventListener('resize', scale);
      d.showModal();
      requestAnimationFrame(scale);
      field(field('to').value ? 'message' : 'to').focus();
    });
  }
  root.MPEEmailWindow = { open, check, wrongAccount, PREFIX, SHOP };
})(typeof window === 'object' ? window : globalThis);
