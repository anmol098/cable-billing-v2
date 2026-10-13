import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { billsView, CUSTOMER_ID, translators } from "../../history/_components/test-fixtures";
import { CustomerBills } from "./bills-view";

const HISTORY = `/customers/${CUSTOMER_ID}/history`;

describe("CustomerBills", () => {
  it("shows still due first, credit and a waiting extra charge, then every bill", () => {
    const { t, tb } = translators();
    render(<CustomerBills view={billsView()} t={t} tb={tb} locale="en" historyHref={HISTORY} />);
    expect(screen.getByTestId("bills-due")).toHaveTextContent("₹475");
    expect(screen.getByTestId("bills-due")).toHaveTextContent("Still due");
    expect(screen.getByText("3 bills")).toBeInTheDocument();
    expect(screen.getByTestId("bills-credit")).toHaveTextContent("₹200");
    expect(screen.getByTestId("bills-pending")).toHaveTextContent(
      "₹25 extra goes on the next bill",
    );
    expect(screen.getByTestId("bills-billed")).toHaveTextContent("₹1,175");
    expect(screen.getByTestId("bills-paid")).toHaveTextContent("₹700");
    expect(screen.getByRole("link", { name: "See account history" })).toHaveAttribute(
      "href",
      HISTORY,
    );

    const table = screen.getByRole("table", { name: "Bills of this customer" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const [dec, nov, old] = rows as HTMLElement[];
    expect(dec).toHaveTextContent("December 2026");
    expect(dec).toHaveTextContent("INV-2612-00001");
    expect(dec).toHaveTextContent("Part paid");
    expect(dec).toHaveTextContent("₹325");
    expect(within(dec as HTMLElement).getByRole("link", { name: "December 2026" })).toHaveAttribute(
      "href",
      "/bills/0193a000-0000-7000-8000-0000000000b3",
    );
    expect(nov).toHaveTextContent("Paid");
    expect(old).toHaveTextContent("Old dues");
    expect(old).toHaveTextContent("Not paid");
  });

  it("says when there are no bills yet, in Hindi too", () => {
    const { t, tb } = translators("hi");
    render(
      <CustomerBills
        view={billsView({
          rows: [],
          totals: {
            count: 0,
            chargesPaise: 0 as never,
            paidPaise: 0 as never,
            outstandingPaise: 0 as never,
          },
          pendingChargesPaise: 0 as never,
          creditPaise: 0 as never,
        })}
        t={t}
        tb={tb}
        locale="hi"
        historyHref={HISTORY}
      />,
    );
    expect(screen.getByText(/अभी कोई बिल नहीं/)).toBeInTheDocument();
    expect(screen.queryByTestId("bills-credit")).toBeNull();
    expect(screen.queryByTestId("bills-pending")).toBeNull();
    expect(screen.getByText("बिलों पर बाकी")).toBeInTheDocument();
  });
});
