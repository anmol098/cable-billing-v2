import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { OWN_AMOUNT } from "../_parts/form-state";
import { addEffectText } from "./effect-text";
import { BackDatedAddForm } from "./form";
import {
  type AddPreviewData,
  type AddPreviewResult,
  type BackDatedAddFormState,
  previewErrorKey,
  previewInputFrom,
} from "./state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/customers/c1/connections",
}));

const rupees = (paise: number) => String(paise / 100);

/** A start on 10 Sep with September, October and November billed (charge_full_month). */
const BACKDATED: AddPreviewData = {
  startDate: "2026-09-10",
  rentalPaise: 30_000,
  backDated: true,
  latestBilledPeriod: "2026-11-01",
  months: [
    {
      period: "2026-09-01",
      scope: "change_month",
      outcome: { kind: "debit", amountPaise: 30_000 },
      chargedBeforePaise: 0,
      chargedAfterPaise: 30_000,
    },
    {
      period: "2026-10-01",
      scope: "later_month",
      outcome: { kind: "debit", amountPaise: 30_000 },
      chargedBeforePaise: 0,
      chargedAfterPaise: 30_000,
    },
    {
      period: "2026-11-01",
      scope: "later_month",
      outcome: { kind: "debit", amountPaise: 30_000 },
      chargedBeforePaise: 0,
      chargedAfterPaise: 30_000,
    },
  ],
  totalPaise: 90_000,
};

const TODAY: AddPreviewData = {
  startDate: "2026-11-14",
  rentalPaise: 30_000,
  backDated: false,
  latestBilledPeriod: "2026-11-01",
  months: [
    {
      period: "2026-11-01",
      scope: "change_month",
      outcome: { kind: "none", reason: "start_next_month" },
      chargedBeforePaise: 0,
      chargedAfterPaise: 0,
    },
  ],
  totalPaise: 0,
};

describe("effect text of a back-dated new connection (T-045a)", () => {
  it("says the new rent and start day, each month with its number, the total and the billed note", () => {
    const text = addEffectText(BACKDATED, { locale: "en", rupees, isOwner: true });
    expect(text.headline).toEqual({
      key: "add_backdated.headline",
      values: { amount: "300", date: "10 Sep 2026" },
      tone: "plain",
    });
    expect(text.months.map((m) => [m.key, m.values, m.tone])).toEqual([
      ["effect.debit", { month: "September 2026", amount: "300" }, "due"],
      ["effect.debit", { month: "October 2026", amount: "300" }, "due"],
      ["effect.debit", { month: "November 2026", amount: "300" }, "due"],
    ]);
    expect(text.total).toEqual({
      key: "effect.total_debit",
      values: { amount: "900" },
      tone: "due",
    });
    expect(text.billed).toEqual({
      key: "effect.billed_owner",
      values: { month: "November 2026" },
      tone: "plain",
    });
  });

  it("start_next_month: the start month says no charge; Hindi months", () => {
    const text = addEffectText(
      {
        ...BACKDATED,
        months: [
          {
            period: "2026-09-01",
            scope: "change_month",
            outcome: { kind: "none", reason: "start_next_month" },
            chargedBeforePaise: 0,
            chargedAfterPaise: 0,
          },
          ...BACKDATED.months.slice(1),
        ],
        totalPaise: 60_000,
      },
      { locale: "hi", rupees, isOwner: true },
    );
    expect(text.months.map((m) => [m.key, m.values.month])).toEqual([
      ["effect.reason.start_next_month", "सितंबर 2026"],
      ["effect.debit", "अक्टूबर 2026"],
      ["effect.debit", "नवंबर 2026"],
    ]);
    expect(text.total?.values).toEqual({ amount: "600" });
  });
});

describe("preview input and errors", () => {
  const values = { vcNumber: "", rentChoice: "", rentalPaise: "", startDate: "2026-09-10" };

  it("needs a rent and a day, not the VC number", () => {
    expect(previewInputFrom(values)).toBeNull();
    expect(previewInputFrom({ ...values, rentChoice: "p1" })).toEqual({
      planId: "p1",
      startDate: "2026-09-10",
    });
    expect(previewInputFrom({ ...values, rentChoice: OWN_AMOUNT, rentalPaise: "30000" })).toEqual({
      rentalPaise: 30_000,
      startDate: "2026-09-10",
    });
    expect(previewInputFrom({ ...values, rentChoice: OWN_AMOUNT, rentalPaise: "" })).toBeNull();
    expect(
      previewInputFrom({ ...values, rentChoice: OWN_AMOUNT, rentalPaise: "30050" }),
    ).toBeNull();
    expect(previewInputFrom({ ...values, rentChoice: "p1", startDate: "" })).toBeNull();
  });

  it("maps service errors to plain messages without ids", () => {
    const field = (path: string, code: string) => ({
      code: "VALIDATION",
      details: { fields: [{ path, code }] },
    });
    expect(previewErrorKey(field("startDate", "in_future"))).toBe("in_future");
    expect(previewErrorKey(field("startDate", "too_old"))).toBe("too_old");
    expect(previewErrorKey(field("planId", "retired"))).toBe("retired");
    expect(previewErrorKey(field("planId", "plan_or_amount"))).toBe("plan_or_amount");
    expect(previewErrorKey(field("rentalPaise", "too_big"))).toBe("amount");
    expect(previewErrorKey({ code: "FORBIDDEN" })).toBe("not_allowed");
    expect(previewErrorKey({ code: "TENANT_READ_ONLY" })).toBe("read_only");
    expect(previewErrorKey({ code: "NOT_FOUND" })).toBe("generic");
    expect(previewErrorKey({ code: "CONFLICT", details: { reason: "customer_closed" } })).toBe(
      "generic",
    );
  });
});

describe("the Owner's add connection form", () => {
  function renderForm(answer: (startDate: string) => AddPreviewResult) {
    const preview = vi.fn(async (input: { startDate: string }) => answer(input.startDate));
    const saved: FormData[] = [];
    const save = vi.fn(async (_state: BackDatedAddFormState, formData: FormData) => {
      saved.push(formData);
      return {
        error: "fix_fields" as const,
        reason: String(formData.get("reason") ?? ""),
        reasonMissing: true,
      };
    });
    renderWithIntl(
      <BackDatedAddForm
        save={save}
        preview={preview}
        plans={[{ id: "p1", name: "Basic", monthlyAmountPaise: 30_000 }]}
        today="2026-11-14"
        latestStartDate="2026-11-15"
        cancelHref="/customers/c1/connections"
      />,
    );
    return { preview, save, saved };
  }

  const answer = (startDate: string): AddPreviewResult => ({
    ok: true,
    preview: startDate === "2026-09-10" ? BACKDATED : TODAY,
  });

  it("a start day today saves as a plain add: no effect panel, no reason box", async () => {
    const { preview } = renderForm(answer);
    fireEvent.change(screen.getByLabelText("Monthly rent"), { target: { value: "p1" } });
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith({ planId: "p1", startDate: "2026-11-14" }),
    );
    expect(screen.queryByLabelText("Why are you changing old bills?")).toBeNull();
    expect(screen.getByRole("button", { name: /Save connection/ })).toBeTruthy();
    // The day input has no lower limit for the Owner.
    expect((screen.getByLabelText("Start day") as HTMLInputElement).min).toBe("");
  });

  it("a start day in a billed month shows each month's effect and asks why before saving", async () => {
    const { preview, save, saved } = renderForm(answer);
    fireEvent.change(screen.getByLabelText("VC number"), { target: { value: "8800 1122" } });
    fireEvent.change(screen.getByLabelText("Monthly rent"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Start day"), { target: { value: "2026-09-10" } });
    await screen.findByText("New connection: ₹300 a month from 10 Sep 2026.");
    expect(preview).toHaveBeenLastCalledWith({ planId: "p1", startDate: "2026-09-10" });
    for (const month of ["September", "October", "November"]) {
      expect(
        screen.getByText(`${month} 2026: ₹300 extra will be added to the next bill.`),
      ).toBeTruthy();
    }
    expect(screen.getByText("In all: ₹900 more to pay.")).toBeTruthy();
    expect(screen.getByText(/Bills up to November 2026 are already made/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Why are you changing old bills?"), {
      target: { value: "Box fitted on 10 Sep" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save with bill changes/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const sent = saved[0];
    expect(sent?.get("backDated")).toBe("1");
    expect(sent?.get("reason")).toBe("Box fitted on 10 Sep");
    expect(sent?.get("startDate")).toBe("2026-09-10");
    expect(sent?.get("rentChoice")).toBe("p1");
    // The answer said the reason is missing: the message shows under the box.
    await screen.findByText("Write why (at least 3 letters).");
  });

  it("a preview refusal is shown in words", async () => {
    renderForm(() => ({ ok: false, error: "in_future" }));
    fireEvent.change(screen.getByLabelText("Monthly rent"), { target: { value: "p1" } });
    await screen.findByText("The day can't be after today.");
  });
});
