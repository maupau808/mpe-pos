/* Document numbers: one letter for the type (Q quote, R receipt, L invoice), one place digit
 * (1 Mac app, 2 PC Left app, 3 PC Right app, 9 any web browser), then a count. No dashes or spaces: L21001.
 * Each letter+place pair has its own count, first number 1001 (the count never restarts per letter+digit).
 * The Desktop app keeps its count in its main process (POSDesktop/src/place-numbering.js) so two sale tabs can never
 * match; after a reinstall it continues from the highest number for its digit already in Transactions column P.
 * A browser (digit 9) reads that maximum at save, writes, reads back, and moves its own row on a clash.
 * Pure logic: the page hands in the adapters (sheet read, cell write, Desktop bridge). QuickBooks numbers are digits only. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MPELedgerNumbering = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const LETTERS = Object.freeze({ quote: 'Q', receipt: 'R', invoice: 'L' });
  const FORMAT = /^[QRL][1239]\d+$/;
  const PARSE = /^([QRL])([1239])(\d+)$/;
  const BASE = 1000;
  const BROWSER = 9;
  const MAX_TRIES = 6;
  const NUMBER_COLUMN = 15; // Transactions column P

  const letterFor = docType => LETTERS[docType] || null;
  function parse(text) {
    const m = PARSE.exec(String(text == null ? '' : text).trim());
    return m ? { letter: m[1], digit: Number(m[2]), count: Number(m[3]) } : null;
  }
  function maxCount(numbers, letter, digit) {
    let max = BASE;
    for (const value of numbers) {
      const p = parse(value);
      if (p && p.letter === letter && p.digit === digit && Number.isSafeInteger(p.count)) max = Math.max(max, p.count);
    }
    return max;
  }
  const txnRows = rows => (rows || []).map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row[0] || '').trim().toUpperCase() === 'TXN');
  const sheetNumbers = rows => txnRows(rows).map(({ row }) => row[NUMBER_COLUMN]);
  const defaultSleep = (attempt) => new Promise(resolve => setTimeout(resolve, Math.random() * 250 * attempt));

  // place: { digit() -> 0|1|2|3, next({ letter, floor? }) -> { ok, count } | { needFloor } } (Desktop main process), or absent in a browser.
  // readRows() -> Transactions A:P rows. writeNumber(sheetRowNumber, number) writes column P of that 1-based row.
  // localNumbers() -> numbers saved on this device but maybe not on the sheet yet.
  function create({ place = null, readRows, writeNumber, localNumbers = () => [], log = () => {}, sleep = defaultSleep, timeoutMs = 3000 } = {}) {
    const issued = new Map(); // browser only: last count handed out by this page, per letter

    async function floorFor(letter, digit) {
      return maxCount([...sheetNumbers(await readRows()), ...localNumbers()], letter, digit);
    }

    async function issue(docType) {
      const letter = letterFor(docType);
      if (!letter) throw new Error('This document type has no number');
      let digit = 0;
      if (place) {
        try { digit = Number(await place.digit()) || 0; } catch (error) { log('place digit unavailable', error); }
        if (!digit) log('this app has no place digit set; numbering as a browser (digit 9)');
      }
      if (digit) {
        let reply = await place.next({ letter });
        if (reply && reply.needFloor) reply = await place.next({ letter, floor: await floorFor(letter, digit) });
        if (!reply || !reply.ok) throw new Error('Desktop did not issue a number');
        return `${letter}${digit}${reply.count}`;
      }
      const count = Math.max(await floorFor(letter, BROWSER), issued.get(letter) || 0) + 1;
      issued.set(letter, count);
      return `${letter}${BROWSER}${count}`;
    }

    // Printing never waits longer than timeoutMs on the sheet or on Desktop: the caller then falls back to the minute number.
    function next(docType) {
      let timer;
      const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('numbering timed out')), timeoutMs); });
      return Promise.race([issue(docType), late]).finally(() => clearTimeout(timer));
    }

    // After the row is on the sheet: a browser number that another row also holds is replaced on THIS row. Returns the number kept.
    async function settle({ number, txnId }) {
      let current = parse(number);
      if (!current || current.digit !== BROWSER) return number;
      let kept = String(number);
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        const rows = await readRows();
        const mine = txnRows(rows).find(({ row }) => String(row[1] || '') === String(txnId));
        if (!mine) throw new Error('Saved row not found for numbering check');
        const clash = txnRows(rows).some(({ row }) => String(row[1] || '') !== String(txnId)
          && String(row[NUMBER_COLUMN] || '').trim() === kept);
        if (!clash) return kept;
        const count = Math.max(maxCount(sheetNumbers(rows), current.letter, BROWSER), issued.get(current.letter) || 0) + 1;
        issued.set(current.letter, count);
        kept = `${current.letter}${BROWSER}${count}`;
        await writeNumber(mine.index + 1, kept);
        log('number clash; moved this row to', kept);
        await sleep(attempt, txnId);
      }
      throw new Error('Could not settle a unique document number');
    }

    return { next, settle };
  }

  // A PC whose register was chosen as 2 or 3 in Admin (page storage) but whose Desktop has no digit yet adopts it. Mac (already 1) is untouched.
  async function syncDigit({ place, chosen }) {
    const digit = Number(chosen);
    if (!place || ![2, 3].includes(digit)) return false;
    if (Number(await place.digit()) !== 0) return false;
    await place.setDigit(digit);
    return true;
  }

  return { LETTERS, FORMAT, BASE, parse, maxCount, letterFor, create, syncDigit };
});
