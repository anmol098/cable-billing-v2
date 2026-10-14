/**
 * `/admin/tenants/<id>`: one operator (T-086, PLAN §12.4): subscription state and timeline, counts,
 * bill runs (counts only), the last books check, offline payments, and the actions: extend, record
 * an offline payment, open / end support access. No customer, payment or invoice data here; the
 * support view (time-boxed, reason required, in the Owner's audit log) is the only way in.
 */
import { type AdminTenantDetail, tenantDetail } from "@cb/core";
import { OFFLINE_PAYMENT_MAX_MONTHS, OFFLINE_PAYMENT_METHODS, uuidv7 } from "@cb/db";
import { businessDateOf } from "@cb/domain";
import { Button, Input, Select, StatusPill, Textarea } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getServerRuntime } from "@/lib/auth/server";
import {
  AdminPageHeader,
  Facts,
  Field,
  Outcome,
  Section,
  Stat,
  StatGrid,
  SubscriptionPill,
} from "../../_components/parts";
import { getAdminContext } from "../../_lib/context";
import {
  dayText,
  displayLocale,
  lastDayText,
  monthText,
  param,
  rupeesText,
  timeText,
} from "../../_lib/format";
import {
  endSupportAccessAction,
  extendSubscriptionAction,
  grantSupportAccessAction,
  recordOfflinePaymentAction,
} from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("tenant.title"), robots: { index: false } };
}

const DONE = [
  "created",
  "already_provisioned",
  "extended",
  "extend_no_change",
  "payment_recorded",
  "payment_already",
  "support_ended",
] as const;
const ERRORS = ["validation", "not_found", "conflict", "amount", "generic"] as const;
const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((item) => item === value);

export default async function AdminTenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAdminContext();
  const { id } = await params;
  const query = await searchParams;
  const runtime = getServerRuntime();
  const [result, t, locale] = await Promise.all([
    tenantDetail.call(runtime, ctx, { operatorId: id }),
    getTranslations("admin"),
    getLocale(),
  ]);
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION") notFound();
    throw new Error(`admin tenant: ${result.error.code}`);
  }
  const d: AdminTenantDetail = result.value;
  const dl = displayLocale(locale);
  const done = oneOf(DONE, param(query.done));
  const error = oneOf(ERRORS, param(query.error));
  const live = d.supportGrants.find((g) => g.active && g.adminUserId === ctx.userId);
  const today = businessDateOf(runtime.now());
  const status = d.tenant.subscriptionStatus;

  return (
    <>
      <AdminPageHeader
        title={d.tenant.name}
        description={t("tenant.description")}
        back={
          <Button asChild variant="quiet" icon="back">
            <Link href="/admin/tenants">{t("tenants.title")}</Link>
          </Button>
        }
      />
      {done ? <Outcome tone="success">{t(`tenant.done.${done}`)}</Outcome> : null}
      {error ? <Outcome tone="danger">{t(`tenant.error.${error}`)}</Outcome> : null}

      <Section title={t("tenant.subscription.title")} data-tenant="subscription">
        <div>
          <SubscriptionPill status={status} label={t(`sub_status.${status ?? "none"}`)} />
        </div>
        <Facts
          rows={[
            {
              label: t("tenant.subscription.trial_last_day"),
              value: lastDayText(d.tenant.trialEndsAt, dl),
            },
            {
              label: t("tenant.subscription.paid_last_day"),
              value: lastDayText(d.tenant.currentPeriodEnd, dl),
            },
            {
              label: t("tenant.subscription.grace_last_day"),
              value: lastDayText(d.tenant.graceEndsAt, dl),
            },
            {
              label: t("tenant.subscription.autopay"),
              value: d.subscription?.razorpayStatus ?? t("common.none"),
            },
            {
              label: t("tenant.operator_status"),
              value: t(`operator_status.${d.tenant.operatorStatus}`),
            },
            { label: t("tenant.since"), value: dayText(d.tenant.createdAt, dl) },
            {
              label: t("tenant.last_activity"),
              value: timeText(d.tenant.lastActivityAt, dl, t("common.never")),
            },
            { label: t("tenant.business_phone"), value: d.businessPhone ?? t("common.none") },
          ]}
        />
      </Section>

      <Section title={t("tenant.counts.title")} data-tenant="counts">
        <StatGrid>
          <Stat value={d.counts.customers.active} label={t("tenant.counts.active_customers")} />
          <Stat value={d.counts.customers.inactive} label={t("tenant.counts.inactive_customers")} />
          <Stat value={d.counts.users.staff} label={t("tenant.counts.staff")} />
          <Stat value={d.counts.users.lineman} label={t("tenant.counts.linemen")} />
        </StatGrid>
      </Section>

      <Section title={t("tenant.owners.title")} data-tenant="owners">
        <ul className="flex flex-col gap-2">
          {d.owners.map((o) => (
            <li key={o.userId} className="flex flex-wrap gap-x-4">
              <span className="font-strong">{o.name}</span>
              <span>{o.email ?? t("common.none")}</span>
              <span className="font-numeric">{o.phone ?? t("common.none")}</span>
              {o.status === "disabled" ? (
                <StatusPill variant="danger" label={t("tenant.owners.disabled")} />
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("tenant.support.title")} data-tenant="support">
        <p className="text-base">{t("tenant.support.explain")}</p>
        {live ? (
          <div className="flex flex-col gap-3" data-support="live">
            <p className="font-strong">
              {t("tenant.support.open_until", { time: timeText(live.expiresAt, dl) })}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild icon="search">
                <Link href={`/admin/tenants/${d.tenant.operatorId}/support`}>
                  {t("tenant.support.view")}
                </Link>
              </Button>
              <form action={endSupportAccessAction}>
                <input type="hidden" name="operatorId" value={d.tenant.operatorId} />
                <input type="hidden" name="grantId" value={live.grantId} />
                <Button type="submit" variant="secondary" icon="close">
                  {t("tenant.support.end")}
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <form action={grantSupportAccessAction} className="flex max-w-xl flex-col gap-3">
            <input type="hidden" name="operatorId" value={d.tenant.operatorId} />
            <Field
              id="support-reason"
              label={t("tenant.support.reason")}
              hint={t("tenant.support.reason_hint")}
            >
              <Textarea id="support-reason" name="reason" required minLength={10} maxLength={500} />
            </Field>
            <div>
              <Button type="submit" icon="search">
                {t("tenant.support.open")}
              </Button>
            </div>
          </form>
        )}
        {d.supportGrants.length > 0 ? (
          <ul className="flex flex-col gap-2" data-support="history">
            {d.supportGrants.map((g) => (
              <li key={g.grantId} className="flex flex-col border-border border-t pt-2">
                <span>
                  {t("tenant.support.history_line", {
                    name: g.adminName ?? t("common.none"),
                    from: timeText(g.grantedAt, dl),
                    until: timeText(g.endedAt ?? g.expiresAt, dl),
                  })}
                </span>
                <span className="text-text-muted">{g.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title={t("tenant.extend.title")} data-tenant="extend">
        <form action={extendSubscriptionAction} className="flex max-w-xl flex-col gap-3">
          <input type="hidden" name="operatorId" value={d.tenant.operatorId} />
          <Field id="extend-last-day" label={t("tenant.extend.last_day")}>
            <Input id="extend-last-day" name="lastDay" type="date" min={today} required />
          </Field>
          <Field id="extend-reason" label={t("tenant.extend.reason")}>
            <Input id="extend-reason" name="reason" required minLength={5} maxLength={300} />
          </Field>
          <div>
            <Button type="submit" variant="secondary" icon="subscription">
              {t("tenant.extend.submit")}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t("tenant.payment.title")} data-tenant="offline-payment">
        <form action={recordOfflinePaymentAction} className="flex max-w-xl flex-col gap-3">
          <input type="hidden" name="operatorId" value={d.tenant.operatorId} />
          <input type="hidden" name="paymentId" value={uuidv7()} />
          <Field id="payment-amount" label={t("tenant.payment.amount")}>
            <Input id="payment-amount" name="amountRupees" inputMode="numeric" required />
          </Field>
          <Field id="payment-months" label={t("tenant.payment.months")}>
            <Select id="payment-months" name="months" defaultValue="1">
              {Array.from({ length: OFFLINE_PAYMENT_MAX_MONTHS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {t("tenant.payment.months_option", { count: n })}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="payment-method" label={t("tenant.payment.method")}>
            <Select id="payment-method" name="method" defaultValue="bank_transfer">
              {OFFLINE_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`payment_method.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="payment-received" label={t("tenant.payment.received_on")}>
            <Input
              id="payment-received"
              name="receivedOn"
              type="date"
              max={today}
              defaultValue={today}
              required
            />
          </Field>
          <Field id="payment-reference" label={t("tenant.payment.reference")}>
            <Input id="payment-reference" name="reference" maxLength={100} />
          </Field>
          <Field id="payment-note" label={t("tenant.payment.note")}>
            <Input id="payment-note" name="note" maxLength={500} />
          </Field>
          <p className="text-base text-text-muted">{t("tenant.payment.explain")}</p>
          <div>
            <Button type="submit" variant="secondary" icon="cash">
              {t("tenant.payment.submit")}
            </Button>
          </div>
        </form>
        {d.offlinePayments.length > 0 ? (
          <ul className="flex flex-col gap-2" data-tenant="offline-payments">
            {d.offlinePayments.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-x-4 border-border border-t pt-2">
                <span className="font-numeric font-strong">{rupeesText(p.amountPaise)}</span>
                <span>{t(`payment_method.${p.method}`)}</span>
                <span>{t("tenant.payment.months_option", { count: p.months })}</span>
                <span>{t("tenant.payment.paid_till", { date: lastDayText(p.paidUntil, dl) })}</span>
                <span className="text-text-muted">{p.reference ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title={t("tenant.runs.title")} data-tenant="runs">
        {d.billingRuns.length === 0 ? (
          <p>{t("tenant.runs.none")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {d.billingRuns.map((r) => (
              <li key={r.runId} className="flex flex-wrap gap-x-4">
                <span className="font-strong">{monthText(r.period, dl)}</span>
                <span>{t(`run_status.${r.status}`)}</span>
                <span>
                  {t("tenant.runs.counts", {
                    billed: r.createdCount + r.alreadyExistsCount,
                    failed: r.failedCount,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p>
          {d.latestInvariantCheck
            ? t(`tenant.books.${d.latestInvariantCheck.status}`, {
                time: timeText(d.latestInvariantCheck.checkedAt, dl),
                count: d.latestInvariantCheck.violationCount,
              })
            : t("tenant.books.never")}
        </p>
        {d.failedJobs > 0 ? (
          <p>
            <Link className="underline" href="/admin/jobs?status=failed">
              {t("tenant.failed_jobs", { count: d.failedJobs })}
            </Link>
          </p>
        ) : null}
      </Section>

      <Section title={t("tenant.timeline.title")} data-tenant="timeline">
        {d.timeline.length === 0 ? (
          <p>{t("tenant.timeline.none")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {d.timeline.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-4">
                <span className="text-text-muted">{timeText(e.at, dl)}</span>
                <span className="font-strong">{e.actorName ?? t("common.system")}</span>
                <code>{e.action}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
