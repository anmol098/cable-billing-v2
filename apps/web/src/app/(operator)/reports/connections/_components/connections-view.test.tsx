import { businessDate } from "@cb/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TotalsRow } from "@/components/reports/parts";
import { connectionRow, nsT, p } from "../../collections/_lib/test-fixtures";
import { ConnectionsTable, connectionTotalItems } from "./connections-view";

const t = nsT("reports");
const ct = nsT("connections");

describe("ConnectionsTable", () => {
  it("shows the status since when, the VC number, plan and monthly rent", () => {
    render(
      <ConnectionsTable
        rows={[
          connectionRow(),
          connectionRow({
            assignmentId: "0190a000-0000-7000-8000-0000000000c2",
            customerCode: "B-2",
            customerName: "Bina Rao",
            areaName: "North",
            status: "active",
            since: businessDate("2026-10-01"),
            planId: "0190a000-0000-7000-8000-0000000000aa",
            planName: "Basic",
            rentPaise: p(30_000),
          }),
          connectionRow({
            assignmentId: "0190a000-0000-7000-8000-0000000000c3",
            customerCode: "D-4",
            customerName: "Dev",
            areaName: null,
            status: "disconnected",
            since: businessDate("2026-11-01"),
          }),
        ]}
        t={t}
        ct={ct}
        locale="en"
      />,
    );
    const table = screen.getByRole("table", { name: "Connections" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Customer", "VC number", "Status", "Monthly rent"]);
    const [, chandu, bina, dev] = within(table).getAllByRole("row") as HTMLElement[];
    expect(chandu).toHaveTextContent(
      "ChanduC-3 · South000123456789StoppedFrom 16 Oct 2026₹250Own amount",
    );
    expect(bina).toHaveTextContent("ActiveFrom 1 Oct 2026₹300Basic");
    expect(dev).toHaveTextContent("RemovedFrom 1 Nov 2026");
    expect(within(chandu as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/customers/0190a000-0000-7000-8000-0000000000d1/connections",
    );
  });

  it("speaks Hindi and says when there is nothing", () => {
    const { unmount } = render(
      <ConnectionsTable
        rows={[connectionRow()]}
        t={nsT("reports", "hi")}
        ct={nsT("connections", "hi")}
        locale="hi"
      />,
    );
    const table = screen.getByRole("table", { name: "कनेक्शन" });
    expect(table).toHaveTextContent("बंद");
    expect(table).toHaveTextContent("16 अक्टू 2026 से");
    unmount();
    render(<ConnectionsTable rows={[]} t={t} ct={ct} locale="en" />);
    expect(screen.getByText("No connections here.")).toBeInTheDocument();
  });
});

describe("connectionTotalItems", () => {
  it("active with their monthly rent, stopped, removed", () => {
    render(
      <TotalsRow
        label="Totals"
        testId="k"
        items={connectionTotalItems(
          {
            connections: 7,
            byStatus: { active: 5, suspended: 1, disconnected: 1 },
            activeRentPaise: p(140_000),
            activeCustomers: 5,
          },
          t,
          ct,
        )}
      />,
    );
    expect(screen.getByTestId("k-active")).toHaveTextContent("Active5 connections5 customers");
    expect(screen.getByTestId("k-rent")).toHaveTextContent(
      "Monthly rent of active connections₹1,400",
    );
    expect(screen.getByTestId("k-suspended")).toHaveTextContent("Stopped1 connection");
    expect(screen.getByTestId("k-disconnected")).toHaveTextContent(
      "Removed1 connectionAll connections: 7 connections",
    );
  });
});
