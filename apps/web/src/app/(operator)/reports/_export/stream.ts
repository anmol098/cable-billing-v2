/**
 * An open export (`@cb/core` `openExport`) → a streamed CSV body (T-082): the UTF-8 byte-order mark
 * (so Excel shows Hindi), the heading row, then each page of rows as it is read, so a big export
 * never sits in memory or waits for the last page before the first byte goes out. When rows were
 * left out (the row cap) the file ends with one line that says so, in words.
 */
import { type AnyExportHandle, CSV_BOM, csvLine, type ExportKind } from "@cb/core";
import { headerCells, rowCells, type Words } from "./columns";

/** The lines of the CSV, one chunk per page. */
export async function* csvChunks(handle: AnyExportHandle, t: Words): AsyncGenerator<string> {
  const kind: ExportKind = handle.kind;
  yield `${CSV_BOM}${csvLine(headerCells(kind, t))}`;
  let count = 0;
  const pages = handle.pages() as AsyncGenerator<readonly unknown[]>;
  for await (const page of pages) {
    let chunk = "";
    for (const row of page) chunk += csvLine(rowCells(kind, row as never, t));
    count += page.length;
    yield chunk;
  }
  if (handle.truncated) yield csvLine([t("exports.truncated", { count })]);
}

/** The CSV as a byte stream for a `Response`. Pulls a page only when the client reads. */
export function csvStream(
  handle: AnyExportHandle,
  t: Words,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = csvChunks(handle, t);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        onError(error);
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
