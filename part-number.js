// The one part-number cleaner and loose part lookup for every MPE tool.
// Python twin: Server/part_number.py. Shared cases: Server/part_number_cases.json.
// Served by Tools and by Mobile (deploy.sh stages it) at /part-number.js. POS carries a
// byte-identical copy (POS/part-number.js): edit this file, then run
// `bash Playground/Tools/sync_part_number.sh`. Never write another cleaner or matcher.
(function (root) {
  'use strict';
  const DELIMITERS = /[;|\t\x1D]/;
  // PACE prints a brand code that Master leaves off; strip only these, and only
  // with the matching Make, so the same digits under another brand never match.
  const DISTRIBUTOR_PREFIXES = [['SC', 'SCAG'], ['SC', 'HYDRO-GEAR'], ['GV', 'SCAG'], ['WR', 'WRIGHT'], ['BB', 'BLUEBIRD']];

  // Master's key (pn_norm): drop a trailing "-US", remove spaces and dashes, uppercase.
  // Dots, slashes and stars stay: they tell real parts apart (BCS 20.9 vs Felco 209).
  function norm(pn) {
    return String(pn || '').replace(/-US$/i, '').replace(/[\s-]/g, '').toUpperCase();
  }

  // Punctuation-blind key for the forgiving last step: letters and digits only,
  // and a STIHL-style trailing US after a digit is ignored.
  function looseKey(pn) {
    const key = norm(pn).replace(/[^A-Z0-9]/g, '');
    return key.length > 6 ? key.replace(/(\d)US$/, '$1') : key;
  }

  // Exact cleaned match first, then the forgiving steps POS uses, in POS order:
  // one field of a label payload, a distributor prefix, then the loose key.
  // find(key) returns the rows for one exact key; findLoose(looseKey) and
  // makeOf(row) are optional. Returns [] when nothing matches.
  function lookup(query, find, findLoose, makeOf) {
    const raw = String(query == null ? '' : query).trim();
    const key = norm(raw);
    if (!key) return [];
    let hits = find(key) || [];
    if (hits.length) return hits;
    if (DELIMITERS.test(raw)) {
      const found = [], seen = new Set();
      for (const field of raw.split(DELIMITERS)) {
        const k = norm(field);
        // Under four characters is a quantity or a country code, never a part.
        if (k.length < 4 || seen.has(k)) continue;
        seen.add(k);
        const rows = find(k) || [];
        if (rows.length) found.push(rows);
      }
      return found.length === 1 ? found[0] : [];
    }
    if (makeOf) {
      for (const [prefix, make] of DISTRIBUTOR_PREFIXES) {
        if (!key.startsWith(prefix) || key.length === prefix.length) continue;
        hits = (find(key.slice(prefix.length)) || []).filter(row => String(makeOf(row) || '').trim().toUpperCase() === make);
        if (hits.length) return hits;
      }
    }
    return findLoose ? findLoose(looseKey(raw)) || [] : [];
  }

  // A ready index for tools that hold plain rows: keysOf(row) lists the numbers
  // a row answers to (part number, OG format, supersedes...).
  function index(rows, keysOf, makeOf) {
    const exact = new Map(), loose = new Map();
    const add = (map, key, row) => {
      let list = map.get(key);
      if (!list) map.set(key, list = []);
      if (list[list.length - 1] !== row) list.push(row);
    };
    for (const row of rows || []) {
      for (const value of keysOf(row) || []) {
        const key = norm(value);
        if (!key) continue;
        add(exact, key, row);
        add(loose, looseKey(key), row);
      }
    }
    const find = key => exact.get(key) || [];
    const findLoose = key => loose.get(key) || [];
    return { find, findLoose, lookup: query => lookup(query, find, findLoose, makeOf) };
  }

  const api = { norm, looseKey, lookup, index, DISTRIBUTOR_PREFIXES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MPEPartNumber = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
