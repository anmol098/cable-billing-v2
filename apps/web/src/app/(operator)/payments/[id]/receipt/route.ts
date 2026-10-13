/**
 * `GET /payments/<id>/receipt`: the payment's receipt as an **A5 PDF** shown in the browser
 * (`inline`), for the office to print and hand over (T-048, PLAN §12.1 "print"). The same content,
 * layout and fonts as the customer's receipt link PDF (T-050 `receiptDocument` + `receiptPdf`:
 * first name + masked phone, no UPI ref or notes; Devanagari shaped by the bundled Noto fonts);
 * a cancelled payment prints with the "Cancelled" stamp. Language: `?lang=hi|en`, else the
 * business's receipt language.
 *
 * Signed-in Owner/Staff only (`getTenantContext()` redirects others to sign in); the read service
 * answers NOT_FOUND for another business's payment → 404. Private, never cached.
 */
import { getPaymentReceipt } from "@cb/core";
import { receiptDocument } from "@/app/r/[token]/_lib/content";
import { receiptLocale, translatorFor } from "@/app/r/[token]/_lib/i18n";
import { pdfFileName, receiptPdf } from "@/app/r/[token]/_lib/pdf";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getTenantContext();
  const { id } = await context.params;
  if (!UUID.test(id)) return notFoundResponse();
  const runtime = getServerRuntime();
  const result = await getPaymentReceipt.call(runtime, ctx, { paymentId: id });
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "FORBIDDEN") {
      return notFoundResponse();
    }
    throw new Error(`payments.receipt failed: ${result.error.code}`);
  }
  const receipt = result.value;
  const locale = receiptLocale(new URL(request.url), receipt.operator.language);
  const doc = receiptDocument(receipt, locale, translatorFor(locale));
  const pdf = await receiptPdf(doc, runtime.now());
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${pdfFileName(receipt.receiptNumber)}"`,
      "Content-Length": String(pdf.length),
    },
  });
}
