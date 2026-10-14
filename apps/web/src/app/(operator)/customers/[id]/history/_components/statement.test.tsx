import { businessDate } from "@cb/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeLine, signedRupees } from "./lines";
import { statementPrintHtml } from "./print-html";
import {
  historyHref,
  pickStatementRange,
  presetRange,
  rangeText,
  statementPrintHref,
} from "./range";
import { StatementLines, StatementRangePicker, StatementSummary } from "./statement-view";
import { CUSTOMER_ID, statementView, translators } from "./test-fixtures";

const today = businessDate("2026-11-15");

describe("pickStatementRange", () => {
  it("defaults to the last 3 months, ending today", () => {
    expect(pickStatementRange({}, today)).toEqual({
      preset: "3m",
      from: "2026-09-01",
      to: undefined,
      invalid: false,
    });
  });

  it("reads the presets", () => {
    expect(pickStatementRange({ range: "month" }, today)).toMatchObject({ from: "2026-11-01" });
    expect(pickStatementRange({ range: "12m" }, today)).toMatchObject({ from: "2025-12-01" });
    expect(pickStatementRange({ range: "all" }, today)).toMatchObject({
      preset: "all",
      from: undefined,
    });
    expect(pickStatementRange({ range: "nonsense" }, today).preset).toBe("3m");
    expect(presetRange("3m", businessDate("2026-01-31")).from).toBe("2025-11-01");
  });

  it("reads typed dates, and falls back on wrong ones", () => {
    expect(pickStatementRange({ from: "2026-10-01", to: "2026-10-31" }, today)).toEqual({
      preset: "custom",
      from: "2026-10-01",
      to: "2026-10-31",
      invalid: false,
    });
    expect(pickStatementRange({ from: "2026-10-05" }, today)).toMatchObject({
      preset: "custom",
      to: undefined,
    });
    // A future end is fine (the service stops at today); a start after the end is not.
    expect(pickStatementRange({ from: "2026-11-01", to: "2027-01-01" }, today).invalid).toBe(false);
    for (const bad of [
      { from: "2026-10-32" },
      { to: "yesterday" },
      { from: "2026-10-05", to: "2026-10-01" },
      { from: "2026-12-01" },
    ]) {
      expect(pickStatementRange(bad, today)).toMatchObject({ preset: "3m", invalid: true });
    }
    // Empty boxes from the form mean "no date".
    expect(pickStatementRange({ from: "", to: "" }, today)).toMatchObject({
      preset: "3m",
      invalid: false,
    });
  });

  it("builds the tab and print URLs", () => {
    expect(historyHref("c1", { preset: "12m", from: undefined, to: undefined })).toBe(
      "/customers/c1/history?range=12m",
    );
    expect(
      statementPrintHref("c1", {
        preset: "custom",
        from: businessDate("2026-10-01"),
        to: businessDate("2026-10-31"),
      }),
    ).toBe("/customers/c1/history/print?from=2026-10-01&to=2026-10-31");
  });
});

describe("statement words", () => {
  const { t, tb } = translators();
  const view = statementView();

  it("signs amounts", () => {
    expect(signedRupees(52_500)).toBe("+₹525");
    expect(signedRupees(-100_000)).toBe("−₹1,000");
    expect(signedRupees(0)).toBe("₹0");
  });

  it("words every kind of line plainly", () => {
    const [field, bill, upi, undo] = view.lines.map((line) => describeLine(line, t, tb, "en"));
    expect(field).toMatchObject({ title: "Paid in cash", tone: "cash", icon: "cash" });
    expect(field?.details).toEqual([
      "Receipt R-2610-00003",
      "Money taken on 31 Oct 2026",
      "By Ramu",
    ]);
    expect(bill).toMatchObject({
      title: "Bill for November 2026",
      details: ["Bill INV-2611-00001"],
    });
    expect(upi).toMatchObject({ title: "Paid by UPI", tone: "upi" });
    expect(upi?.details).not.toContain("Money taken on 5 Nov 2026");
    expect(undo).toMatchObject({ title: "Payment cancelled", tone: "danger", icon: "undo" });
    expect(undo?.details).toEqual(["Cash ₹300", "Receipt R-2610-00001", "Why: Counted <twice>"]);

    const extra = describeLine(
      {
        ...(view.lines[1] as (typeof view.lines)[number]),
        type: "debit_adjustment",
        bill: null,
        adjustment: {
          id: "a",
          direction: "debit",
          source: "plan_change",
          period: "2026-11-01" as never,
          reason: null,
        },
      },
      t,
      tb,
      "en",
    );
    expect(extra).toMatchObject({
      title: "Extra charge",
      details: ["Plan changed", "For November 2026"],
    });
    const discount = describeLine(
      {
        ...(view.lines[1] as (typeof view.lines)[number]),
        type: "credit_adjustment",
        bill: null,
        adjustment: {
          id: "b",
          direction: "credit",
          source: "manual",
          period: null,
          reason: "Box off",
        },
      },
      t,
      tb,
      "en",
    );
    expect(discount).toMatchObject({ title: "Discount", details: ["Bill change", "Box off"] });
    const oldDues = describeLine(
      {
        ...(view.lines[1] as (typeof view.lines)[number]),
        type: "opening_balance",
        bill: {
          ...(view.lines[1]?.bill as NonNullable<(typeof view.lines)[number]["bill"]>),
          kind: "opening_balance",
        },
      },
      t,
      tb,
      "en",
    );
    expect(oldDues.title).toBe("Old dues from your old records");
  });

  it("says the days", () => {
    expect(rangeText(view.range, t, "en")).toBe("1 Nov 2026 to 30 Nov 2026");
    expect(rangeText({ from: null, to: businessDate("2026-12-02") }, t, "en")).toBe(
      "Everything up to 2 Dec 2026",
    );
  });
});

describe("StatementSummary and StatementLines", () => {
  it("shows the balance at the end first, how it came about, and every line", () => {
    const { t, tb } = translators();
    const view = statementView();
    render(
      <>
        <StatementSummary view={view} t={t} locale="en" />
        <StatementLines view={view} t={t} tb={tb} locale="en" />
      </>,
    );
    expect(screen.getByTestId("statement-headline")).toHaveTextContent("Credit on 30 Nov 2026");
    expect(screen.getByTestId("statement-closing")).toHaveTextContent("₹175");
    expect(screen.getByTestId("statement-closing")).toHaveTextContent("Credit");
    expect(screen.getByTestId("sum-opening")).toHaveTextContent("Balance before 1 Nov 2026");
    expect(screen.getByTestId("sum-opening")).toHaveTextContent("₹50");
    expect(screen.getByTestId("sum-billed")).toHaveTextContent("+₹525");
    expect(screen.getByTestId("sum-paid")).toHaveTextContent("−₹1,050");
    expect(screen.getByTestId("sum-undone")).toHaveTextContent("+₹300");
    expect(screen.queryByTestId("sum-discount")).toBeNull();
    expect(screen.getByTestId("sum-closing")).toHaveTextContent("Balance on 30 Nov 2026");
    expect(screen.queryByRole("alert")).toBeNull();

    const lines = screen.getAllByTestId("statement-line");
    expect(lines.map((li) => li.getAttribute("data-type"))).toEqual([
      "payment",
      "invoice",
      "payment",
      "payment_reversal",
    ]);
    const first = lines[0] as HTMLElement;
    expect(first).toHaveTextContent("Paid in cash");
    expect(first).toHaveTextContent(
      "1 Nov 2026 · Receipt R-2610-00003 · Money taken on 31 Oct 2026",
    );
    expect(within(first).getByTestId("line-amount")).toHaveTextContent("−₹50");
    expect(within(first).getByTestId("line-balance")).toHaveTextContent("Balance ₹0");
    const bill = lines[1] as HTMLElement;
    expect(within(bill).getByRole("link", { name: "Open bill" })).toHaveAttribute(
      "href",
      "/bills/0193a000-0000-7000-8000-0000000000b2",
    );
    expect(within(bill).getByTestId("line-balance")).toHaveTextContent("Balance ₹525Due");
    const undo = lines[3] as HTMLElement;
    expect(undo).toHaveTextContent("Payment cancelled");
    expect(undo).toHaveTextContent("Why: Counted <twice>");
    expect(within(undo).getByTestId("line-balance")).toHaveTextContent("Balance ₹175Credit");
  });

  it("as of now: says 'now', shows unused credit, and warns when the books disagree", () => {
    const { t } = translators();
    const base = statementView();
    render(
      <StatementSummary
        t={t}
        locale="en"
        view={{
          ...base,
          range: { ...base.range, from: null, to: base.range.today, asOfNow: true },
          closingBalancePaise: 32_500 as never,
          now: { ...base.now, creditPaise: 4_000 as never, ledgerPaise: 32_400 as never },
        }}
      />,
    );
    expect(screen.getByTestId("statement-headline")).toHaveTextContent("Due now");
    expect(screen.getByTestId("statement-credit-unused")).toHaveTextContent(
      "₹40 credit goes on the next bill",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The account total does not match.");
    // No "Balance before" without a start date.
    expect(screen.queryByTestId("sum-opening")).toBeNull();
  });

  it("shows hidden older lines and an empty range", () => {
    const { t, tb } = translators();
    const { unmount } = render(
      <StatementLines view={statementView({ hiddenLines: 3 })} t={t} tb={tb} locale="en" />,
    );
    expect(screen.getByTestId("statement-hidden")).toHaveTextContent(
      "3 older lines are added into the first balance.",
    );
    unmount();
    render(<StatementLines view={statementView({ lines: [] })} t={t} tb={tb} locale="en" />);
    expect(screen.getByText("Nothing happened in these days.")).toBeInTheDocument();
  });

  it("speaks Hindi", () => {
    const { t, tb } = translators("hi");
    const view = statementView();
    render(
      <>
        <StatementSummary view={view} t={t} locale="hi" />
        <StatementLines view={view} t={t} tb={tb} locale="hi" />
      </>,
    );
    expect(screen.getByTestId("statement-headline")).toHaveTextContent("30 नव 2026 को एडवांस");
    expect(screen.getAllByTestId("statement-line")[0]).toHaveTextContent("नकद दिए");
    expect(screen.getAllByTestId("statement-line")[3]).toHaveTextContent("पेमेंट रद्द");
  });

  it("the range picker marks the current choice and keeps the dates in the form", () => {
    const { t } = translators();
    const view = statementView();
    render(
      <StatementRangePicker
        customerId={CUSTOMER_ID}
        range={view.range}
        t={t}
        choice={{
          preset: "custom",
          from: view.range.from ?? undefined,
          to: view.range.to,
          invalid: true,
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Last 3 months" })).toHaveAttribute(
      "href",
      `/customers/${CUSTOMER_ID}/history?range=3m`,
    );
    expect(screen.getByRole("link", { name: "Last 3 months" })).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText("From")).toHaveValue("2026-11-01");
    expect(screen.getByLabelText("To")).toHaveValue("2026-11-30");
    expect(screen.getByRole("alert")).toHaveTextContent("Check the dates.");
  });
});

describe("statementPrintHtml", () => {
  it("prints an A4 statement in the operator's language with every line and the balances", () => {
    const { t, tb } = translators("hi");
    const html = statementPrintHtml(statementView(), t, tb, "hi", {
      autoPrint: true,
      backHref: `/customers/${CUSTOMER_ID}/history?range=3m`,
    });
    expect(html).toContain("size:A4 portrait");
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain("खाते का हिसाब");
    expect(html).toContain("Asha Devi");
    expect(html).toContain("1 नव 2026 से 30 नव 2026 तक");
    expect(html).toContain("नवंबर 2026 का बिल");
    expect(html).toContain("+₹525");
    expect(html).toContain("₹175 एडवांस");
    // The Owner's words are escaped.
    expect(html).toContain("Counted &lt;twice&gt;");
    expect(html).not.toContain("Counted <twice>");
    expect(html).toContain("window.print()");
    expect(html).toContain('window.addEventListener("load"');
    expect(html).toContain("यह रसीद नहीं है।");
    expect(html).toMatch(/2 दिस 2026 को प्रिंट हुआ/);
  });

  it("marks a payment that was cancelled later", () => {
    const { t, tb } = translators("hi");
    const view = statementView();
    const lines = view.lines.map((line) =>
      line.type === "payment" && line.payment
        ? { ...line, payment: { ...line.payment, reversed: true } }
        : line,
    );
    const html = statementPrintHtml({ ...view, lines }, t, tb, "hi", {
      autoPrint: false,
      backHref: "/back",
    });
    expect(html).toContain("बाद में रद्द");
  });

  it("prints an empty range without auto print", () => {
    const { t, tb } = translators("en");
    const html = statementPrintHtml(statementView({ lines: [] }), t, tb, "en", {
      autoPrint: false,
      backHref: "/back",
    });
    expect(html).toContain("Nothing happened in these days.");
    expect(html).toContain("Balance before 1 Nov 2026");
    expect(html).not.toContain('addEventListener("load"');
  });
});
