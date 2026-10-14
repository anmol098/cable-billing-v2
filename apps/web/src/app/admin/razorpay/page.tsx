/**
 * `/admin/razorpay?filter=&cursor=`: Razorpay webhook deliveries (T-085's `subscription_events`):
 * event, operator, received / processed, error code. Never the payload. T-086, PLAN §12.4.
 */
import { type AdminRazorpayEventRow, listRazorpayEvents } from "@cb/core";
import { Button, DataTable, StatusPill } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { getServerRuntime } from "@/lib/auth/server";
import { AdminPageHeader } from "../_components/parts";
import { getAdminContext } from "../_lib/context";
import { displayLocale, param, timeText } from "../_lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("razorpay.title"), robots: { index: false } };
}

export default async function AdminRazorpayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAdminContext();
  const query = await searchParams;
  const filter = param(query.filter) === "problems" ? "problems" : "all";
  const cursor = param(query.cursor);
  const [result, t, locale] = await Promise.all([
    listRazorpayEvents.call(getServerRuntime(), ctx, { filter, ...(cursor ? { cursor } : {}) }),
    getTranslations("admin"),
    getLocale(),
  ]);
  if (!result.ok) throw new Error(`admin razorpay: ${result.error.code}`);
  const dl = displayLocale(locale);

  return (
    <>
      <AdminPageHeader title={t("razorpay.title")} description={t("razorpay.description")} />
      <nav className="flex gap-2" aria-label={t("razorpay.filter")}>
        <Button asChild variant={filter === "all" ? "primary" : "secondary"}>
          <Link href="/admin/razorpay">{t("razorpay.all")}</Link>
        </Button>
        <Button asChild variant={filter === "problems" ? "primary" : "secondary"} icon="danger">
          <Link href="/admin/razorpay?filter=problems">{t("razorpay.problems")}</Link>
        </Button>
      </nav>
      <DataTable<AdminRazorpayEventRow>
        caption={t("razorpay.caption")}
        rows={result.value.rows}
        rowKey={(r) => r.eventId}
        empty={t("razorpay.empty")}
        columns={[
          {
            id: "event",
            header: t("razorpay.col.event"),
            primary: true,
            cell: (r) => (
              <span className="flex flex-col">
                <code className="font-strong">{r.type}</code>
                <span className="text-sm text-text-muted">{r.razorpayEventId}</span>
              </span>
            ),
          },
          {
            id: "operator",
            header: t("razorpay.col.operator"),
            cell: (r) =>
              r.operatorId ? (
                <Link className="underline" href={`/admin/tenants/${r.operatorId}`}>
                  {r.operatorName ?? r.operatorId}
                </Link>
              ) : (
                t("razorpay.unmatched")
              ),
          },
          {
            id: "received",
            header: t("razorpay.col.received"),
            cell: (r) => timeText(r.receivedAt, dl),
          },
          {
            id: "result",
            header: t("razorpay.col.result"),
            cell: (r) =>
              r.processingError ? (
                <span className="flex flex-col">
                  <StatusPill variant="danger" label={t("razorpay.error")} />
                  <code className="text-sm">{r.processingError}</code>
                </span>
              ) : r.processedAt ? (
                <StatusPill variant="success" label={t("razorpay.applied")} />
              ) : (
                <StatusPill variant="pending" label={t("razorpay.not_processed")} />
              ),
          },
        ]}
      />
      {result.value.nextCursor ? (
        <div>
          <Button asChild variant="secondary" icon="next">
            <Link
              href={`/admin/razorpay?${new URLSearchParams({
                ...(filter === "problems" ? { filter } : {}),
                cursor: result.value.nextCursor,
              }).toString()}`}
            >
              {t("common.more")}
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  );
}
