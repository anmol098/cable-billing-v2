import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BillDetail } from "./bill-detail";
import { billsT, billView } from "./test-fixtures";

describe("BillDetail", () => {
  it("shows the amounts, the lines per VC, bill changes, payments and the account now", () => {
    render(<BillDetail t={billsT()} view={billView()} locale="en" />);
    expect(screen.getByTestId("bill-customer")).toHaveAttribute(
      "href",
      "/customers/0193a000-0000-7000-8000-0000000000c1",
    );
    expect(screen.getByText("Code A-1 · North")).toBeInTheDocument();
    expect(screen.getByTestId("bill-pay-state")).toHaveTextContent("Part paid");
    expect(screen.getByText("Old due")).toBeInTheDocument();
    expect(screen.getByTestId("bill-charges")).toHaveTextContent("₹575");
    expect(screen.getByTestId("bill-total")).toHaveTextContent("₹775");
    expect(screen.getByTestId("bill-paid")).toHaveTextContent("₹400");
    expect(screen.getByTestId("bill-outstanding")).toHaveTextContent("₹175");

    const [vc1, vc2] = screen.getAllByTestId("bill-connection");
    expect(vc1).toHaveTextContent("VC VC1001");
    expect(vc1).toHaveTextContent("₹350");
    expect(within(vc1 as HTMLElement).getByText("Monthly rent")).toBeInTheDocument();
    expect(within(vc1 as HTMLElement).getByText("Plan changed")).toBeInTheDocument();
    expect(vc2).toHaveTextContent("₹200");
    const other = screen.getByTestId("bill-other-lines");
    expect(other).toHaveTextContent("Bill change");
    expect(other).toHaveTextContent("Repair visit");
    expect(other).toHaveTextContent("₹25");

    const payments = within(screen.getByTestId("bill-payments")).getAllByRole("listitem");
    expect(payments[0]).toHaveTextContent("Cash");
    expect(payments[0]).toHaveTextContent("Receipt R-2611-00001 · 5 Nov 2026");
    expect(payments[0]).not.toHaveTextContent("Cancelled");
    expect(payments[1]).toHaveTextContent("UPI");
    expect(payments[1]).toHaveTextContent("Cancelled");

    expect(screen.getByTestId("account-now")).toHaveTextContent("₹375");
    expect(screen.getByTestId("account-now")).toHaveTextContent("Due");
  });

  it("shows credit before the bill, a cancelled bill, and no payments yet", () => {
    const base = billView();
    render(
      <BillDetail
        t={billsT()}
        locale="en"
        view={{
          ...base,
          bill: {
            ...base.bill,
            status: "void",
            payState: "void",
            openingBalancePaise: -5_000 as never,
            voidReason: "Made twice",
          },
          payments: [],
          balance: { balancePaise: -5_000 as never, creditPaise: 5_000 as never },
        }}
      />,
    );
    expect(screen.getByText("This bill was cancelled: Made twice")).toBeInTheDocument();
    expect(screen.getByText("Credit before this bill")).toBeInTheDocument();
    expect(screen.getByText("No payment on this bill yet.")).toBeInTheDocument();
    expect(screen.getByTestId("account-now")).toHaveTextContent("₹50");
    expect(screen.getByTestId("account-now")).toHaveTextContent("Credit");
  });

  it("speaks Hindi", () => {
    render(<BillDetail t={billsT("hi")} view={billView()} locale="hi" />);
    expect(screen.getByText("पुराना बाकी")).toBeInTheDocument();
    expect(screen.getByText("इस बिल पर बाकी")).toBeInTheDocument();
    expect(screen.getAllByText("महीने का किराया")).toHaveLength(2);
    expect(screen.getByText("नवंबर 2026")).toBeInTheDocument();
  });
});
