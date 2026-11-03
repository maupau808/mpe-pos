# MPE POS project notes

## UPC bindings for custom “Other” items (2026-08-18)

UPC bindings are stored in the `Codes` Google Sheet and cached in `mpePartCodeLearned` in browser local storage.

Previously a reviewed scan bound to the catalog’s **Other** item was saved immediately as only `UPC → Other`. Edits made afterward to the custom part number, description, price, and cost were not part of the binding, so later scans loaded generic Other at $1.

Current behavior:

- Ordinary product bindings remain compatible with the original five-column Codes records.
- Selecting Other for an unmatched UPC defers the binding while the operator edits the line.
- The completed custom part number, description, price, and cost are cached locally and written to new Codes columns F–H.
- Codes automatically migrates from the five-column header to eight columns.
- Signed-in registers read the extended records so custom UPCs work across computers.
- A legacy `UPC → Other` binding is treated as incomplete and returns to review once. Saving the resulting custom line replaces it with a complete binding.
- Rapid typing is debounced into one pending sheet write; local state is updated immediately.

The main implementation is in `index.html`: `queuePartCodeBinding`, `saveCustomPartCodeBinding`, `rebuildCustomCodeMap`, `resolveScannedValue`, and `_flushPendingPartCodes`.
