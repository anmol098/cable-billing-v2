import { businessDate } from "@cb/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TotalsRow } from "@/components/reports/parts";
import { dayRow, nsT, p } from "../_lib/test-fixtures";
import { CollectionsByDay, CollectionsByPerson, collectionTotalItems } from "./collections-view";

const t = nsT("reports");
const hi = nsT("reports", "hi");

describe("CollectionsByDay", () => {
  it("keeps cash and UPI in two columns, each with its icon and word", () => {
    render(
      <CollectionsByDay
        rows={[
          dayRow(),
          dayRow({
            collectorId: "0190a000-0000-7000-8000-00000000000c",
            name: "Suresh Pal",
            cashPaise: p(30_000),
            upiPaise: p(0),
            count: 1,
            cancelledCount: 1,
            cancelledPaise: p(30_000),
          }),
        ]}
        t={t}
        locale="en"
      />,
    );
    const table = screen.getByRole("table", { name: "Day by day" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Who and day", "Cash", "UPI", "Payments"]);
    const [, ravi, suresh] = within(table).getAllByRole("row");
    expect(ravi).toHaveTextContent("Ravi Kumar31 Oct 2026 · Lineman₹550₹3003");
    expect(suresh).toHaveTextContent("₹300₹01");
    expect(suresh).toHaveTextContent("1 cancelled (₹300), not counted");
    // A row opens the payments of that person and day.
    expect(within(ravi as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/reports/payments?from=2026-10-31&to=2026-10-31&collector=0190a000-0000-7000-8000-00000000000a",
    );
  });

  it("names payments from the old app and speaks Hindi", () => {
    render(
      <CollectionsByDay
        rows={[dayRow({ collectorId: null, name: null, role: null })]}
        t={hi}
        locale="hi"
      />,
    );
    const table = screen.getByRole("table", { name: "हर दिन का" });
    expect(table).toHaveTextContent("पुराने ऐप से");
    expect(table).toHaveTextContent("नकद");
    expect(table).toHaveTextContent("31 अक्टू 2026");
  });

  it("says when there is nothing", () => {
    render(<CollectionsByDay rows={[]} t={t} locale="en" />);
    expect(screen.getByText("No payments on these days.")).toBeInTheDocument();
  });
});

describe("CollectionsByPerson", () => {
  it("one row per person with days, opening their payments of the range", () => {
    render(
      <CollectionsByPerson
        rows={[{ ...dayRow(), days: 2 }]}
        from={businessDate("2026-10-03")}
        to={businessDate("2026-11-02")}
        t={t}
      />,
    );
    const table = screen.getByRole("table", { name: "Who took how much" });
    expect(table).toHaveTextContent("Ravi Kumar2 days · Lineman₹550₹3003");
    expect(within(table).getByRole("link")).toHaveAttribute(
      "href",
      "/reports/payments?from=2026-10-03&to=2026-11-02&collector=0190a000-0000-7000-8000-00000000000a",
    );
  });
});

describe("collectionTotalItems", () => {
  it("shows cash and UPI apart, payments with the cancelled ones, people", () => {
    render(
      <TotalsRow
        label="Totals"
        testId="c"
        items={collectionTotalItems(
          {
            cashPaise: p(115_000),
            upiPaise: p(90_000),
            count: 8,
            cancelledCount: 1,
            cancelledPaise: p(30_000),
            people: 4,
          },
          t,
        )}
      />,
    );
    expect(screen.getByTestId("c-cash")).toHaveTextContent("Cash₹1,150");
    expect(screen.getByTestId("c-upi")).toHaveTextContent("UPI₹900UPI is not cash");
    expect(screen.getByTestId("c-count")).toHaveTextContent(
      "Payments8 payments1 cancelled (₹300), not counted",
    );
    expect(screen.getByTestId("c-people")).toHaveTextContent("4 people");
  });
});
