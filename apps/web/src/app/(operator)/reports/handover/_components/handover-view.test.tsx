import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TotalsRow } from "@/components/reports/parts";
import { handoverRow, nsT, p } from "../../collections/_lib/test-fixtures";
import { differenceTotal, HandoverTable, handoverTotalItems } from "./handover-view";

const t = nsT("reports");
const lt = nsT("linemen");

describe("HandoverTable", () => {
  it("shows expected vs handed over, the difference and reason, UPI apart and the status", () => {
    render(<HandoverTable rows={[handoverRow()]} t={t} lt={lt} locale="en" />);
    const table = screen.getByRole("table", { name: "Linemen's days" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Lineman and day", "Cash expected", "Cash handed over", "Difference", "Status"]);
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(row).toHaveTextContent("Suresh Pal31 Oct 2026");
    expect(row).toHaveTextContent("₹300");
    expect(row).toHaveTextContent("UPI ₹200: not part of the cash");
    // The total moved after the handover (an undone payment): the expected cash then is shown.
    expect(row).toHaveTextContent("₹600 expected at handover");
    expect(row).toHaveTextContent("₹550");
    expect(row).toHaveTextContent("₹50 short");
    expect(row).toHaveTextContent("Lineman's reason: Less cash");
    expect(row).toHaveTextContent("Waiting for check");
    // The row opens T-062's review screen for that day.
    expect(within(row).getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/linemen/0190a000-0000-7000-8000-00000000000b?date=2026-10-31",
    );
  });

  it("lists what happened, oldest first, with notes", () => {
    render(<HandoverTable rows={[handoverRow()]} t={t} lt={lt} locale="en" />);
    const table = screen.getByRole("table", { name: "Linemen's days" });
    const history = within(table).getByTestId("handover-history");
    expect(within(history).getByText("What happened (2 steps)")).toBeInTheDocument();
    const steps = within(history).getAllByRole("listitem");
    expect(steps[0]).toHaveTextContent(
      "8:00 PM: Suresh Pal handed over ₹550 (expected ₹600)₹50 short · Less cashLineman's note: One note was torn",
    );
    expect(steps[1]).toHaveTextContent(
      "1 Nov 2026, 9:00 AM: Owner Om sent it backOffice note: Count again",
    );
  });

  it("a day not handed over yet, an accepted one that matches", () => {
    render(
      <HandoverTable
        rows={[
          handoverRow({
            sessionId: "0190a000-0000-7000-8000-0000000000b2",
            status: "open",
            handover: null,
            changedSinceHandover: false,
            history: [],
            upiTotalPaise: p(0),
          }),
          handoverRow({
            sessionId: "0190a000-0000-7000-8000-0000000000b3",
            status: "accepted",
            cashExpectedPaise: p(55_000),
            changedSinceHandover: false,
            handover: {
              cashExpectedPaise: p(55_000),
              cashHandedOverPaise: p(55_000),
              discrepancyPaise: 0,
              discrepancyReason: null,
              note: null,
              submittedAt: new Date("2026-11-01T04:00:00Z"),
              reviewedAt: new Date("2026-11-01T04:30:00Z"),
              reviewedByName: "Owner Om",
              reviewNote: null,
            },
          }),
        ]}
        t={t}
        lt={lt}
        locale="en"
      />,
    );
    const [, open, accepted] = screen
      .getAllByRole("row")
      .filter((row) => row.closest("table")) as HTMLElement[];
    expect(open).toHaveTextContent("Not handed over yet");
    expect(open).toHaveTextContent("Not handed over");
    expect(open).not.toHaveTextContent("What happened");
    expect(accepted).toHaveTextContent("Cash matches");
    expect(accepted).toHaveTextContent("Accepted");
    expect(accepted).not.toHaveTextContent("expected at handover");
  });

  it("speaks Hindi and says when there is nothing", () => {
    const { unmount } = render(
      <HandoverTable
        rows={[handoverRow()]}
        t={nsT("reports", "hi")}
        lt={nsT("linemen", "hi")}
        locale="hi"
      />,
    );
    const table = screen.getByRole("table", { name: "लाइनमैन के दिन" });
    expect(table).toHaveTextContent("₹50 कम");
    expect(table).toHaveTextContent("जाँच बाकी");
    unmount();
    render(<HandoverTable rows={[]} t={t} lt={lt} locale="en" />);
    expect(screen.getByText("No cash to hand over on these days.")).toBeInTheDocument();
  });
});

describe("handoverTotalItems", () => {
  it("cash expected (UPI apart), handed over, short and extra, not handed over", () => {
    render(
      <TotalsRow
        label="Totals"
        testId="h"
        items={handoverTotalItems(
          {
            days: 3,
            cashExpectedPaise: p(95_000),
            upiTotalPaise: p(75_000),
            cashHandedOverPaise: p(110_000),
            notHandedOverPaise: p(10_000),
            shortPaise: p(5_000),
            extraPaise: p(0),
            differenceCount: 1,
            byStatus: { open: 1, submitted: 1, accepted: 1, returned: 0 },
          },
          t,
        )}
      />,
    );
    expect(screen.getByTestId("h-expected")).toHaveTextContent(
      "Cash expected₹950UPI ₹750 is not cash",
    );
    expect(screen.getByTestId("h-handed")).toHaveTextContent(
      "Cash handed over₹1,1002 days handed over",
    );
    expect(screen.getByTestId("h-difference")).toHaveTextContent(
      "Difference₹50 short1 day with a difference",
    );
    expect(screen.getByTestId("h-not_handed")).toHaveTextContent("Not handed over yet₹1001 day");
  });

  it("names only the differences that are there", () => {
    expect(differenceTotal({ shortPaise: p(5_000), extraPaise: p(2_000) }, t)).toBe(
      "₹50 short · ₹20 extra",
    );
    expect(differenceTotal({ shortPaise: p(0), extraPaise: p(2_000) }, t)).toBe("₹20 extra");
    expect(differenceTotal({ shortPaise: p(0), extraPaise: p(0) }, t)).toBe("Cash matches");
    expect(differenceTotal({ shortPaise: p(5_000), extraPaise: p(0) }, nsT("reports", "hi"))).toBe(
      "₹50 कम",
    );
  });
});
