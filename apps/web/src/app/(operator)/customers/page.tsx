/**
 * Customers (T-033, PLAN §12.1, FR-003): search by code / name / mobile no. / VC number, filter
 * by area and status, and a table of code, name, area, due and status (cards on phones). One
 * primary action: "Add customer" (Owner and Staff, `customers.manage`). Rows open the profile.
 */
import { type CustomerListRow, MAX_CUSTOMER_OFFSET, searchCustomers } from "@cb/core";
import {
  Amount,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  PAGE_ACTION_CLEARANCE,
} from "@cb/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { RowLink } from "./_components/row-link";
import { CustomerSearchForm } from "./_components/search-form";
import { searchHref } from "./_components/search-href";
import { callAsUser, loadFormOptions } from "./_components/server";
import { ActivePill } from "./_components/status-pills";

export const generateMetadata = () => placeholderMetadata("customers");

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getTenantContext();
  const can = roleCan(ctx.role);
  if (!canSeeRoute("customers", can)) notFound();

  const params = await searchParams;
  const q = one(params.q).slice(0, 100);
  const areaParam = one(params.area);
  const area = areaParam === "none" || UUID.test(areaParam) ? areaParam : "";
  const statusParam = one(params.status);
  const status = statusParam === "active" || statusParam === "inactive" ? statusParam : "";
  const pageNumber = Math.max(1, Math.min(Number.parseInt(one(params.page), 10) || 1, 200));
  const offset = Math.min((pageNumber - 1) * PAGE_SIZE, MAX_CUSTOMER_OFFSET);

  const [t, shell, options] = await Promise.all([
    getTranslations("customers"),
    getTranslations("shell"),
    loadFormOptions(),
  ]);
  const result = await callAsUser(
    searchCustomers,
    {
      q,
      status: status || "all",
      limit: PAGE_SIZE,
      offset,
      ...(area ? { areaId: area } : {}),
    },
    ctx,
  );
  // An area of another business (or one removed since) lists nobody, like an empty search.
  const rows = result.ok ? result.value.rows : [];
  const hasMore = result.ok && result.value.hasMore;
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`customers.search failed: ${result.error.code}`);
  }

  const searching = q.trim() !== "" || area !== "" || status !== "";
  const canAdd = can("customers.manage");
  const addButton = canAdd ? (
    <Button asChild size="lg" icon="add">
      <Link href="/customers/new">{t("list.add")}</Link>
    </Button>
  ) : undefined;

  const columns: DataTableColumn<CustomerListRow>[] = [
    {
      id: "code",
      header: t("list.col_code"),
      cell: (row) => <span className="font-numeric">{row.customerCode}</span>,
    },
    {
      id: "name",
      header: t("list.col_name"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.name}</span>
          {row.matchedVcNumber ? (
            <span className="font-numeric font-regular text-sm text-text-muted">
              {t("list.matched_vc", { vc: row.matchedVcNumber })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "area",
      header: t("list.col_area"),
      cell: (row) => row.areaName ?? <span className="text-text-muted">{t("list.no_area")}</span>,
    },
    {
      id: "due",
      header: t("list.col_due"),
      align: "end",
      cell: (row) => (
        <Amount
          paise={row.balancePaise}
          tone="balance"
          dueLabel={t("list.col_due")}
          creditLabel={t("profile.credit_now")}
        />
      ),
    },
    {
      id: "status",
      header: t("list.col_status"),
      cell: (row) => (
        <ActivePill active={row.status === "active"} label={t(`status.${row.status}`)} />
      ),
    },
  ];

  const pageHref = (page: number) =>
    searchHref("/customers", { q, area, status, page: page > 1 ? String(page) : "" });

  return (
    <div
      className={addButton ? `flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}` : "flex flex-col gap-6"}
    >
      <ShellPageHeader
        title={shell("routes.customers")}
        {...(addButton ? { action: addButton } : {})}
      />
      <CustomerSearchForm
        q={q}
        area={area}
        status={status}
        areas={options.areas}
        labels={{
          search: t("list.search_label"),
          placeholder: t("list.search_placeholder"),
          button: t("list.search_button"),
          area: t("list.area_label"),
          areaAll: t("list.area_all"),
          areaNone: t("list.area_none"),
          status: t("list.status_label"),
          statusAll: t("list.status_all"),
          statusActive: t("status.active"),
          statusInactive: t("status.inactive"),
        }}
      />
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        caption={t("list.caption")}
        rowHref={(row) => `/customers/${row.id}`}
        linkAs={RowLink}
        empty={
          <EmptyState
            icon={searching ? "search" : "customer"}
            message={searching ? t("list.no_match") : t("list.empty")}
          />
        }
      />
      {pageNumber > 1 || hasMore ? (
        <nav aria-label={t("list.pages")} className="flex items-center justify-between gap-3">
          {pageNumber > 1 ? (
            <Button asChild variant="secondary" icon="back">
              <Link href={pageHref(pageNumber - 1)}>{t("list.previous")}</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="font-numeric text-text-muted">
            {t("list.page", { page: pageNumber })}
          </span>
          {hasMore ? (
            <Button asChild variant="secondary" icon="next">
              <Link href={pageHref(pageNumber + 1)}>{t("list.next")}</Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
