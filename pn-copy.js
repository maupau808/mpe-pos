/* The one copy-a-part-number icon (Trevor, 2026-11-13). Every internal tool loads this and puts the icon right
   after a part number; one click copies the number as shown and the icon turns into a check for a moment.
   Parts pages are built as text, so use the string form:   html += MPECopyPn.html(pn)
   or, on a node already in the page:                        MPECopyPn.append(el, pn)
   Never in printed, PDF, emailed or public output. Tools/sync_part_number.sh copies this file to the tools that
   run standalone (MPE Parts, POS); the Tools server and MPE Mobile serve it as /pn-copy.js. Never edit a copy. */
(function () {
  if (window.MPECopyPn) return;
  const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
  const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Same look as the Need to Order copy icon, but always faintly there. It is as tall as the text line (never taller),
  // so a row never grows, and it takes no tab stop: rows keep their own keyboard use. A span, not a button, so it also sits inside rows that are buttons.
  const css = '.mpe-copy{display:inline-flex;align-items:center;justify-content:center;position:relative;box-sizing:border-box;width:1.25em;height:1em;margin:0 0 0 .3em;padding:0;border-radius:4px;color:inherit;opacity:.3;cursor:pointer;vertical-align:-.12em;font-size:inherit;line-height:1;font-weight:400;text-transform:none;letter-spacing:0;white-space:nowrap}'
    + '.mpe-copy svg{width:.9em;height:.9em;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}'
    + '.mpe-copy:hover,.mpe-copy:focus-visible{opacity:.85}'
    + '.mpe-copy.done,.mpe-copy.failed{opacity:1}'
    + '.mpe-copy.done::after,.mpe-copy.failed::after{content:"Copied";position:absolute;left:100%;top:50%;transform:translateY(-50%);margin-left:4px;padding:1px 5px;border-radius:4px;background:#1f2933;color:#fff;font:500 11px/1.4 system-ui,sans-serif;pointer-events:none;z-index:50}'
    + '.mpe-copy.failed::after{content:"Not copied";background:#a4262c}'
    + '@media print{.mpe-copy{display:none!important}}';
  const style = document.createElement('style'); style.id = 'mpe-copy-css'; style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  async function write(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
    const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0';
    document.body.append(t); t.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ok stays false */ } t.remove(); return ok;
  }
  // One listener for the whole page, ahead of the page's own row and number clicks: the icon never opens or selects anything.
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('.mpe-copy'); if (!b) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const was = b.dataset.mpeCopy, ok = await write(was);
    clearTimeout(b._t); b.classList.remove('done', 'failed'); b.classList.add(ok ? 'done' : 'failed'); b.innerHTML = ok ? TICK : ICON;
    b._t = setTimeout(() => { b.classList.remove('done', 'failed'); b.innerHTML = ICON; }, 1200);
  }, true);
  // A press on the icon must not start the page's own press handling either (drag, selection, row focus).
  document.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('.mpe-copy')) { e.preventDefault(); e.stopPropagation(); } }, true);

  const html = pn => { pn = String(pn == null ? '' : pn).trim(); return pn ? '<span role="button" class="mpe-copy" tabindex="-1" data-mpe-copy="' + esc(pn) + '" title="Copy ' + esc(pn) + '" aria-label="Copy part number ' + esc(pn) + '">' + ICON + '</span>' : ''; };
  window.MPECopyPn = { html, append: (el, pn) => {  // put the icon last in el, or take it away when pn is empty; does nothing when it already shows this number
    if (!el) return; pn = String(pn == null ? '' : pn).trim();
    const old = el.querySelector(':scope > .mpe-copy'); if (old && old.dataset.mpeCopy === pn) return;
    if (old) old.remove(); if (pn) el.insertAdjacentHTML('beforeend', html(pn));
  } };
})();
