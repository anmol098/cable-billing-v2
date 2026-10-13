/**
 * `GET /r/<token>/pdf`: the same receipt as an A5 PDF download (T-050). Same rate limits, lookup,
 * generic pages and headers as the page (`../_lib/handler.ts`); `?lang=hi|en` as on the page.
 */
import { receiptDocument } from "../_lib/content";
import { lookUpReceipt, RECEIPT_RESPONSE_HEADERS } from "../_lib/handler";
import { receiptLocale, translatorFor } from "../_lib/i18n";
import { pdfFileName, receiptPdf } from "../_lib/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const found = await lookUpReceipt(request, token, "pdf");
  if (found.kind === "response") return found.response;

  const locale = receiptLocale(new URL(request.url), found.receipt.operator.language);
  const doc = receiptDocument(found.receipt, locale, translatorFor(locale));
  const pdf = await receiptPdf(doc, found.now);
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...RECEIPT_RESPONSE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFileName(found.receipt.receiptNumber)}"`,
      "Content-Length": String(pdf.length),
    },
  });
}
