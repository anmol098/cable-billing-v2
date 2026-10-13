/**
 * `GET /bills/[id]/print[?auto=1]` (T-047, PLAN §12.1 "Printable A5 bill"): the bill as one A5
 * page in the **operator's** language (`settings.default_language`, the language of its receipts),
 * whatever language the signed-in user reads the app in. A route handler, not a page, so the
 * operator shell is not around it and the browser prints only the bill.
 *
 * Same gate as the pages: `getTenantContext()` (sign-in; redirects to /login), `getBill`
 * (`billing.preview`: Owner and Staff; another tenant's or a made-up id → 404).
 */
import { getBill } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { getTranslations } from "next-intl/server";
import type { Translate } from "@/components/bills/format";
import { billPrintHtml } from "@/components/bills/print-html";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext();
  const { id } = await params;
  const runtime = getServerRuntime();
  const result = await getBill.call(runtime, ctx, { invoiceId: id });
  if (!result.ok) {
    const missing = result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION";
    if (!missing && result.error.code !== "FORBIDDEN") {
      console.error("bills.print_failed", result.error.code);
    }
    return new Response(null, {
      status: missing || result.error.code === "FORBIDDEN" ? 404 : 500,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const locale: DisplayLocale = result.value.operator.language;
  const t = (await getTranslations({ locale, namespace: "bills" })) as unknown as Translate;
  const autoPrint = new URL(request.url).searchParams.get("auto") === "1";
  const html = billPrintHtml(result.value, t, locale, { autoPrint, now: runtime.now() });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
