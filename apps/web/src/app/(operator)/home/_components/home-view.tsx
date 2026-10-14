/**
 * The Home page body (T-083, PLAN §12.1 "Home", §12.3, §2.2): numbers first. For a new business
 * the setup checklist comes first (it hides itself once every step is done); then today's cash and
 * UPI (apart), what needs checking, and this month (bills made, money taken, total due, the latest
 * bill run). Every tile and alert opens the page with the same number (`homeLinks`); a role that
 * may not open that page sees the number without a link.
 *
 * Props-driven and free of server code, so component tests render it with the real messages.
 */
import type { HomeDashboard } from "@cb/core";
import { type DisplayLocale, formatBusinessDate, type Period, periodLabel } from "@cb/domain";
import { Amount, Card, cn, Icon, type IconName } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { LINEMAN_APP_URL } from "@/app/(operator)/settings/team/share";
import type { Translate as BillsTranslate } from "@/components/bills/format";
import { RunStatePill } from "@/components/bills/parts";
import { SetupChecklist, type SetupStep, setupStepsFor } from "@/components/shell/setup-checklist";
import type { CanFn } from "@/lib/nav";
import { type HomeLinkId, homeLinks } from "../_lib/links";
import { AppQr } from "./app-qr";

export interface HomeViewProps {
  view: HomeDashboard;
  can: CanFn;
  locale: DisplayLocale;
}

const monthOf = (period: Period, locale: DisplayLocale) => periodLabel(period, locale, "long");

/** A number tile: the whole card is the link (or a plain card when the role can't open it). */
function Tile({
  href,
  testId,
  className,
  children,
}: {
  href: string | null;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn("flex min-w-0 flex-col gap-2", className);
  if (!href) {
    return (
      <Card className={classes} data-testid={testId}>
        {children}
      </Card>
    );
  }
  return (
    <Card asChild className={cn(classes, "hover:bg-surface")}>
      <Link href={href} data-testid={testId}>
        {children}
      </Link>
    </Card>
  );
}

/** Icon + colour + word over a number (PLAN §2.2 rule 3). */
function TileLabel({
  icon,
  tone,
  children,
}: {
  icon: IconName;
  tone: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("flex items-center gap-2 text-base", tone)}>
      <Icon name={icon} className="shrink-0" />
      {children}
    </span>
  );
}

interface Alert {
  id: HomeLinkId;
  icon: IconName;
  tone: string;
  text: string;
  detail?: string;
  /** The word at the end of the row (default: an arrow only). */
  action?: string;
}

function AlertRow({ alert, href }: { alert: Alert; href: string | null }) {
  const body = (
    <>
      <Icon name={alert.icon} className={cn("size-6 shrink-0", alert.tone)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-strong text-base text-text">{alert.text}</span>
        {alert.detail ? <span className="text-sm text-text-muted">{alert.detail}</span> : null}
      </span>
      {href ? (
        <span className="flex shrink-0 items-center gap-1 text-base text-text">
          {alert.action ?? null}
          <Icon name="next" className="shrink-0" />
        </span>
      ) : null}
    </>
  );
  const classes = "flex min-h-touch-min items-center gap-3";
  return (
    <li data-alert={alert.id}>
      {href ? (
        <Card asChild className={cn(classes, "hover:bg-surface")}>
          <Link href={href}>{body}</Link>
        </Card>
      ) : (
        <Card className={classes}>{body}</Card>
      )}
    </li>
  );
}

/** The checklist's steps for this role, the app step with the Play Store link and its QR code. */
export function homeSetupSteps(
  can: CanFn,
  done: HomeDashboard["setup"],
  appDetail: ReactNode,
): SetupStep[] {
  return setupStepsFor(can, done).map((step) =>
    step.id === "app"
      ? { ...step, href: LINEMAN_APP_URL, external: true, detail: appDetail }
      : step,
  );
}

export function HomeView({ view, can, locale }: HomeViewProps) {
  const t = useTranslations("home");
  const common = useTranslations("common");
  const bills = useTranslations("bills") as unknown as BillsTranslate;
  const links = homeLinks(view, can);
  const steps = homeSetupSteps(
    can,
    view.setup,
    <AppQr url={LINEMAN_APP_URL} label={t("app.qr")} hint={t("app.scan")} />,
  );

  const alerts: Alert[] = [];
  if (view.handoversWaiting.count > 0) {
    alerts.push({
      id: "handovers",
      icon: "handover",
      tone: "text-pending",
      text: t("alerts.handovers", { count: view.handoversWaiting.count }),
    });
  }
  if (view.paymentsToCheck > 0) {
    alerts.push({
      id: "payments_to_check",
      icon: "danger",
      tone: "text-pending",
      text: t("alerts.payments", { count: view.paymentsToCheck }),
    });
  }
  if (view.missedRuns.count > 0) {
    alerts.push({
      id: "missed",
      icon: "danger",
      tone: "text-danger",
      text: t("alerts.missed", { count: view.missedRuns.count }),
    });
  }
  // The trial is the Owner's business (PLAN §11.9); grace and view-only are the shell's banner.
  const trial = view.subscription;
  if (trial.status === "trialing" && trial.trialDaysLeft !== null && links.subscription) {
    alerts.push({
      id: "subscription",
      icon: "subscription",
      tone: "text-pending",
      text: t("alerts.trial", { days: trial.trialDaysLeft }),
      ...(trial.trialEndsOn
        ? {
            detail: t("alerts.trial_until", {
              date: formatBusinessDate(trial.trialEndsOn, locale),
            }),
          }
        : {}),
      action: t("alerts.pay"),
    });
  }

  const run = view.latestRun;
  const monthTotal = view.collectedThisMonth.cashPaise + view.collectedThisMonth.upiPaise;

  return (
    <div className="flex flex-col gap-6">
      <SetupChecklist steps={steps} />

      <section aria-labelledby="home-today" className="flex flex-col gap-3">
        <h2 id="home-today" className="font-strong text-xl">
          {t("today.title", { date: formatBusinessDate(view.today, locale) })}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Tile href={links.cash_today} testId="home-cash-today">
            <TileLabel icon="cash" tone="text-cash">
              {t("today.cash")}
            </TileLabel>
            <Amount paise={view.collectedToday.cashPaise} size="amount" />
          </Tile>
          <Tile href={links.upi_today} testId="home-upi-today">
            <TileLabel icon="upi" tone="text-upi">
              {t("today.upi")}
            </TileLabel>
            <Amount paise={view.collectedToday.upiPaise} size="amount" />
          </Tile>
        </div>
        <p className="text-base text-text-muted" data-testid="home-payments-today">
          {common("payment_count", { count: view.collectedToday.paymentCount })}
        </p>
      </section>

      <section aria-labelledby="home-alerts" className="flex flex-col gap-3">
        <h2 id="home-alerts" className="font-strong text-xl">
          {t("alerts.title")}
        </h2>
        {alerts.length === 0 ? (
          <p className="flex items-center gap-2 text-base text-text" data-alert="none">
            <Icon name="success" className="size-6 shrink-0 text-success" />
            {t("alerts.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} href={links[alert.id]} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-month" className="flex flex-col gap-3">
        <h2 id="home-month" className="font-strong text-xl">
          {t("month.title", { month: monthOf(view.period, locale) })}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Tile href={links.billed} testId="home-billed">
            <TileLabel icon="bill" tone="text-text">
              {t("month.billed")}
            </TileLabel>
            <Amount paise={view.billedThisMonth.totalPaise} size="2xl" />
            <span className="text-base text-text-muted">
              {t("month.bill_count", { count: view.billedThisMonth.billCount })}
            </span>
          </Tile>
          <Tile href={links.collected} testId="home-collected">
            <TileLabel icon="collect" tone="text-text">
              {t("month.collected")}
            </TileLabel>
            <Amount paise={monthTotal} size="2xl" />
            <span className="flex flex-wrap gap-x-4 gap-y-1 text-base">
              <span className="flex items-center gap-1" data-testid="home-collected-cash">
                <Icon name="cash" className="shrink-0 text-cash" />
                <span className="text-cash">{common("cash")}</span>
                <Amount paise={view.collectedThisMonth.cashPaise} size="base" weight="regular" />
              </span>
              <span className="flex items-center gap-1" data-testid="home-collected-upi">
                <Icon name="upi" className="shrink-0 text-upi" />
                <span className="text-upi">{common("upi")}</span>
                <Amount paise={view.collectedThisMonth.upiPaise} size="base" weight="regular" />
              </span>
            </span>
          </Tile>
          <Tile href={links.due} testId="home-due">
            <TileLabel icon="report" tone="text-text">
              {t("due.title")}
            </TileLabel>
            <Amount paise={view.due.duePaise} tone="balance" size="2xl" />
            <span className="text-base text-text-muted">
              {t("due.customers", { count: view.due.customerCount })}
            </span>
          </Tile>
          <Tile href={links.run} testId="home-run">
            {run ? (
              <>
                <TileLabel icon="today" tone="text-text">
                  {t("run.title", { month: monthOf(run.period, locale) })}
                </TileLabel>
                <RunStatePill t={bills} state={run.status} className="self-start" />
              </>
            ) : (
              <>
                <TileLabel icon="today" tone="text-text">
                  {bills("run_status.none")}
                </TileLabel>
                <span className="text-base text-text-muted">{t("run.none")}</span>
              </>
            )}
          </Tile>
        </div>
      </section>
    </div>
  );
}
