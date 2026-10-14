/**
 * `/reports/export` "Download data" (T-082, FR-029, PLAN §9.3 "Exports (CSV): Owner only"): one
 * card per file (customers, payments, bills and every report) with the days or months to take and a
 * Download button. Owner only: anyone else gets 404, like the other Owner-only pages (T-029).
 * `?problem=` is set by `/api/exports/*` when a download was refused (shown in words).
 */
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Words } from "@/app/(operator)/reports/_export/columns";
import { ExportCards } from "@/app/(operator)/reports/_export/export-cards";
import { firstParam, pickOption } from "@/components/reports/format";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.reports_export") };
}

const PROBLEMS = ["bad_filters", "not_found", "too_many", "failed"] as const;

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  if (!roleCan(ctx.role)("exports.csv")) notFound();
  const params = await searchParams;
  const now = getServerRuntime().now();
  const [all, locale] = await Promise.all([getTranslations(), getLocale()]);
  const t = all as unknown as Words;
  const problem = pickOption(params.problem, PROBLEMS);
  const wait = Math.max(1, Math.min(60, Number.parseInt(firstParam(params.wait) ?? "1", 10) || 1));

  return (
    <div className="flex flex-col gap-6">
      <ShellPageHeader
        title={t("shell.routes.reports_export")}
        description={t("exports.description")}
      />
      {problem ? (
        <p role="alert" className="text-base text-danger" data-testid="export-problem">
          {t(`exports.problem.${problem}`, { minutes: wait })}
        </p>
      ) : null}
      <p className="text-base text-text-muted">{t("exports.file_help")}</p>
      <ExportCards t={t} now={now} today={businessDateOf(now)} locale={locale as DisplayLocale} />
    </div>
  );
}
