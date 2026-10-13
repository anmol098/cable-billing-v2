/**
 * The Summary tab (PLAN §12.1 "Summary (due, credit, connections, Take payment)"): the amount due
 * first and biggest (PLAN §2.2 rule 2), then the connections, the last payment and the details.
 * "Take payment" is the page's primary action (in the header, CustomerProfileShell).
 */
import type { CustomerProfile } from "@cb/core";
import {
  businessDate,
  type DisplayLocale,
  formatBusinessDate,
  period,
  periodLabel,
} from "@cb/domain";
import { Amount, Button, Card, formatRupees, Icon } from "@cb/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ActivePill, MutedPill } from "../../_components/status-pills";
import { setCustomerStatusAction } from "./actions";
import { CustomerStatusControl } from "./status-control";

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-strong text-xl">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b-hairline border-border py-3 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="text-sm text-text-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-lg break-words">{children}</dd>
    </div>
  );
}

const rupees = (paise: number) => formatRupees(paise).text;

export async function CustomerSummary({
  profile,
  locale,
  canManage,
}: {
  profile: CustomerProfile;
  locale: DisplayLocale;
  canManage: boolean;
}) {
  const [t, common] = await Promise.all([getTranslations("customers"), getTranslations("common")]);
  const notWritten = <span className="text-text-muted">{t("profile.not_written")}</span>;
  const due = profile.balancePaise;
  const active = profile.status === "active";

  return (
    <div className="flex flex-col gap-6" data-summary={profile.id}>
      {!active ? (
        <p className="flex items-center gap-2 text-base text-text-muted">
          <Icon name="close" className="shrink-0" />
          {t("profile.closed_note")}
        </p>
      ) : null}

      <Card className="flex flex-col gap-2 p-4 sm:p-6" data-summary-part="due">
        <p className="text-base text-text-muted">
          {due > 0
            ? t("profile.due_now")
            : due < 0
              ? t("profile.credit_now")
              : t("profile.nothing_due")}
        </p>
        <Amount
          paise={due}
          tone="balance"
          size="amount"
          dueLabel={t("list.col_due")}
          creditLabel={t("profile.credit_now")}
        />
        {due > 0 && profile.oldestDuePeriod ? (
          <p className="text-base text-due">
            {t("profile.unpaid_since", {
              month: periodLabel(period(profile.oldestDuePeriod), locale),
            })}
          </p>
        ) : null}
      </Card>

      <Section title={t("profile.connections")}>
        {profile.connections.length === 0 ? (
          <p className="text-base text-text-muted">{t("profile.no_connections")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {profile.connections.map((connection) => (
              <li
                key={connection.assignmentId}
                className="flex flex-col gap-2 rounded-md border-hairline border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-numeric font-strong text-lg">{connection.vcNumber}</span>
                  <span className="text-sm text-text-muted">
                    {connection.planName
                      ? t("profile.plan", { name: connection.planName })
                      : t("profile.own_amount")}
                    {" · "}
                    {t("profile.since", {
                      date: formatBusinessDate(businessDate(connection.startDate), locale),
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-numeric">
                    {t("profile.rent", { amount: rupees(connection.rentalPaise).slice(1) })}
                  </span>
                  {connection.status === "active" ? (
                    <ActivePill active label={t("connection_status.active")} />
                  ) : (
                    <MutedPill label={t(`connection_status.${connection.status}`)} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {profile.pastConnections > 0 ? (
          <p className="text-sm text-text-muted">
            {t("profile.past_connections", { count: profile.pastConnections })}
          </p>
        ) : null}
      </Section>

      <Section title={t("profile.last_payment")}>
        {profile.lastPayment ? (
          <p className="flex flex-wrap items-center gap-3 text-lg">
            <span className="font-numeric">
              {t("profile.last_payment_value", {
                amount: rupees(profile.lastPayment.amountPaise),
                date: formatBusinessDate(businessDate(profile.lastPayment.businessDate), locale),
              })}
            </span>
            <span className={profile.lastPayment.method === "cash" ? "text-cash" : "text-upi"}>
              <Icon name={profile.lastPayment.method} className="inline shrink-0" />{" "}
              {common(profile.lastPayment.method)}
            </span>
            {profile.lastPayment.reversed ? (
              <MutedPill label={t("profile.payment_cancelled")} />
            ) : null}
          </p>
        ) : (
          <p className="text-base text-text-muted">{t("profile.no_payments")}</p>
        )}
      </Section>

      <Section
        title={t("profile.details")}
        action={
          canManage ? (
            <Button asChild variant="secondary" icon="edit">
              <Link href={`/customers/${profile.id}?edit=1`} data-action="edit-customer">
                {t("profile.change_details")}
              </Link>
            </Button>
          ) : undefined
        }
      >
        <dl>
          <DetailRow label={t("field.code")}>
            <span className="font-numeric">{profile.customerCode}</span>
          </DetailRow>
          <DetailRow label={t("field.phone")}>
            {profile.phone ? (
              <span className="flex flex-wrap items-center gap-3">
                <span className="font-numeric">{profile.phone}</span>
                <Button asChild variant="quiet" icon="call">
                  <a href={`tel:${profile.phone}`}>{t("profile.call")}</a>
                </Button>
              </span>
            ) : (
              notWritten
            )}
          </DetailRow>
          <DetailRow label={t("profile.alt_phone")}>
            {profile.altPhone ? (
              <span className="font-numeric">{profile.altPhone}</span>
            ) : (
              notWritten
            )}
          </DetailRow>
          <DetailRow label={t("field.area")}>{profile.areaName ?? t("field.area_none")}</DetailRow>
          <DetailRow label={t("profile.address")}>{profile.address ?? notWritten}</DetailRow>
        </dl>
        {canManage ? (
          <div>
            <CustomerStatusControl
              name={profile.name}
              active={active}
              action={setCustomerStatusAction.bind(null, profile.id)}
            />
          </div>
        ) : null}
      </Section>
    </div>
  );
}
