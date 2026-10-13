/**
 * `GET /customers/[id]/history/print[?range=…|?from=&to=][&auto=1]` (T-049): the customer's
 * statement for the same days as the History tab, as one printable A4 page (print it, or "Save as
 * PDF" in the print dialog) in the **operator's** language (`settings.default_language`, like the
 * printed bill). A route handler, not a page, so the operator shell is not printed.
 *
 * Same gate as the tab: `getTenantContext()` (sign-in; redirects to /login), `customerStatement`
 * (`dashboard.view`: Owner and Staff; another tenant's or a made-up id → 404).
 */
import { customerStatement } from "@cb/core";
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import { getTranslations } from "next-intl/server";
import type { Translate } from "@/components/bills/format";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { statementPrintHtml } from "../_components/print-html";
import { historyHref, pickStatementRange } from "../_components/range";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext();
  const { id } = await params;
  const runtime = getServerRuntime();
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const choice = pickStatementRange(query, businessDateOf(runtime.now()));
  const result = await customerStatement.call(runtime, ctx, {
    customerId: id,
    from: choice.from,
    to: choice.to,
  });
  if (!result.ok) {
    const code = result.error.code;
    const hidden = code === "NOT_FOUND" || code === "VALIDATION" || code === "FORBIDDEN";
    if (!hidden) console.error("statements.print_failed", code);
    return new Response(null, { status: hidden ? 404 : 500, headers: NO_STORE });
  }
  const view = result.value;
  const locale: DisplayLocale = view.operator.language;
  const [t, tb] = await Promise.all([
    getTranslations({ locale, namespace: "statements" }),
    getTranslations({ locale, namespace: "bills" }),
  ]);
  const html = statementPrintHtml(
    view,
    t as unknown as Translate,
    tb as unknown as Translate,
    locale,
    {
      autoPrint: url.searchParams.get("auto") === "1",
      backHref: historyHref(view.customer.id, choice),
    },
  );
  return new Response(html, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
