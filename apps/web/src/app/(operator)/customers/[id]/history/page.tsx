/**
 * Customer profile, History tab (T-049; BRD §12 "Customer account statement"; FR-011; PLAN §12.1
 * "History (ledger + audit)"): what was charged, paid, cancelled and given back, and what is due,
 * for a choice of days (`?range=month|3m|12m|all` or `?from=&to=`, IST dates). Every line is a
 * ledger entry with the balance after it, so the closing balance "as of now" is the customer's
 * balance. "Print statement" opens the printable statement for the same days
 * (`/customers/[id]/history/print`). Owner and Staff (`dashboard.view`); another business's
 * customer and made-up ids answer 404.
 */
import { customerStatement } from "@cb/core";
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import { Button } from "@cb/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Translate } from "@/components/bills/format";
import { roleCan } from "@/components/shell/access";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { CustomerProfileShell } from "../../_components/profile-shell";
import { loadCustomerProfile } from "../../_components/server";
import { pickStatementRange, statementPrintHref } from "./_components/range";
import {
  StatementLines,
  StatementRangePicker,
  StatementSummary,
} from "./_components/statement-view";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const [profile, shell] = await Promise.all([loadCustomerProfile(id), getTranslations("shell")]);
  const tab = shell("routes.customer_history");
  return { title: profile ? `${profile.name} · ${tab}` : tab };
}

export default async function CustomerHistoryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ id }, query, ctx] = await Promise.all([params, searchParams, getTenantContext()]);
  if (!roleCan(ctx.role)("dashboard.view")) notFound();
  const runtime = getServerRuntime();
  const choice = pickStatementRange(query, businessDateOf(runtime.now()));
  const result = await customerStatement.call(runtime, ctx, {
    customerId: id,
    from: choice.from,
    to: choice.to,
  });
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION") notFound();
    throw new Error(`statement: ${result.error.code}`);
  }
  const view = result.value;
  const [ts, tbills, locale] = await Promise.all([
    getTranslations("statements"),
    getTranslations("bills"),
    getLocale(),
  ]);
  const t = ts as unknown as Translate;
  const tb = tbills as unknown as Translate;
  const displayLocale = locale as DisplayLocale;

  return (
    <CustomerProfileShell customerId={id} tab="history">
      <div className="flex flex-col gap-6" data-statement={view.customer.id}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-strong text-xl">{t("history.title")}</h2>
          <Button asChild variant="secondary" icon="print">
            {/* A plain link: the printable statement is a route handler (no client navigation). */}
            <a
              href={`${statementPrintHref(view.customer.id, choice)}&auto=1`}
              data-action="print-statement"
            >
              {t("history.print")}
            </a>
          </Button>
        </div>
        <StatementRangePicker
          customerId={view.customer.id}
          choice={choice}
          range={view.range}
          t={t}
        />
        <StatementSummary view={view} t={t} locale={displayLocale} />
        <StatementLines view={view} t={t} tb={tb} locale={displayLocale} />
      </div>
    </CustomerProfileShell>
  );
}
