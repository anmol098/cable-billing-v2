import { billedFrom, rentStopsFrom as coreRentStopsFrom } from "@cb/core";
import { businessDate } from "@cb/domain";
import { ToastProvider } from "@cb/ui";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { AddCustomerWithConnection } from "../../../new/_steps/connections/add-customer-with-connection";
import { ConnectionFields } from "./connection-fields";
import { effectLines, rentStartsAgainFrom, rentStopsFrom } from "./effect";
import { connectionFormStateFor, isConnectionError, statusChangeErrorFor } from "./form-errors";
import {
  connectionInputFrom,
  connectionValuesFrom,
  EMPTY_CONNECTION_VALUES,
  OWN_AMOUNT,
  type StatusChangeResult,
} from "./form-state";
import { StatusActions, type StatusCommand } from "./status-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/customers/new",
}));

const PLANS = [
  { id: "p1", name: "Basic", monthlyAmountPaise: 25_000 },
  { id: "p2", name: "Gold", monthlyAmountPaise: 45_000 },
];
const rupees = (paise: number) => String(paise / 100);

describe("effect text (PLAN §12.2)", () => {
  it("uses the same months as the core rules", () => {
    for (const day of ["2026-10-01", "2026-10-13", "2026-10-31", "2026-12-31"]) {
      const date = businessDate(day);
      expect(rentStopsFrom(date)).toBe(coreRentStopsFrom(date));
      expect(rentStartsAgainFrom(date)).toBe(billedFrom("reactivate", date));
    }
  });

  it("a stop: rent stops next month, old due stays", () => {
    const lines = effectLines({
      action: "suspend",
      date: businessDate("2026-10-13"),
      duePaise: 45_000,
      locale: "en",
      rupees,
    });
    expect(lines).toEqual([
      { key: "rent_stops", values: { month: "November 2026" } },
      { key: "old_due", values: { amount: "450" } },
    ]);
  });

  it("a removal also frees the box from the next day; no due, no due line", () => {
    const lines = effectLines({
      action: "disconnect",
      date: businessDate("2026-10-31"),
      duePaise: 0,
      locale: "hi",
      rupees,
    });
    expect(lines.map((l) => l.key)).toEqual(["rent_stops", "reuse", "final"]);
    expect(lines[0]?.values.month).toBe("नवंबर 2026");
    expect(lines[1]?.values.date).toBe("1 नव 2026");
  });

  it("starting again: rent from next month", () => {
    expect(
      effectLines({
        action: "reactivate",
        date: businessDate("2026-11-01"),
        duePaise: 100,
        locale: "en",
        rupees,
      }),
    ).toEqual([{ key: "rent_starts", values: { month: "December 2026" } }]);
  });
});

describe("connection form input", () => {
  const values = { vcNumber: "1234", rentChoice: "p1", rentalPaise: "", startDate: "2026-10-13" };

  it("a plan or an own amount in whole rupees", () => {
    expect(connectionInputFrom(values)).toEqual({
      ok: true,
      input: { vcNumber: "1234", planId: "p1", startDate: "2026-10-13" },
    });
    expect(
      connectionInputFrom({ ...values, rentChoice: OWN_AMOUNT, rentalPaise: "30000" }),
    ).toEqual({
      ok: true,
      input: { vcNumber: "1234", rentalPaise: 30_000, startDate: "2026-10-13" },
    });
  });

  it("says what is missing", () => {
    expect(connectionInputFrom({ ...EMPTY_CONNECTION_VALUES })).toEqual({
      ok: false,
      fields: { vcNumber: "vc_required", rentChoice: "choose_rent", startDate: "date_invalid" },
    });
    expect(connectionInputFrom({ ...values, rentChoice: OWN_AMOUNT, rentalPaise: "150" })).toEqual({
      ok: false,
      fields: { rentalPaise: "amount_invalid" },
    });
  });

  it("reads the fields from a form", () => {
    const form = new FormData();
    form.set("vcNumber", "55 66");
    form.set("rentChoice", OWN_AMOUNT);
    form.set("rentalPaise", "20000");
    form.set("startDate", "2026-10-14");
    expect(connectionValuesFrom(form)).toEqual({
      vcNumber: "55 66",
      rentChoice: OWN_AMOUNT,
      rentalPaise: "20000",
      startDate: "2026-10-14",
    });
  });
});

describe("connection form errors", () => {
  const values = { ...EMPTY_CONNECTION_VALUES, vcNumber: "1234" };

  it("a VC that is with another customer, with until when", () => {
    const state = connectionFormStateFor(
      {
        code: "CONFLICT",
        details: {
          reason: "vc_in_use",
          holderCustomerId: "c9",
          holderName: "Ramesh",
          holderCustomerCode: "101",
          until: "2026-10-13",
          earliestStart: "2026-10-14",
          sameCustomer: false,
          connectionIndex: 0,
        },
      },
      values,
    );
    expect(state).toEqual({
      error: "fix_fields",
      fields: { vcNumber: "vc_in_use_until" },
      values,
      holder: {
        customerId: "c9",
        name: "Ramesh",
        code: "101",
        until: "2026-10-13",
        earliestStart: "2026-10-14",
      },
    });
    expect(
      connectionFormStateFor(
        { code: "CONFLICT", details: { reason: "vc_in_use", sameCustomer: true } },
        values,
      ).fields,
    ).toEqual({ vcNumber: "vc_here" });
  });

  it("maps field problems (also inside Add customer) and billed months", () => {
    const error = {
      code: "VALIDATION" as const,
      details: {
        connectionIndex: 0,
        fields: [
          { path: "connections.0.startDate", code: "in_future" },
          { path: "connections.0.planId", code: "retired" },
        ],
      },
    };
    expect(isConnectionError(error)).toBe(true);
    expect(connectionFormStateFor(error, values).fields).toEqual({
      startDate: "start_future",
      rentChoice: "plan_retired",
    });
    expect(isConnectionError({ code: "VALIDATION", details: { fields: [{ path: "name" }] } })).toBe(
      false,
    );
    expect(
      connectionFormStateFor(
        {
          code: "CONFLICT",
          details: { reason: "billed_period", period: "2026-10-01", earliestDate: "2026-10-01" },
        },
        values,
      ),
    ).toMatchObject({
      fields: { startDate: "date_billed" },
      billed: { period: "2026-10-01", earliestDate: "2026-10-01" },
    });
    expect(connectionFormStateFor({ code: "TENANT_READ_ONLY" }, values).error).toBe("read_only");
  });

  it("status changes: billed months say 'ask the owner' to Staff only", () => {
    const billed = {
      code: "CONFLICT" as const,
      details: { reason: "billed_period", period: "2026-10-01", earliestDate: "2026-10-01" },
    };
    expect(statusChangeErrorFor(billed, false)).toEqual({
      error: "date_billed_staff",
      period: "2026-10-01",
      date: "2026-10-01",
    });
    expect(statusChangeErrorFor(billed, true).error).toBe("date_billed");
    expect(
      statusChangeErrorFor({ code: "CONFLICT", details: { reason: "invalid_transition" } }, true),
    ).toEqual({ error: "changed" });
    expect(
      statusChangeErrorFor(
        {
          code: "VALIDATION",
          details: { fields: [{ path: "effectiveDate", code: "before_last_change" }] },
        },
        true,
      ),
    ).toEqual({ error: "date_before_last_change" });
  });
});

describe("ConnectionFields", () => {
  it("offers the plans and 'Own amount', which shows the amount box", async () => {
    renderWithIntl(
      <form>
        <ConnectionFields
          plans={PLANS}
          values={EMPTY_CONNECTION_VALUES}
          state={{}}
          today="2026-10-13"
          latestStartDate="2026-10-14"
          earliestStartDate={null}
        />
      </form>,
    );
    const rent = screen.getByLabelText("Monthly rent");
    expect(within(rent).getByRole("option", { name: "Basic · ₹250" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Rent (₹ a month)")).toBeNull();
    fireEvent.change(rent, { target: { value: OWN_AMOUNT } });
    expect(screen.getByLabelText("Rent (₹ a month)")).toBeInTheDocument();
    const start = screen.getByLabelText("Start day");
    expect(start).toHaveValue("2026-10-13");
    expect(start).toHaveAttribute("max", "2026-10-14");
  });

  it("says who has the VC and from when it can start here", () => {
    renderWithIntl(
      <ConnectionFields
        plans={[]}
        values={{ ...EMPTY_CONNECTION_VALUES, vcNumber: "1234" }}
        state={{
          error: "fix_fields",
          fields: { vcNumber: "vc_in_use_until" },
          holder: {
            customerId: "c9",
            name: "Ramesh",
            code: "101",
            until: "2026-10-13",
            earliestStart: "2026-10-14",
          },
        }}
        today="2026-10-13"
        latestStartDate="2026-10-14"
        earliestStartDate={null}
      />,
    );
    expect(
      screen.getByText(
        "This VC is with Ramesh (code 101) until 13 Oct 2026. It can start here from 14 Oct 2026.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open that customer" })).toHaveAttribute(
      "href",
      "/customers/c9/connections",
    );
    // No plans yet: the own amount box is shown at once.
    expect(screen.getByText("No plans yet: write the rent.")).toBeInTheDocument();
    expect(screen.getByLabelText("Rent (₹ a month)")).toBeInTheDocument();
  });
});

describe("StatusActions", () => {
  beforeEach(() => router.refresh.mockClear());

  function setup(
    action = vi.fn<(command: StatusCommand) => Promise<StatusChangeResult>>(async () => ({
      ok: true,
    })),
    locale: "en" | "hi" = "en",
    actions: ("suspend" | "reactivate" | "disconnect")[] = ["suspend", "disconnect"],
  ) {
    renderWithIntl(
      <ToastProvider closeLabel="Close" label="Notifications">
        <StatusActions
          assignmentId="a1"
          vcNumber="12345"
          actions={actions}
          today="2026-10-13"
          earliestChangeDate="2026-10-01"
          startDate="2026-09-05"
          lastChangeDate="2026-09-05"
          duePaise={45_000}
          action={action}
        />
      </ToastProvider>,
      locale,
    );
    return action;
  }

  it("Stop says the effect in plain words, then stops from the chosen day", async () => {
    const action = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Stop set-top box 12345?" });
    expect(sheet).toHaveTextContent("Rent stops from November 2026.");
    expect(sheet).toHaveTextContent("₹450 old due stays.");
    fireEvent.change(within(sheet).getByLabelText("From which day?"), {
      target: { value: "2026-10-01" },
    });
    expect(sheet).toHaveTextContent("Rent stops from November 2026.");
    fireEvent.change(within(sheet).getByLabelText("Why? (if you know)"), {
      target: { value: "not_paying" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith({
        assignmentId: "a1",
        action: "suspend",
        effectiveDate: "2026-10-01",
        reason: "not_paying",
        note: null,
      }),
    );
    expect(await screen.findByText("Connection stopped.")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("Remove needs a reason and says the box is free from the next day", async () => {
    const action = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const sheet = await screen.findByRole("alertdialog", {
      name: "Remove set-top box 12345 for good?",
    });
    expect(sheet).toHaveTextContent("The box can go to another customer from 14 Oct 2026.");
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Remove" })));
    expect(await screen.findByText("Choose a reason.")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
    expect(sheet).toBeInTheDocument();
  });

  it("a billed month is refused with the earliest day (Staff wording)", async () => {
    const action = vi.fn(
      async () =>
        ({
          ok: false,
          error: "date_billed_staff",
          period: "2026-10-01",
          date: "2026-10-01",
        }) as const,
    );
    setup(action, "en", ["reactivate"]);
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    const sheet = await screen.findByRole("alertdialog");
    expect(sheet).toHaveTextContent("Rent starts again from November 2026.");
    await act(async () =>
      fireEvent.click(within(sheet).getByRole("button", { name: "Start again" })),
    );
    expect(
      await screen.findByText(
        "Bills for October 2026 are already made. Choose 1 Oct 2026 or later, or ask the owner.",
      ),
    ).toBeInTheDocument();
  });

  it("Hindi words", () => {
    setup(undefined, "hi", ["suspend", "reactivate", "disconnect"]);
    expect(screen.getByRole("button", { name: "बंद करें" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "फिर से चालू करें" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "हटाएँ" })).toBeInTheDocument();
  });
});

describe("Add customer with a connection", () => {
  it("step 2 takes the VC; Check & save shows it", async () => {
    renderWithIntl(
      <AddCustomerWithConnection
        action={vi.fn(async () => ({}))}
        areas={[]}
        nextAutoCode="7"
        plans={PLANS}
        today="2026-10-13"
        latestStartDate="2026-10-14"
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Meena" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("VC number"), { target: { value: "8800 1122" } });
    fireEvent.change(screen.getByLabelText("Monthly rent"), { target: { value: "p2" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    const check = document.querySelector("[data-check=connection]") as HTMLElement;
    expect(check).toHaveTextContent("8800 1122 · ₹450 a month · from 13 Oct 2026");
  });

  it("an empty VC box means no connection now", async () => {
    renderWithIntl(
      <AddCustomerWithConnection
        action={vi.fn(async () => ({}))}
        areas={[]}
        nextAutoCode="7"
        plans={PLANS}
        today="2026-10-13"
        latestStartDate="2026-10-14"
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Meena" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    const check = document.querySelector("[data-check=connection]") as HTMLElement;
    expect(check).toHaveTextContent("No connection now");
  });

  it("a refused VC goes back to step 2 with the problem", async () => {
    const action = vi.fn(async () => ({
      error: "fix_fields" as const,
      step: 1,
      values: { customerCode: "", name: "Meena", phone: "", altPhone: "", areaId: "", address: "" },
      connection: {
        error: "fix_fields" as const,
        fields: { vcNumber: "vc_in_use" as const },
        values: { vcNumber: "1234", rentChoice: "p1", rentalPaise: "", startDate: "2026-10-13" },
        holder: { customerId: "c9", name: "Ramesh", code: "101", until: null, earliestStart: null },
      },
    }));
    renderWithIntl(
      <AddCustomerWithConnection
        action={action}
        areas={[]}
        nextAutoCode="7"
        plans={PLANS}
        today="2026-10-13"
        latestStartDate="2026-10-14"
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Meena" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save customer" })));
    await waitFor(() => expect(screen.getByText("Step 2 of 3")).toBeInTheDocument());
    expect(screen.getByText("This VC is with Ramesh (code 101).")).toBeVisible();
    expect(screen.getByLabelText("VC number")).toHaveValue("1234");
  });
});
