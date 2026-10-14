import { type Paise, period } from "@cb/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgeingCards, AsOfNote, DuesByAreaTable, DuesList, Pager, TotalsRow } from "./parts";
import { AS_OF_NOW, areaTotals, duesRow, duesTotals, reportsT } from "./test-fixtures";

const t = reportsT();
const hi = reportsT("hi");
const p = (value: number) => value as Paise;

describe("AsOfNote", () => {
  it("says when the numbers are from, and what is left out", () => {
    render(<AsOfNote asOf={AS_OF_NOW} locale="en" t={t} />);
    const note = screen.getByTestId("as-of");
    expect(note).toHaveTextContent("Numbers as of 2 Nov 2026, 10:00 am");
    expect(note).toHaveTextContent("reach the office after this time are not in these numbers");
  });

  it("speaks Hindi", () => {
    render(<AsOfNote asOf={AS_OF_NOW} locale="hi" t={hi} />);
    expect(screen.getByTestId("as-of")).toHaveTextContent("2 नव 2026");
    expect(screen.getByTestId("as-of")).toHaveTextContent("तक के आँकड़े");
  });
});

describe("TotalsRow", () => {
  it("shows each total with its label and note", () => {
    render(
      <TotalsRow
        label="Totals"
        testId="x"
        items={[
          { id: "a", label: "Total due", value: "₹4,050", note: "5 customers" },
          { id: "b", label: "Credit", value: "₹1,600" },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: "Totals" });
    expect(within(region).getByTestId("x-a")).toHaveTextContent("Total due₹4,0505 customers");
    expect(within(region).getByTestId("x-b")).toHaveTextContent("Credit₹1,600");
  });
});

describe("AgeingCards", () => {
  it("shows the four buckets with amounts, customers and a link each", () => {
    render(
      <AgeingCards
        totals={duesTotals()}
        t={t}
        active="d90_plus"
        hrefFor={(bucket) => `/reports/dues?age=${bucket}`}
      />,
    );
    expect(screen.getByRole("heading", { name: "How old is the due" })).toBeInTheDocument();
    const old = screen.getByTestId("bucket-d90_plus");
    expect(old).toHaveAttribute("href", "/reports/dues?age=d90_plus");
    expect(old).toHaveAttribute("aria-current", "true");
    expect(old).toHaveTextContent("Over 90 days");
    expect(old).toHaveTextContent("3 customers");
    expect(screen.getByTestId("bucket-d90_plus-amount")).toHaveTextContent("₹1,350");
    expect(screen.getByTestId("bucket-d0_30-amount")).toHaveTextContent("₹0");
    expect(screen.getByTestId("bucket-d0_30")).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("bucket-d0_30")).toHaveTextContent("No customers");
    // Never colour alone: each bucket is a pill with an icon and a word.
    expect(within(screen.getByTestId("bucket-d61_90")).getByText("61–90 days")).toBeVisible();
  });

  it("speaks Hindi", () => {
    render(<AgeingCards totals={duesTotals()} t={hi} hrefFor={() => "#"} />);
    expect(screen.getByTestId("bucket-d90_plus")).toHaveTextContent("90 दिन से ज़्यादा");
    expect(screen.getByTestId("bucket-d90_plus")).toHaveTextContent("3 ग्राहक");
  });
});

describe("DuesByAreaTable", () => {
  it("lists areas with a bucket per column and a Total row", () => {
    const north = areaTotals("a1", "North", {
      dueCustomers: 3,
      duePaise: p(230_000),
      advancePaise: p(0),
    });
    const none = areaTotals(null, null, {
      dueCustomers: 0,
      duePaise: p(0),
      advancePaise: p(160_000),
      buckets: { d0_30: p(0), d31_60: p(0), d61_90: p(0), d90_plus: p(0) },
    });
    render(
      <DuesByAreaTable
        byArea={[north, none]}
        totals={duesTotals()}
        t={t}
        hrefFor={(id, isTotal) => (isTotal ? "/all" : `/area/${id}`)}
      />,
    );
    const table = screen.getByRole("table", { name: "Due by area" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Area0–30 days31–60 days61–90 daysOver 90 days");
    expect(rows[1]).toHaveTextContent("North₹2,300 due · 3 customers");
    expect(within(rows[1] as HTMLElement).getByRole("link")).toHaveAttribute("href", "/area/a1");
    expect(rows[2]).toHaveTextContent("No area₹0 due · No customers · ₹1,600 credit");
    expect(rows[3]).toHaveTextContent("Total₹4,050 due · 5 customers · ₹1,600 credit");
    expect(rows[3]).toHaveTextContent("₹1,450₹1,250₹1,350");
    expect(within(rows[3] as HTMLElement).getByRole("link")).toHaveAttribute("href", "/all");
  });
});

describe("DuesList", () => {
  it("shows who owes, since when and how old, rows open the customer", () => {
    render(
      <DuesList
        rows={[
          duesRow(),
          duesRow({
            customerId: "c2",
            customerCode: "Z-9",
            customerName: "Zoya",
            areaName: null,
            customerStatus: "inactive",
            duePaise: p(5_000),
            oldestDuePeriod: null,
            oldestBucket: "d0_30",
          }),
        ]}
        kind="due"
        t={t}
        locale="en"
        empty="Nobody owes money here."
      />,
    );
    const table = screen.getByRole("table", { name: "Customers who owe" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent("CustomerDueUnpaid sinceHow old");
    expect(rows[1]).toHaveTextContent("Asha DeviA-1 · North₹1,000July 2026Over 90 days");
    expect(within(rows[1] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/customers/0193a000-0000-7000-8000-0000000000a1",
    );
    expect(rows[2]).toHaveTextContent("ZoyaZ-9 · Closed₹50Not on a bill yet0–30 days");
  });

  it("with an age filter, shows the due of that age (what the age card adds up)", () => {
    render(<DuesList rows={[duesRow()]} kind="due" t={t} locale="en" empty="x" bucket="d61_90" />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[0]).toHaveTextContent("Due: 61–90 days");
    expect(rows[1]).toHaveTextContent("₹300of ₹1,000 due");
  });

  it("shows credit customers, in Hindi too, and an empty sentence", () => {
    const { rerender } = render(
      <DuesList
        rows={[duesRow({ duePaise: p(0), advancePaise: p(160_000), oldestBucket: null })]}
        kind="advance"
        t={hi}
        locale="hi"
        empty="x"
      />,
    );
    const table = screen.getByRole("table", { name: "जिनका एडवांस है" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Asha DeviA-1 · North₹1,600");
    rerender(<DuesList rows={[]} kind="due" t={t} locale="en" empty="Nobody owes money here." />);
    expect(screen.getByText("Nobody owes money here.")).toBeInTheDocument();
  });

  it("formats the oldest month in Hindi", () => {
    render(
      <DuesList
        rows={[duesRow({ oldestDuePeriod: period("2026-07-01") })]}
        kind="due"
        t={hi}
        locale="hi"
        empty="x"
      />,
    );
    expect(screen.getByRole("table")).toHaveTextContent("जुलाई 2026");
    expect(screen.getByRole("table")).toHaveTextContent("कब से बाकी");
  });
});

describe("Pager", () => {
  it("links to the pages around, nothing for one page", () => {
    const { rerender, container } = render(
      <Pager page={2} pages={3} t={t} hrefFor={(page) => `/x?page=${page}`} />,
    );
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/x?page=1");
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/x?page=3");
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    rerender(<Pager page={1} pages={1} t={t} hrefFor={() => "#"} />);
    expect(container).toBeEmptyDOMElement();
  });
});
