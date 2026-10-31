'use strict';
// POS/document-renderer.js is the website's copy of POSDesktop/src/document-renderer.js (the POS Pages repo cannot load
// the Desktop folder). It must stay byte-identical, so document-template.html stays the only layout and one filler exists.
// Refresh the copy: node POS/test_document_renderer_copy.cjs --write
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = path.join(__dirname, '..', 'POSDesktop', 'src', 'document-renderer.js');
const copy = path.join(__dirname, 'document-renderer.js');
if (process.argv.includes('--write')) fs.copyFileSync(source, copy);
assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(source)), 'POS/document-renderer.js differs from POSDesktop/src/document-renderer.js; run with --write');
console.log('document-renderer copy: byte-identical 1/1');
