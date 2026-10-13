import type { BillingMonth } from "@cb/core";
import { type Paise, period } from "@cb/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MissedRunsCard,
  MonthCalendar,
  MonthNav,
  PausedNotice,
  PreviewSummary,
  ProblemList,
  RunSummary,
} from "./parts";
import { billsT, NOV, previewView, runView } from "./test-fixtures";

const t = billsT();

describe("RunSummary", () => {
  it("says the month has no bills yet", () => {
    render(<RunSummary t={t} run={null} period={NOV} locale="en" />);
    expect(screen.getByText("Bills for November 2026 are not made yet.")).toBeInTheDocument();
    expect(screen.getByText("Not made")).toBeInTheDocument();
  });

  it("shows what a finished run made, problems in red", () => {
    render(
      <RunSummary
        t={t}
        run={runView({ status: "completed_with_errors", failedCount: 2 })}
        period={NOV}
        locale="en"
      />,
    );
    const summary = screen.getByTestId("run-summary");
    expect(summary).toHaveTextContent(
      "Bills for November 2026 are made, but some customers have a problem.",
    );
    expect(within(summary).getByText("Some problems")).toBeInTheDocument();
    expect(screen.getByTestId("run-created")).toHaveTextContent("3");
    expect(screen.getByTestId("run-total")).toHaveTextContent("₹850");
    expect(screen.getByTestId("run-failed")).toHaveClass("text-danger");
    expect(summary).toHaveTextContent(/Finished 1 Nov 2026/);
  });

  it("says bills are being made while the job runs, and a skipped month is missed", () => {
    const { rerender } = render(
      <RunSummary
        t={t}
        run={runView({ status: "running", finishedAt: null })}
        period={NOV}
        locale="en"
      />,
    );
    expect(
      screen.getByText("Making bills for November 2026. This page updates by itself."),
    ).toBeInTheDocument();
    rerender(
      <RunSummary
        t={t}
        run={runView({ status: "skipped", skipReason: "tenant_read_only" })}
        period={NOV}
        locale="en"
      />,
    );
    expect(screen.getByText("Missed")).toBeInTheDocument();
    expect(screen.queryByTestId("run-created")).not.toBeInTheDocument();
  });

  it("speaks Hindi", () => {
    render(<RunSummary t={billsT("hi")} run={runView()} period={NOV} locale="hi" />);
    expect(screen.getByText("नवंबर 2026 के बिल बन गए।")).toBeInTheDocument();
    expect(screen.getByText("बिल बन गए")).toBeInTheDocument();
  });
});

describe("PreviewSummary and ProblemList", () => {
  it("says how many customers get a bill, the total and the problems (PLAN §8.2)", () => {
    render(<PreviewSummary t={t} preview={previewView()} locale="en" hideHref="/bills/runs" />);
    expect(screen.getByTestId("preview-will-bill")).toHaveTextContent(
      "128 customers will get a bill.",
    );
    expect(screen.getByTestId("preview-total")).toHaveTextContent("₹57,600");
    expect(screen.getByTestId("preview-problem-count")).toHaveTextContent("3 problems");
    expect(screen.getByRole("link", { name: "Hide preview" })).toHaveAttribute(
      "href",
      "/bills/runs",
    );
  });

  it("names each problem in plain words, linking the customer", () => {
    render(
      <ProblemList
        t={t}
        id="run-problems"
        total={4}
        rows={[
          {
            key: "1",
            customerId: "c1",
            name: "Chandu",
            code: "C-3",
            areaName: "North",
            reason: "balance_mismatch",
            attempts: 2,
          },
          {
            key: "2",
            customerId: "c2",
            name: "Devi",
            code: "D-4",
            areaName: null,
            reason: "event_before_start",
          },
          {
            key: "3",
            customerId: "c3",
            name: "Esha",
            code: "E-5",
            areaName: null,
            reason: "internal_error",
          },
        ]}
      />,
    );
    const list = screen.getByTestId("run-problems");
    expect(
      within(list).getByRole("heading", { name: "Customers with a problem" }),
    ).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: /Chandu/ })).toHaveAttribute(
      "href",
      "/customers/c1",
    );
    expect(list).toHaveTextContent("Account total does not match. Call support.");
    expect(list).toHaveTextContent("Connection dates are wrong.");
    expect(list).toHaveTextContent("The bill could not be made. Try again.");
    expect(list).toHaveTextContent("Tried 2 times");
    expect(list).toHaveTextContent("Showing 3 of 4.");
  });

  it("renders nothing without problems", () => {
    const { container } = render(<ProblemList t={t} id="x" total={0} rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("MonthCalendar", () => {
  const month = (value: string, extra: Partial<BillingMonth> = {}): BillingMonth => ({
    period: period(value),
    run: null,
    billCount: 0,
    billTotalPaise: 0 as Paise,
    ...extra,
  });

  it("shows each month's status; open months link to their page", () => {
    render(
      <MonthCalendar
        t={t}
        locale="en"
        current={NOV}
        first={period("2026-09-01")}
        months={[
          month("2026-08-01"),
          month("2026-09-01", {
            run: runView({ period: period("2026-09-01"), status: "skipped" }),
          }),
          month("2026-10-01", {
            run: runView({ period: period("2026-10-01") }),
            billCount: 3,
            billTotalPaise: 85_000 as Paise,
          }),
          month("2026-11-01", { run: runView({ status: "running", finishedAt: null }) }),
          month("2026-12-01"),
        ]}
      />,
    );
    const cell = (value: string) =>
      screen.getByTestId("month-calendar").querySelector(`[data-period="${value}"]`) as HTMLElement;
    expect(cell("2026-08-01")).toHaveTextContent("Before you joined");
    expect(within(cell("2026-08-01")).queryByRole("link")).toBeNull();
    expect(within(cell("2026-09-01")).getByRole("link")).toHaveAccessibleName(
      "September 2026: Missed",
    );
    expect(cell("2026-10-01")).toHaveTextContent("Bills made");
    expect(cell("2026-10-01")).toHaveTextContent("3 bills");
    expect(cell("2026-10-01")).toHaveTextContent("₹850");
    const nov = within(cell("2026-11-01")).getByRole("link");
    expect(nov).toHaveAttribute("href", "/bills/runs?month=2026-11-01");
    expect(nov).toHaveAttribute("aria-current", "date");
    expect(nov).toHaveTextContent("Making bills");
    expect(cell("2026-12-01")).toHaveTextContent("Not yet");
  });
});

describe("month navigation, paused notice, missed runs", () => {
  it("links the previous month only inside the tenant's months", () => {
    render(
      <MonthNav
        t={t}
        period={NOV}
        current={NOV}
        first={period("2026-10-01")}
        locale="en"
        href={(p) => `/x?m=${p}`}
      />,
    );
    expect(screen.getByRole("link", { name: "Previous month" })).toHaveAttribute(
      "href",
      "/x?m=2026-10-01",
    );
    expect(screen.queryByRole("link", { name: "Next month" })).toBeNull();
  });

  it("tells Owner and Staff that bills are paused, in their words", () => {
    const { rerender } = render(<PausedNotice t={t} isOwner />);
    expect(screen.getByRole("status")).toHaveTextContent("Pay for the app to make bills again.");
    rerender(<PausedNotice t={t} isOwner={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Ask the owner to pay for the app.");
  });

  it("lists missed months with a link to check each (made by hand only, D-25)", () => {
    render(
      <MissedRunsCard
        t={t}
        locale="en"
        missed={[
          {
            runId: "r1",
            period: period("2026-09-01"),
            skipReason: "tenant_read_only",
            skippedAt: null,
          },
        ]}
      />,
    );
    const card = screen.getByTestId("missed-runs");
    expect(within(card).getByRole("heading", { name: "Missed bill runs" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Check September 2026" })).toHaveAttribute(
      "href",
      "/bills/runs?month=2026-09-01&preview=1",
    );
  });
});
