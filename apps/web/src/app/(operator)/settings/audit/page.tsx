/**
 * Settings → Who changed what (T-035, FR-024, PLAN §9.3 "Audit log": Owner only). Every change in
 * the business as a plain sentence, newest first, with filters (IST days, who, what, which change)
 * and before/after details with secrets hidden and phones masked.
 *
 * Owner only, twice: Staff get a 404 here (the menu's capability, like the placeholder was), and
 * `listAuditEvents` itself refuses anyone but the Owner (FORBIDDEN), so hiding the page is not the
 * guard. Paging is keyset (`?after=`), so it stays fast on 100k+ events.
 */
import { type AuditActorOption, listAuditEvents } from "@cb/core";
import { businessDateOf } from "@cb/domain";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { AuditLog } from "./audit-log";
import { type AuditSearchParams, readAuditQuery } from "./filters";

export const dynamic = "force-dynamic";
export const generateMetadata = () => placeholderMetadata("settings_audit");

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  const ctx = await getTenantContext();
  if (!canSeeRoute("settings_audit", roleCan(ctx.role))) notFound();

  const runtime = getServerRuntime();
  const query = readAuditQuery(await searchParams);
  const call = (cursor: string | null) =>
    listAuditEvents.call(runtime, ctx, {
      ...query.input,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
  let cursor = query.cursor;
  let result = await call(cursor);
  // A spoiled page link (`?after=` edited by hand) starts again from the newest.
  if (!result.ok && result.error.code === "VALIDATION" && cursor) {
    cursor = null;
    result = await call(null);
  }
  // A person of another business (or a made-up id) has made no changes here.
  if (!result.ok && result.error.code !== "NOT_FOUND") {
    throw new Error(`audit.list failed: ${result.error.code}`);
  }
  const page = result.ok ? result.value : null;
  // The "Who" list even when the person filter matched nobody.
  let actors: readonly AuditActorOption[] = page ? page.actors : [];
  if (!page) {
    const everyone = await listAuditEvents.call(runtime, ctx, { limit: 1 });
    if (everyone.ok) actors = everyone.value.actors;
  }

  const [t, shell] = await Promise.all([getTranslations("audit"), getTranslations("shell")]);
  const today = businessDateOf(runtime.now());

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader title={shell("routes.settings_audit")} description={t("description")} />
      <AuditLog
        events={page?.events ?? []}
        actors={actors}
        values={query.values}
        nextCursor={page?.nextCursor ?? null}
        paged={cursor !== null}
        badDates={query.badDates}
        today={today}
        monthStart={`${today.slice(0, 8)}01`}
      />
    </div>
  );
}
