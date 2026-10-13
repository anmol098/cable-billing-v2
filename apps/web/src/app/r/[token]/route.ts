/**
 * `GET /r/<token>`: the public receipt preview page (T-050, FR-021, PLAN §9.4).
 *
 * A route handler rather than a React page, on purpose: it controls the status code (404 / 429 /
 * 503 for the generic pages) and the headers (`X-Robots-Tag`, `no-store`, `no-referrer`), and it
 * sends one small HTML document with inline token styles and **no JavaScript** (works with JS
 * disabled and on low-end phones). Privacy rules and the lookup are in `@cb/core`
 * (`openReceiptLink`) and `./_lib/handler.ts`.
 *
 * `?lang=hi|en` picks the language (default: the operator's default language).
 */
import { receiptDocument } from "./_lib/content";
import { lookUpReceipt, RECEIPT_RESPONSE_HEADERS } from "./_lib/handler";
import { receiptPageHtml } from "./_lib/html";
import { receiptLocale, translatorFor } from "./_lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const found = await lookUpReceipt(request, token, "html");
  if (found.kind === "response") return found.response;

  const locale = receiptLocale(new URL(request.url), found.receipt.operator.language);
  const t = translatorFor(locale);
  const doc = receiptDocument(found.receipt, locale, t);
  // The token passed the shape check (43 base64url characters), so it is safe in a path.
  const base = `/r/${token}`;
  const html = receiptPageHtml(doc, t, {
    pdf: `${base}/pdf?lang=${locale}`,
    languages: { hi: `${base}?lang=hi`, en: `${base}?lang=en` },
  });
  return new Response(html, {
    status: 200,
    headers: { ...RECEIPT_RESPONSE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}
