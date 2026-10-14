import { ToastProvider } from "@cb/ui";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { ManualAdjustmentForm } from "./manual-form";
import { manualErrorKey, newFormId } from "./results";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/bills/adjustments/new",
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("new bill change (T-045)", () => {
  beforeEach(() => router.push.mockReset());

  function renderForm(locale: "en" | "hi" = "en") {
    const save = vi.fn(async () => ({ ok: true as const, adjustmentId: "x" }));
    const findCustomers = vi.fn(async () => ({ ok: true as const, customers: [] }));
    renderWithIntl(
      <ToastProvider closeLabel="Close" label="Notifications">
        <ManualAdjustmentForm
          initialCustomer={{ id: "c1", code: "1045", name: "Ramesh" }}
          findCustomers={findCustomers}
          save={save}
          doneHref="/bills/adjustments"
        />
      </ToastProvider>,
      locale,
    );
    return { save };
  }

  it("asks for the kind, the amount and why before saving, then says it with the number", async () => {
    const { save } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /Save bill change/ }));
    expect(await screen.findByText("Choose extra charge or take money off.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Take money off/ }));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /Save bill change/ }));
    expect(await screen.findByText("Write why (at least 3 letters).")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Why?"), { target: { value: "Cable cut 10 days" } });
    expect(screen.getByText("₹150 will be taken off what Ramesh owes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Save bill change/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [input] = save.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({
      customerId: "c1",
      direction: "credit",
      amountPaise: 15_000,
      reason: "Cable cut 10 days",
    });
    expect(String(input.id)).toMatch(UUID);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/bills/adjustments"));
  });

  it("Hindi words", () => {
    renderForm("hi");
    expect(screen.getByRole("radio", { name: /ज़्यादा पैसा/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /बिल में बदलाव सेव करें/ })).toBeTruthy();
  });

  it("maps errors and makes UUIDv7 form ids", () => {
    expect(manualErrorKey({ code: "FORBIDDEN" })).toBe("not_allowed");
    expect(manualErrorKey({ code: "CONFLICT", details: { reason: "id_reused" } })).toBe(
      "id_reused",
    );
    expect(manualErrorKey({ code: "VALIDATION", details: { fields: [{ path: "reason" }] } })).toBe(
      "reason",
    );
    expect(newFormId()).toMatch(UUID);
    expect(newFormId()).not.toBe(newFormId());
  });
});
