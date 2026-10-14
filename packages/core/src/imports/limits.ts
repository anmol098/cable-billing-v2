/**
 * Limits of the customer import (T-084). The web page shows the user-facing ones (file size,
 * rows) in words, and the route that receives the file enforces the size before reading it.
 */
export const IMPORT_LIMITS = Object.freeze({
  /** Largest file accepted (bytes). Vercel's request body limit is 4.5 MB. */
  fileBytes: 4 * 1024 * 1024,
  /** Most data lines in one file (customers × boxes). Bigger lists are split into two files. */
  rows: 5000,
  /** Columns read per line; cells further right are ignored. */
  columns: 60,
  /** Longest text kept from one cell (longer text is cut and then refused by the field checks). */
  cellChars: 1000,
  /** Largest uncompressed worksheet or shared-strings part inside an .xlsx (zip-bomb guard). */
  xlsxPartBytes: 64 * 1024 * 1024,
  /** Rows above the header that may hold a title or notes. */
  headerSearchRows: 10,
  /** Lines one import step (`imports.customers.apply`) takes. */
  applyBatchLines: 250,
  /**
   * Steps the page sends at the same time. Steps hold different customers and different VCs (a
   * VC repeated in the file is refused in the preview), so they don't wait for each other.
   */
  parallelSteps: 2,
});
