// The email window's checks, typed message and Cc/Bcc headers. Run: node POS/test_email_window.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = { TextEncoder, btoa, window: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'email-draft.js'), 'utf8'), ctx);
Object.assign(ctx.window, { parseEmailList: ctx.parseEmailList, buildTypedEmail: ctx.buildTypedEmail });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'email-window.js'), 'utf8'), ctx);
const W = ctx.window.MPEEmailWindow;
const ok = { to: 'kai@example.test', cc: '', bcc: '', subject: 'Invoice L21001', message: 'Aloha' };
assert.equal(W.check(ok), '');
assert.match(W.check({ ...ok, to: '' }), /To/);
assert.match(W.check({ ...ok, cc: 'kai@example.test, nope' }), /nope/);
assert.match(W.check({ ...ok, subject: ' ' }), /subject/);
assert.deepEqual([...ctx.parseEmailList('a@x.co; b@y.com ,c@z.org').list], ['a@x.co', 'b@y.com', 'c@z.org']);
const mail = ctx.buildTypedEmail('Aloha Kai,\n\nLine one\nline <two>', '');
assert.equal(mail.text, 'Aloha Kai,\n\nLine one\nline <two>');
assert.match(mail.html, /<p>Aloha Kai,<\/p><p>Line one<br>line &lt;two&gt;<\/p>/);
const mime = ctx._buildEmailMime('kai@example.test', 'S', 't', 'a.pdf', 'QUJD', '', 'shop@example.test', 'b@y.com', 'c@z.org');
assert.match(mime, /\r\nCc: b@y\.com\r\n/);
assert.match(mime, /\r\nBcc: c@z\.org\r\n/);
assert.match(ctx._buildEmailMime('k@x.co', 'S', 't', 'a.pdf', 'QUJD', '', 'info@mauipowerequipment.com'), /\r\nFrom: "Maui Power Equipment" <info@mauipowerequipment\.com>\r\n/);
assert.doesNotMatch(ctx._buildEmailMime('k@x.co', 'S', 't', 'a.pdf', 'QUJD'), /Cc:|Bcc:/);
const shop = 'info@mauipowerequipment.com';
assert.equal(W.wrongAccount({ from: shop, accountEmail: 'INFO@mauipowerequipment.com' }), '');
assert.match(W.wrongAccount({ from: shop, accountEmail: 'trevor.kudo@example.test' }), /signed in as trevor\.kudo@example\.test/);
assert.match(W.wrongAccount({ from: 'sales@mauipowerequipment.com', accountEmail: shop }), /sales@/);
assert.match(W.wrongAccount({ from: shop }), /unknown account/);
console.log('PASS: shop-account failsafe; email window checks, typed message, Cc/Bcc headers');

// Pay link button: needs a real DOM, so the cases run in a hidden Electron page (no window shown, no dock icon).
// Shots: SHOT_DIR=/some/dir node POS/test_email_window.cjs writes t9_*.png there.
if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  if (app.dock) app.dock.hide();
  const SRC = ['email-draft.js', 'email-window.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const CASES = `(async () => {
    window.confirm = () => true; const out = [], ok = (n, c) => out.push([n, !!c]), sleep = ms => new Promise(r => setTimeout(r, ms));
    const base = { key: 'k1', heading: 'Email invoice L21001', from: 'info@mauipowerequipment.com', accountEmail: 'info@mauipowerequipment.com', to: 'kai@example.test', subject: 'Invoice L21001',
      signature: '', pages: [], attachment: 'Invoice-L21001.pdf', send: async () => {} };
    const START = 'Aloha Kai,\\n\\nYour invoice L21001 is attached.\\n\\nTotal: $100.00';
    const startMessage = url => START + (url ? '\\n\\nPay online: ' + url + '\\nBank transfer has no card fee, and card payments carry a surcharge.' : '');
    const URL1 = 'https://pay.example.test/abc';
    const shot = async name => { if (window.__shot) await window.__shot(name); };
    const run = async (extra, drive) => {
      localStorage.clear();
      const p = MPEEmailWindow.open({ ...base, message: START, ...extra });
      await sleep(50);
      const d = document.querySelector('dialog.mew'), q = s => d.querySelector(s);
      const btn = () => q('[data-a="addlink"]');
      await drive({ d, q, btn, msg: () => q('[name="message"]').value });
      d.querySelector('[data-a="close"]').click(); await p; 
    };
    // register path: no option, no pay row at all
    await run({}, async ({ d, q }) => { ok('register: no pay row', !q('[data-pay]') && !d.innerHTML.includes('Add pay link')); ok('register: attachment line still there', q('.att')); });
    // button hidden when canAdd is false and no url; link + Copy and no button when a url exists
    await run({ payLink: { url: '', canAdd: false, add: async () => ({}), startMessage } }, async ({ q }) => ok('cannot add: no pay row', !q('[data-pay]')));
    await run({ payLink: { url: URL1, canAdd: false, add: async () => ({}), startMessage } }, async ({ q, btn }) => { ok('has url: link shown', q('[data-pay] .u').textContent === URL1); ok('has url: Copy, no button', q('[data-a="copylink"]') && !btn()); });
    // button shown above the attachment line
    let calls = 0;
    await run({ payLink: { url: '', canAdd: true, add: async () => { calls++; await sleep(80); return { url: URL1 }; }, startMessage } }, async ({ q, btn, msg }) => {
      ok('button shown', btn()); ok('button sits above attachment line', q('[data-pay]').nextElementSibling === q('.att'));
      await shot('button'); btn().click(); await sleep(20);
      ok('busy text while adding', btn() && btn().textContent.includes('Adding') && btn().disabled);
      await sleep(150);
      ok('add called once', calls === 1); ok('untouched message rebuilt with link', msg() === startMessage(URL1)); ok('link + Copy shown, button gone', q('[data-pay] .u').textContent === URL1 && q('[data-a="copylink"]') && !btn());
      ok('preview updated', q('.body').srcdoc.includes('Pay online:'));
      await shot('added');
    });
    // edited message keeps their text and gets the lines
    await run({ payLink: { url: '', canAdd: true, add: async () => ({ url: URL1 }), startMessage } }, async ({ q, btn, msg }) => {
      const t = q('[name="message"]'); t.value = START + '\\n\\nMy own note.'; t.dispatchEvent(new Event('input', { bubbles: true }));
      btn().click(); await sleep(50);
      ok('edited: their text kept', msg().startsWith(START + '\\n\\nMy own note.'));
      ok('edited: pay lines appended', msg() === START + '\\n\\nMy own note.\\n\\nPay online: ' + URL1 + '\\nBank transfer has no card fee, and card payments carry a surcharge.');
    });
    // error: plain text, nothing changes, button back
    await run({ payLink: { url: '', canAdd: true, add: async () => ({ error: 'Helcim said no.' }), startMessage } }, async ({ q, btn, msg }) => {
      btn().click(); await sleep(50);
      ok('error shown plainly', q('.err[role="alert"]').textContent.includes('Helcim said no.') && q('.err[role="alert"]').textContent.includes('Nothing changed'));
      ok('error: message unchanged', msg() === START); ok('error: button back and usable', btn() && !btn().disabled && btn().textContent === 'Add pay link');
      await shot('error');
    });
    await run({ payLink: { url: '', canAdd: true, add: async () => { throw new Error('boom'); }, startMessage } }, async ({ q, btn, msg }) => { btn().click(); await sleep(50); ok('throw: shown, message unchanged', q('.err[role="alert"]').textContent.includes('boom') && msg() === START); });
    return out;
  })()`;
  process.on('unhandledRejection', e => { console.log('FAIL: ' + (e && (e.stack || e.message || JSON.stringify(e)))); app.exit(1); });
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true } });
    await win.loadFile(path.join(__dirname, 'email-draft.js'));
    await win.webContents.executeJavaScript(SRC + '\nwindow.parseEmailList = parseEmailList; window.buildTypedEmail = buildTypedEmail; 0;');
    if (process.env.SHOT_DIR) {
      let n = 0; win.webContents.on('console-message', () => {});
      await win.webContents.executeJavaScript('window.__shot = async name => { window.__shotName = name; while (window.__shotName) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 300)); }; 0');
    }
    // Screenshots: poll the page for a requested name, capture, clear.
    let busyShot = false;
    const timer = process.env.SHOT_DIR && setInterval(async () => {
      if (busyShot) return; busyShot = true;
      const name = await win.webContents.executeJavaScript('window.__shotName || null');
      if (name) { await new Promise(r => setTimeout(r, 300)); fs.writeFileSync(path.join(process.env.SHOT_DIR, 't9_' + name + '.png'), (await win.webContents.capturePage()).toPNG()); await win.webContents.executeJavaScript('window.__shotName = null; 0'); }
      busyShot = false;
    }, 10);
    const res = await win.webContents.executeJavaScript(`(async () => { try { return await ${CASES}; } catch (x) { return [['threw ' + (x && x.stack || x), false]]; } })()`).catch(e => { console.log('FAIL: ' + (e && (e.message || JSON.stringify(e)))); app.exit(1); return []; });
    clearInterval(timer);
    const bad = res.filter(r => !r[1]);
    res.forEach(r => console.log((r[1] ? 'ok   ' : 'FAIL ') + r[0]));
    console.log(bad.length ? `FAIL: ${bad.length}/${res.length} pay link cases` : `PASS: ${res.length}/${res.length} pay link cases`);
    app.exit(bad.length ? 1 : 0);
  });
} else {
  const bin = path.join(__dirname, '..', 'POSDesktop', 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(bin)) console.log('SKIP: pay link cases need POSDesktop/node_modules (Electron)');
  else {
    const r = require('node:child_process').spawnSync(bin, [__filename], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } });
    process.exit(r.status === null ? 1 : r.status);
  }
}
