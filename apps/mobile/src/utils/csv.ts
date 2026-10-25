export type CsvCell = string | number;

// Spreadsheet apps execute cells starting with these as formulas. Package and
// cashier names are user-entered, so prefix them to keep exports inert.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(cell: CsvCell): string {
  if (typeof cell === "number") return String(cell);
  const guarded = FORMULA_PREFIX.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/** RFC 4180 CSV with CRLF line endings and a UTF-8 BOM so Excel and Google
 * Sheets read Indonesian text and rupiah values correctly. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${rows.map((row) => row.map(escapeCell).join(",")).join("\r\n")}\r\n`;
}
