import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TotalsRow } from "@/components/reports/parts";
import { nsT, p, run, runRow } from "../../collections/_lib/test-fixtures";
import { RunItemsTable, RunSummary, runTotalItems } from "./run-view";

const t = nsT("reports");
const bt = nsT("bills");

describe("RunItemsTable", () => {
  it("shows each customer's result and why in plain words, never a machine code", () => {
    render(
      <RunItemsTable
        rows={[
          runRow(),
          runRow({
            itemId: "0190a000-0000-7000-8000-0000000000a2",
            customerCode: "F-6",
            customerName: "Farid",
            outcome: "skipped",
            reason: "nothing_to_bill",
            attempts: 1,
          }),
          runRow({
            itemId: "0190a000-0000-7000-8000-0000000000a3",
            customerCode: "A-1",
            customerName: "Asha Devi",
            outcome: "created",
            reason: null,
            invoiceId: "0190a000-0000-7000-8000-0000000000b9",
            invoiceNumber: "INV-2611-00001",
            chargesPaise: p(30_000),
            attempts: 1,
          }),
          runRow({
            itemId: "0190a000-0000-7000-8000-0000000000a4",
            customerCode: "E-5",
            customerName: "Esha",
            outcome: "failed",
            reason: "event_before_start",
            attempts: 1,
          }),
        ]}
        t={t}
        bt={bt}
      />,
    );
    const table = screen.getByRole("table", { name: "Customers in this bill run" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Customer", "Result", "Bill", "Why"]);
    const [, gopal, farid, asha, esha] = within(table).getAllByRole("row") as HTMLElement[];
    expect(gopal).toHaveTextContent(
      "GopalG-7 · NorthProblem—Account total does not match. Call support.Tried 2 times",
    );
    expect(farid).toHaveTextContent("Nothing to bill—No connection was on on the 1st.");
    expect(asha).toHaveTextContent("New bill₹300Bill INV-2611-00001Bill made in this run.");
    expect(esha).toHaveTextContent("Connection dates are wrong.");
    expect(table).not.toHaveTextContent("balance_mismatch");
    // A bill opens; a customer without a bill opens the customer.
    expect(within(asha as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/bills/0190a000-0000-7000-8000-0000000000b9",
    );
    expect(within(gopal as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/customers/0190a000-0000-7000-8000-0000000000d7",
    );
  });

  it("speaks Hindi and says when there is nothing", () => {
    const { unmount } = render(
      <RunItemsTable rows={[runRow()]} t={nsT("reports", "hi")} bt={nsT("bills", "hi")} />,
    );
    expect(screen.getByRole("table")).toHaveTextContent("दिक्कत");
    unmount();
    render(<RunItemsTable rows={[]} t={t} bt={bt} />);
    expect(screen.getByText("No customers in this list.")).toBeInTheDocument();
  });
});

describe("RunSummary", () => {
  it("says the run's state, who made it and when", () => {
    render(<RunSummary run={run()} t={t} bt={bt} locale="en" />);
    const summary = screen.getByTestId("run-summary");
    expect(summary).toHaveTextContent("Some problems");
    expect(summary).toHaveTextContent(
      "Bills for November 2026 are made, but some customers have a problem.",
    );
    expect(summary).toHaveTextContent(
      "Made by Owner Om · Started 1 Nov 2026, 8:30 am · Finished 1 Nov 2026, 8:35 am",
    );
  });

  it("a run made by itself, and one in progress", () => {
    const { unmount } = render(
      <RunSummary run={run({ trigger: "cron", status: "completed" })} t={t} bt={bt} locale="en" />,
    );
    expect(screen.getByTestId("run-summary")).toHaveTextContent("Made by itself on the 1st");
    unmount();
    render(
      <RunSummary run={run({ status: "running", finishedAt: null })} t={t} bt={bt} locale="en" />,
    );
    expect(screen.getByTestId("run-summary")).toHaveTextContent(
      "Making bills for November 2026. This page updates by itself.",
    );
  });
});

describe("runTotalItems", () => {
  it("customers checked, new bills with their total, nothing to bill, problems", () => {
    render(
      <TotalsRow
        label="Totals"
        testId="r"
        items={runTotalItems(
          {
            customers: 6,
            byOutcome: { created: 4, already_exists: 0, skipped: 1, failed: 1 },
            createdChargesPaise: p(130_000),
            alreadyExistsChargesPaise: p(0),
          },
          t,
        )}
      />,
    );
    expect(screen.getByTestId("r-customers")).toHaveTextContent("Customers checked6 customers");
    expect(screen.getByTestId("r-created")).toHaveTextContent("New bills4Total ₹1,300");
    expect(screen.getByTestId("r-skipped")).toHaveTextContent("Nothing to bill1");
    expect(screen.getByTestId("r-failed")).toHaveTextContent("Problems1");
  });
});
