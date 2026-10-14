/**
 * `/admin/audit?views=1&cursor=`: the platform audit log (events without a tenant: admin actions,
 * admin sign-ins, every cross-tenant read of the console). T-086, PLAN §12.4. The console's own
 * "viewed" events are hidden unless asked for. A tenant's own log is never shown here.
 */
import { type AdminAuditRow, listPlatformAudit } from "@cb/core";
import { Button, DataTable } from "@cb/ui";
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
  return { title: t("audit.title"), robots: { index: false } };
}

/** A short, safe summary of an event's `after` values (codes, ids, dates; never long text). */
function summary(after: unknown): string {
  if (!after || typeof after !== "object" || Array.isArray(after)) return "";
  return Object.entries(after as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    .join(" · ");
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAdminContext();
  const query = await searchParams;
  const showViews = param(query.views) === "1";
  const cursor = param(query.cursor);
  const [result, t, locale] = await Promise.all([
    listPlatformAudit.call(getServerRuntime(), ctx, {
      hideViews: !showViews,
      ...(cursor ? { cursor } : {}),
    }),
    getTranslations("admin"),
    getLocale(),
  ]);
  if (!result.ok) throw new Error(`admin audit: ${result.error.code}`);
  const dl = displayLocale(locale);

  return (
    <>
      <AdminPageHeader title={t("audit.title")} description={t("audit.description")} />
      <div>
        <Button asChild variant="secondary">
          <Link href={showViews ? "/admin/audit" : "/admin/audit?views=1"}>
            {showViews ? t("audit.hide_views") : t("audit.show_views")}
          </Link>
        </Button>
      </div>
      <DataTable<AdminAuditRow>
        caption={t("audit.caption")}
        rows={result.value.rows}
        rowKey={(r) => r.eventId}
        empty={t("audit.empty")}
        columns={[
          { id: "when", header: t("audit.col.when"), cell: (r) => timeText(r.at, dl) },
          {
            id: "who",
            header: t("audit.col.who"),
            cell: (r) => r.actorName ?? t("common.system"),
          },
          {
            id: "action",
            header: t("audit.col.action"),
            primary: true,
            cell: (r) => <code className="font-strong">{r.action}</code>,
          },
          {
            id: "about",
            header: t("audit.col.about"),
            cell: (r) =>
              r.entityType === "operator" && r.entityId ? (
                <Link className="underline" href={`/admin/tenants/${r.entityId}`}>
                  {r.operatorName ?? r.entityId}
                </Link>
              ) : (
                <code>{r.entityType}</code>
              ),
          },
          {
            id: "details",
            header: t("audit.col.details"),
            cell: (r) => <span className="text-sm text-text-muted">{summary(r.after)}</span>,
          },
        ]}
      />
      {result.value.nextCursor ? (
        <div>
          <Button asChild variant="secondary" icon="next">
            <Link
              href={`/admin/audit?${new URLSearchParams({
                ...(showViews ? { views: "1" } : {}),
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
