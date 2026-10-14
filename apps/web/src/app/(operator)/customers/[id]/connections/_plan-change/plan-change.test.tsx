import { businessDate } from "@cb/domain";
import { ToastProvider } from "@cb/ui";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { effectLines } from "../_parts/effect";
import { ConnectionChangeForm, type ConnectionChangeFormProps } from "./change-form";
import { effectText } from "./effect-text";
import { changeErrorKey, type PreviewData, type PreviewResult } from "./results";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/customers/c1/connections",
}));

const rupees = (paise: number) => String(paise / 100);

const PREVIEW: PreviewData = {
  kind: "plan",
  fromRentalPaise: 40_000,
  toRentalPaise: 45_000,
  noChange: false,
  backDated: false,
  latestBilledPeriod: "2026-10-01",
  months: [
    {
      period: "2026-10-01",
      scope: "change_month",
      outcome: { kind: "debit", amountPaise: 5_000 },
      chargedBeforePaise: 40_000,
      chargedAfterPaise: 45_000,
    },
  ],
  totalPaise: 5_000,
};

const BACKDATED: PreviewData = {
  ...PREVIEW,
  backDated: true,
  months: [
    {
      period: "2026-09-01",
      scope: "change_month",
      outcome: { kind: "debit", amountPaise: 5_000 },
      chargedBeforePaise: 40_000,
      chargedAfterPaise: 45_000,
    },
    {
      period: "2026-10-01",
      scope: "later_month",
      outcome: { kind: "debit", amountPaise: 5_000 },
      chargedBeforePaise: 40_000,
      chargedAfterPaise: 45_000,
    },
  ],
  totalPaise: 10_000,
};

describe("effect text of a change (T-045)", () => {
  it("says the new rent, each month with its number, and no total for one month", () => {
    const text = effectText(PREVIEW, { locale: "en", rupees, isOwner: false });
    expect(text.headline).toEqual({
      key: "effect.new_rent",
      values: { to: "450", from: "400" },
      tone: "plain",
    });
    expect(text.months).toEqual([
      {
        key: "effect.debit",
        values: { month: "October 2026", amount: "50" },
        tone: "due",
      },
    ]);
    expect(text.total).toEqual({
      key: "effect.total_debit",
      values: { amount: "50" },
      tone: "due",
    });
    expect(text.billed).toBeNull();
  });

  it("a credit, a no-change reason, Hindi months, and the billed note for Staff and Owner", () => {
    const preview: PreviewData = {
      ...BACKDATED,
      months: [
        {
          period: "2026-09-01",
          scope: "change_month",
          outcome: { kind: "credit", amountPaise: 10_000 },
          chargedBeforePaise: 40_000,
          chargedAfterPaise: 30_000,
        },
        {
          period: "2026-10-01",
          scope: "later_month",
          outcome: { kind: "none", reason: "same_amount" },
          chargedBeforePaise: 30_000,
          chargedAfterPaise: 30_000,
        },
      ],
      totalPaise: -10_000,
    };
    const staff = effectText(preview, { locale: "hi", rupees, isOwner: false });
    expect(staff.months.map((m) => [m.key, m.tone, m.values.month])).toEqual([
      ["effect.credit", "credit", "सितंबर 2026"],
      ["effect.reason.same_amount", "plain", "अक्टूबर 2026"],
    ]);
    expect(staff.total).toMatchObject({ key: "effect.total_credit", values: { amount: "100" } });
    expect(staff.billed?.key).toBe("effect.billed_staff");
    expect(effectText(preview, { locale: "en", rupees, isOwner: true }).billed?.key).toBe(
      "effect.billed_owner",
    );
    expect(
      effectText({ ...PREVIEW, noChange: true, months: [] }, { locale: "en", rupees, isOwner: true })
        .headline.key,
    ).toBe("effect.same");
  });

  it("maps service errors to plain messages without ids", () => {
    expect(changeErrorKey({ code: "FORBIDDEN" })).toBe("not_allowed");
    expect(changeErrorKey({ code: "TENANT_READ_ONLY" })).toBe("read_only");
    expect(changeErrorKey({ code: "CONFLICT", details: { reason: "billed_period" } })).toBe(
      "billed_period",
    );
    expect(
      changeErrorKey({
        code: "VALIDATION",
        details: { fields: [{ path: "effectiveDate", code: "before_last_change" }] },
      }),
    ).toBe("before_last_change");
    expect(
      changeErrorKey({
        code: "VALIDATION",
        details: { fields: [{ path: "change.planId", code: "retired" }] },
      }),
    ).toBe("retired");
    expect(
      changeErrorKey({ code: "VALIDATION", details: { fields: [{ path: "reason", code: "x" }] } }),
    ).toBe("reason");
    expect(changeErrorKey({ code: "INTERNAL" })).toBe("generic");
  });
});

describe("“Start again” effect with the D-18 policy (T-045 extends T-034's effect text)", () => {
  const base = {
    action: "reactivate" as const,
    date: businessDate("2026-10-12"),
    duePaise: 0,
    locale: "en" as const,
    rupees,
  };
  it("charge_full_month and the month has no rent yet: the month's rent goes on the next bill", () => {
    expect(
      effectLines({
        ...base,
        startCharge: { policy: "charge_full_month", rentalPaise: 30_000, chargedPeriods: [] },
      }),
    ).toEqual([
      { key: "charge_month", values: { amount: "300", month: "October 2026" } },
      { key: "rent_starts", values: { month: "November 2026" } },
    ]);
  });
  it("nothing extra when the month already has rent, under start_next_month, or at ₹0", () => {
    for (const startCharge of [
      { policy: "charge_full_month" as const, rentalPaise: 30_000, chargedPeriods: ["2026-10-01"] },
      { policy: "start_next_month" as const, rentalPaise: 30_000, chargedPeriods: [] },
      { policy: "charge_full_month" as const, rentalPaise: 0, chargedPeriods: [] },
    ]) {
      expect(effectLines({ ...base, startCharge }).map((l) => l.key)).toEqual(["rent_starts"]);
    }
  });
});

describe("the change form", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
  });

  function renderForm(overrides: Partial<ConnectionChangeFormProps>, result: PreviewResult) {
    const preview = vi.fn(async () => result);
    const save = vi.fn(async () => ({ ok: true as const }));
    renderWithIntl(
      <ToastProvider closeLabel="Close" label="Notifications">
        <ConnectionChangeForm
          assignmentId="a1"
          vcNumber="5550 0011"
          mode="plan"
          isOwner={false}
          kinds={["plan"]}
          plans={[
            { id: "p1", name: "Basic", monthlyAmountPaise: 40_000 },
            { id: "p2", name: "Gold", monthlyAmountPaise: 45_000 },
          ]}
          currentPlanId="p1"
          currentRentalPaise={40_000}
          today="2026-10-14"
          minDate="2026-09-01"
          preview={preview}
          save={save}
          doneHref="/customers/c1/connections?saved=plan"
          cancelHref="/customers/c1/connections"
          {...overrides}
        />
      </ToastProvider>,
    );
    return { preview, save };
  }

  it("shows what the new plan does to the bill before saving, then saves", async () => {
    const { preview, save } = renderForm({}, { ok: true, preview: PREVIEW });
    fireEvent.change(screen.getByLabelText("New plan"), { target: { value: "p2" } });
    await screen.findByText("October 2026: ₹50 extra will be added to the next bill.");
    expect(preview).toHaveBeenLastCalledWith({
      assignmentId: "a1",
      effectiveDate: "2026-10-14",
      kind: "plan",
      planId: "p2",
    });
    expect(screen.getByText("New rent: ₹450 a month (was ₹400).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Save new plan/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({
      assignmentId: "a1",
      effectiveDate: "2026-10-14",
      kind: "plan",
      planId: "p2",
      backDated: false,
      reason: null,
    });
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/customers/c1/connections?saved=plan"),
    );
  });

  it("Staff: a date in a billed month can't be saved (ask the owner)", async () => {
    const { save } = renderForm({}, { ok: true, preview: BACKDATED });
    fireEvent.change(screen.getByLabelText("New plan"), { target: { value: "p2" } });
    await screen.findByText(/Ask the owner to change it from this day/);
    const button = screen.getByRole("button", { name: /Save new plan/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByLabelText("Why are you changing old bills?")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("Owner: a date in a billed month needs a reason, then saves through the back-dated flow", async () => {
    const { save } = renderForm({ isOwner: true }, { ok: true, preview: BACKDATED });
    fireEvent.change(screen.getByLabelText("New plan"), { target: { value: "p2" } });
    await screen.findByText("In all: ₹100 more to pay.");
    const button = screen.getByRole("button", {
      name: /Save with bill changes/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why are you changing old bills?"), {
      target: { value: "Forgot to enter it in September" },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        assignmentId: "a1",
        effectiveDate: "2026-10-14",
        kind: "plan",
        planId: "p2",
        backDated: true,
        reason: "Forgot to enter it in September",
      }),
    );
  });

  it("the Owner's earlier-day change offers the connection's changes and needs a stop reason for a removal", async () => {
    const { preview } = renderForm(
      { isOwner: true, mode: "backdate", kinds: ["plan", "suspend", "disconnect"] },
      { ok: true, preview: { ...BACKDATED, kind: "disconnect" } },
    );
    fireEvent.click(screen.getByRole("radio", { name: /Removed/ }));
    // No reason yet: no preview asked for a removal.
    expect(preview).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "disconnect" }));
    fireEvent.change(screen.getByLabelText("Why was it stopped?"), {
      target: { value: "moved_away" },
    });
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith({
        assignmentId: "a1",
        effectiveDate: "2026-10-14",
        kind: "disconnect",
        stopReason: "moved_away",
      }),
    );
    expect(screen.getByLabelText("Why are you changing old bills?")).toBeTruthy();
  });
});
