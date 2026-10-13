/**
 * `/payments`: the payment register (T-048, PLAN §12.1 "Payments", FR-013). Every payment of the
 * chosen IST days (default today), newest first, filtered by who took it, cash/UPI and status;
 * totals of cash and UPI leave cancelled payments out. "Take payment" is the page's one primary
 * action; "Payments to check" and (Owner) "Undo payment" are linked under the header.
 * Owner and Staff (`payments.record` for the section, `dashboard.view` for the read).
 */
import { listPayments, PAYMENT_LIST_STATUSES, type PaymentListStatus } from "@cb/core";
import { type BusinessDate, businessDateOf } from "@cb/domain";
import { Amount, Button, Card, Icon, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { dayParam, monthStart, type Translate, withQuery } from "@/components/payments/format";
import {
  NoPayments,
  Pager,
  PaymentsTable,
  RegisterFilters,
} from "@/components/payments/payment-parts";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.payments") };
}

export default async function PaymentRegisterPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const ctx = await getTenantContext();
  const can = roleCan(ctx.role);
  if (!canSeeRoute("payments", can)) notFound();

  const params = await searchParams;
  const runtime = getServerRuntime();
  const today = businessDateOf(runtime.now());
  let from: BusinessDate = dayParam(params.from) ?? today;
  let to: BusinessDate = dayParam(params.to) ?? (dayParam(params.from) ? from : today);
  const badDates = from > to;
  if (badDates) {
    from = today;
    to = today;
  }
  const collector = UUID.test(one(params.collector)) ? one(params.collector).toLowerCase() : "";
  const method =
    one(params.method) === "cash" || one(params.method) === "upi" ? one(params.method) : "";
  const statusParam = one(params.status);
  const status: PaymentListStatus = (PAYMENT_LIST_STATUSES as readonly string[]).includes(
    statusParam,
  )
    ? (statusParam as PaymentListStatus)
    : "all";
  const page = Math.max(1, Math.min(Number.parseInt(one(params.page), 10) || 1, 200));

  const [tr, shell] = await Promise.all([getTranslations("payments"), getTranslations("shell")]);
  const t = tr as unknown as Translate;
  const result = await listPayments.call(runtime, ctx, {
    from,
    to,
    status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    ...(collector ? { collectorId: collector } : {}),
    ...(method ? { method: method as "cash" | "upi" } : {}),
  });
  // A collector of another business (or a made-up id) lists nothing, like an empty day.
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`payments.list failed: ${result.error.code}`);
  }
  const register = result.ok ? result.value : null;
  const rows = register?.rows ?? [];
  const totals = register?.totals ?? {
    count: 0,
    cashPaise: 0,
    upiPaise: 0,
    cancelledCount: 0,
    toCheckCount: 0,
  };
  // The to-check count of the whole business (not just these days), for the link.
  const waiting = await listPayments.call(runtime, ctx, { status: "to_check", limit: 1 });
  const toCheck = waiting.ok ? waiting.value.totals.toCheckCount : 0;

  const filters = {
    from: from === today ? "" : from,
    to: to === today ? "" : to,
    collector,
    method,
    status: status === "all" ? "" : status,
  };
  const pageHref = (n: number) =>
    withQuery("/payments", { ...filters, page: n > 1 ? String(n) : "" });

  const takePayment = (
    <Button asChild size="lg" icon="collect">
      <Link href="/payments/new" data-action="take-payment">
        {tr("register.take_payment")}
      </Link>
    </Button>
  );

  return (
    <div className={`flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}`}>
      <ShellPageHeader
        title={shell("routes.payments")}
        description={tr("register.description")}
        action={takePayment}
      />
      <nav aria-label={tr("register.links_label")} className="flex flex-wrap gap-3">
        <Button asChild variant="secondary" icon="danger">
          <Link href="/payments/review">{tr("register.to_check_link", { count: toCheck })}</Link>
        </Button>
        {can("payments.reverse") ? (
          <Button asChild variant="secondary" icon="undo">
            <Link href="/payments/reversals">{tr("register.undo_link")}</Link>
          </Button>
        ) : null}
      </nav>

      <RegisterFilters
        values={{ from, to, collector, method, status }}
        collectors={register?.collectors ?? []}
        quick={{
          today: "/payments",
          month: withQuery("/payments", { from: monthStart(today), to: today }),
        }}
      />
      {badDates ? (
        <p role="alert" className="flex items-center gap-2 text-base text-danger">
          <Icon name="danger" className="shrink-0" />
          {tr("register.bad_dates")}
        </p>
      ) : null}

      <section
        aria-label={tr("register.totals_label")}
        className="grid grid-cols-2 gap-4 sm:grid-cols-3"
      >
        <Card className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-base text-cash">
            <Icon name="cash" />
            {tr("method.cash")}
          </span>
          <Amount paise={totals.cashPaise} size="2xl" weight="strong" data-testid="total-cash" />
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-base text-upi">
            <Icon name="upi" />
            {tr("method.upi")}
          </span>
          <Amount paise={totals.upiPaise} size="2xl" weight="strong" data-testid="total-upi" />
        </Card>
        <Card className="col-span-2 flex flex-col justify-center gap-1 sm:col-span-1">
          <span className="text-lg text-text" data-testid="total-count">
            {tr("register.count", { count: totals.count })}
          </span>
          {totals.cancelledCount > 0 ? (
            <span className="text-base text-danger">
              {tr("register.cancelled_count", { count: totals.cancelledCount })}
            </span>
          ) : null}
        </Card>
      </section>

      <PaymentsTable
        rows={rows}
        caption={t("register.caption")}
        empty={<NoPayments message={t("register.empty")} />}
      />
      <Pager page={page} hasMore={register?.hasMore ?? false} href={pageHref} />
    </div>
  );
}
