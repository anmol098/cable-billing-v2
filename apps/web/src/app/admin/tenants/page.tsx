/**
 * `/admin/tenants?q=&status=&page=`: every operator with its subscription state, active customer
 * and lineman counts and last sign-in activity (T-086, PLAN §12.4). Aggregates only.
 */
import { type AdminTenantRow, listTenants } from "@cb/core";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@cb/db";
import { Button, DataTable, Input, Select } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { getServerRuntime } from "@/lib/auth/server";
import { AdminPageHeader, SubscriptionPill } from "../_components/parts";
import { getAdminContext } from "../_lib/context";
import { dayText, displayLocale, param, timeText } from "../_lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("tenants.title"), robots: { index: false } };
}

function isStatus(value: string | undefined): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value ?? "");
}

export default async function AdminTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAdminContext();
  const params = await searchParams;
  const q = param(params.q)?.trim().slice(0, 120) || undefined;
  const statusParam = param(params.status);
  const status = isStatus(statusParam) ? statusParam : undefined;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(param(params.page) ?? "1", 10) || 1));
  const [result, t, locale] = await Promise.all([
    listTenants.call(getServerRuntime(), ctx, {
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      page,
    }),
    getTranslations("admin"),
    getLocale(),
  ]);
  if (!result.ok) throw new Error(`admin tenants: ${result.error.code}`);
  const dl = displayLocale(locale);
  const pageHref = (n: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (status) sp.set("status", status);
    sp.set("page", String(n));
    return `/admin/tenants?${sp.toString()}`;
  };

  return (
    <>
      <AdminPageHeader
        title={t("tenants.title")}
        description={t("tenants.description")}
        action={
          <Button asChild icon="add">
            <Link href="/admin/tenants/new">{t("tenants.add")}</Link>
          </Button>
        }
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="q" className="font-strong">
            {t("tenants.search")}
          </label>
          <Input id="q" name="q" defaultValue={q ?? ""} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="status" className="font-strong">
            {t("tenants.status_filter")}
          </label>
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">{t("tenants.all")}</option>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`sub_status.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary" icon="search">
          {t("tenants.find")}
        </Button>
      </form>

      <DataTable<AdminTenantRow>
        caption={t("tenants.caption")}
        rows={result.value.rows}
        rowKey={(r) => r.operatorId}
        rowHref={(r) => `/admin/tenants/${r.operatorId}`}
        linkAs={Link}
        empty={t("tenants.empty")}
        columns={[
          {
            id: "name",
            header: t("tenants.col.name"),
            primary: true,
            cell: (r) => (
              <span className="flex flex-col">
                <span className="font-strong">{r.name}</span>
                <span className="text-sm text-text-muted">
                  {t("tenants.since", { date: dayText(r.createdAt, dl) })}
                </span>
              </span>
            ),
          },
          {
            id: "subscription",
            header: t("tenants.col.subscription"),
            cell: (r) => (
              <SubscriptionPill
                status={r.subscriptionStatus}
                label={t(`sub_status.${r.subscriptionStatus ?? "none"}`)}
              />
            ),
          },
          {
            id: "customers",
            header: t("tenants.col.customers"),
            align: "end",
            cell: (r) => <span className="font-numeric">{r.activeCustomers}</span>,
          },
          {
            id: "linemen",
            header: t("tenants.col.linemen"),
            align: "end",
            cell: (r) => <span className="font-numeric">{r.linemen}</span>,
          },
          {
            id: "activity",
            header: t("tenants.col.activity"),
            cell: (r) => timeText(r.lastActivityAt, dl, t("common.never")),
          },
        ]}
      />
      <nav className="flex gap-3" aria-label={t("common.pages")}>
        {page > 1 ? (
          <Button asChild variant="secondary" icon="back">
            <Link href={pageHref(page - 1)}>{t("common.previous_page")}</Link>
          </Button>
        ) : null}
        {result.value.hasMore ? (
          <Button asChild variant="secondary" icon="next">
            <Link href={pageHref(page + 1)}>{t("common.next_page")}</Link>
          </Button>
        ) : null}
      </nav>
    </>
  );
}
