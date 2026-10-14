/**
 * `/admin/jobs?status=&period=&cursor=`: background jobs across all operators (T-043) with "Try
 * again" for failed ones, and the billing runs of one month across operators (T-044, counts and
 * problem reasons only). T-086, PLAN §12.4, §14.
 */
import { type AdminJobRow, listBillingRuns, listJobs } from "@cb/core";
import { JOB_STATUSES, type JobStatus } from "@cb/db";
import { periodOfInstant } from "@cb/domain";
import { Button, DataTable, Select, StatusPill, type StatusPillVariant } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { getServerRuntime } from "@/lib/auth/server";
import { AdminPageHeader, Outcome, Section } from "../_components/parts";
import { getAdminContext } from "../_lib/context";
import { displayLocale, monthText, param, timeText } from "../_lib/format";
import { retryJobAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("jobs.title"), robots: { index: false } };
}

const JOB_PILL: Record<JobStatus, StatusPillVariant> = {
  queued: "pending",
  running: "pending",
  succeeded: "success",
  failed: "danger",
};
const DONE = ["retried"] as const;
const ERRORS = ["already_queued", "not_failed", "not_found", "generic"] as const;
const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((item) => item === value);

function isJobStatus(value: string | undefined): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value ?? "");
}

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAdminContext();
  const query = await searchParams;
  const statusParam = param(query.status);
  const status = isJobStatus(statusParam) ? statusParam : undefined;
  const cursor = param(query.cursor);
  const runtime = getServerRuntime();
  const periodParam = param(query.period);
  const period =
    periodParam && /^\d{4}-\d{2}-01$/.test(periodParam)
      ? periodParam
      : periodOfInstant(runtime.now());
  const [jobs, runs, t, locale] = await Promise.all([
    listJobs.call(runtime, ctx, {
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    listBillingRuns.call(runtime, ctx, { period }),
    getTranslations("admin"),
    getLocale(),
  ]);
  if (!jobs.ok) throw new Error(`admin jobs: ${jobs.error.code}`);
  if (!runs.ok) throw new Error(`admin runs: ${runs.error.code}`);
  const dl = displayLocale(locale);
  const done = oneOf(DONE, param(query.done));
  const error = oneOf(ERRORS, param(query.error));

  return (
    <>
      <AdminPageHeader title={t("jobs.title")} description={t("jobs.description")} />
      {done ? <Outcome tone="success">{t(`jobs.done.${done}`)}</Outcome> : null}
      {error ? <Outcome tone="danger">{t(`jobs.error.${error}`)}</Outcome> : null}

      <Section title={t("jobs.queue")} data-admin="jobs">
        <ul className="flex flex-wrap gap-3">
          {JOB_STATUSES.map((s) => (
            <li key={s} className="flex items-center gap-2">
              <StatusPill variant={JOB_PILL[s]} label={t(`job_status.${s}`)} />
              <span className="font-numeric font-strong">{jobs.value.countsByStatus[s] ?? 0}</span>
            </li>
          ))}
        </ul>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="job-status" className="font-strong">
              {t("jobs.status_filter")}
            </label>
            <Select id="job-status" name="status" defaultValue={status ?? ""}>
              <option value="">{t("jobs.all")}</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`job_status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary" icon="search">
            {t("jobs.show")}
          </Button>
        </form>
        <DataTable<AdminJobRow>
          caption={t("jobs.caption")}
          rows={jobs.value.rows}
          rowKey={(r) => r.jobId}
          empty={t("jobs.empty")}
          columns={[
            {
              id: "type",
              header: t("jobs.col.type"),
              primary: true,
              cell: (r) => (
                <span className="flex flex-col">
                  <code className="font-strong">{r.type}</code>
                  <span className="text-sm text-text-muted">
                    {r.operatorName ?? t("jobs.platform_job")}
                  </span>
                </span>
              ),
            },
            {
              id: "status",
              header: t("jobs.col.status"),
              cell: (r) => (
                <StatusPill variant={JOB_PILL[r.status]} label={t(`job_status.${r.status}`)} />
              ),
            },
            {
              id: "tries",
              header: t("jobs.col.tries"),
              align: "end",
              cell: (r) => (
                <span className="font-numeric">
                  {r.attempts}/{r.maxAttempts}
                </span>
              ),
            },
            {
              id: "when",
              header: t("jobs.col.when"),
              cell: (r) => (
                <span className="flex flex-col">
                  <span>{timeText(r.finishedAt ?? r.createdAt, dl)}</span>
                  {r.lastError ? (
                    <span className="text-sm text-text-muted">{r.lastError}</span>
                  ) : null}
                </span>
              ),
            },
            {
              id: "action",
              header: t("jobs.col.action"),
              cell: (r) =>
                r.status === "failed" ? (
                  <form action={retryJobAction}>
                    <input type="hidden" name="jobId" value={r.jobId} />
                    <Button type="submit" variant="secondary" icon="retry">
                      {t("jobs.retry")}
                    </Button>
                  </form>
                ) : null,
            },
          ]}
        />
        {jobs.value.nextCursor ? (
          <div>
            <Button asChild variant="secondary" icon="next">
              <Link
                href={`/admin/jobs?${new URLSearchParams({
                  ...(status ? { status } : {}),
                  cursor: jobs.value.nextCursor,
                }).toString()}`}
              >
                {t("common.more")}
              </Link>
            </Button>
          </div>
        ) : null}
      </Section>

      <Section
        title={t("jobs.runs_title", { month: monthText(period, dl) })}
        data-admin="billing-runs"
      >
        {runs.value.length === 0 ? (
          <p>{t("jobs.runs_none")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.value.map((r) => (
              <li key={r.runId} className="flex flex-col border-border border-t pt-2">
                <span className="flex flex-wrap gap-x-4">
                  <Link className="font-strong underline" href={`/admin/tenants/${r.operatorId}`}>
                    {r.operatorName}
                  </Link>
                  <span>{t(`run_status.${r.status}`)}</span>
                  <span>
                    {t("tenant.runs.counts", {
                      billed: r.createdCount + r.alreadyExistsCount,
                      failed: r.failedCount,
                    })}
                  </span>
                </span>
                {Object.keys(r.failedReasons).length > 0 ? (
                  <span className="text-sm text-text-muted">
                    {Object.entries(r.failedReasons)
                      .map(([reason, n]) => `${reason}: ${n}`)
                      .join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
