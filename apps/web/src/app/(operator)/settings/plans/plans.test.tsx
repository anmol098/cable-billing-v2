import { PLAN_AMOUNT_MAX_PAISE, type PlanView } from "@cb/core";
import { ToastProvider } from "@cb/ui";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import {
  MAX_PLAN_PAISE,
  type PlanActionResult,
  planErrorField,
  planErrorKey,
} from "./action-state";
import { type PlanActions, PlansManager } from "./plans-manager";

const BASIC: PlanView = {
  id: "0190a3b2-0000-7000-8000-000000000011",
  name: "Basic",
  monthlyAmountPaise: 25_000,
  status: "active",
  connectionCount: 12,
};
const NEW_PACK: PlanView = {
  id: "0190a3b2-0000-7000-8000-000000000012",
  name: "Sports HD",
  monthlyAmountPaise: 10_000_000,
  status: "active",
  connectionCount: 0,
};
const OLD: PlanView = {
  id: "0190a3b2-0000-7000-8000-000000000013",
  name: "Old pack",
  monthlyAmountPaise: 15_000,
  status: "retired",
  connectionCount: 1,
};

const ok: PlanActionResult = { ok: true };

function fakeActions(overrides: Partial<PlanActions> = {}): PlanActions {
  return {
    create: vi.fn(async () => ok),
    update: vi.fn(async () => ({ ok: true, changed: true }) as const),
    retire: vi.fn(async () => ok),
    restore: vi.fn(async () => ok),
    ...overrides,
  };
}

const withToasts = (ui: ReactElement) => (
  <ToastProvider closeLabel="Close" label="Notifications">
    {ui}
  </ToastProvider>
);

function renderManager(
  props: Partial<Parameters<typeof PlansManager>[0]> = {},
  locale: "en" | "hi" = "en",
) {
  return renderWithIntl(
    withToasts(
      <PlansManager
        title="Plans"
        plans={[BASIC, OLD]}
        editable
        readOnlyReason={null}
        actions={fakeActions()}
        {...props}
      />,
    ),
    locale,
  );
}

describe("planErrorKey", () => {
  it.each([
    [
      { code: "VALIDATION", details: { fields: [{ path: "name", code: "too_small" }] } },
      "required",
    ],
    [{ code: "VALIDATION", details: { fields: [{ path: "name", code: "too_big" }] } }, "too_long"],
    [
      { code: "VALIDATION", details: { fields: [{ path: "name", code: "custom" }] } },
      "bad_characters",
    ],
    [
      {
        code: "VALIDATION",
        details: { fields: [{ path: "monthlyAmountPaise", code: "not_multiple_of" }] },
      },
      "amount_invalid",
    ],
    [
      { code: "VALIDATION", details: { fields: [{ path: "planId", code: "invalid_format" }] } },
      "unexpected",
    ],
    [{ code: "CONFLICT", details: { reason: "name_taken" } }, "name_taken"],
    [
      { code: "CONFLICT", details: { constraint: "plans_operator_active_name_unique" } },
      "name_taken",
    ],
    [{ code: "NOT_FOUND" }, "not_found"],
    [{ code: "FORBIDDEN" }, "not_owner"],
    [{ code: "TENANT_READ_ONLY" }, "tenant_read_only"],
    [{ code: "INTERNAL" }, "unexpected"],
  ])("%j → %s", (error, key) => {
    expect(planErrorKey(error)).toBe(key);
  });

  it("says a plan in use has the name when showing a hidden plan again", () => {
    expect(planErrorKey({ code: "CONFLICT", details: { reason: "name_taken" } }, true)).toBe(
      "name_taken_show",
    );
  });

  it("puts each error on its box", () => {
    expect(planErrorField("name_taken")).toBe("name");
    expect(planErrorField("amount_required")).toBe("amount");
    expect(planErrorField("not_owner")).toBeNull();
  });

  it("uses the same largest rent as the service", () => {
    expect(MAX_PLAN_PAISE).toBe(PLAN_AMOUNT_MAX_PAISE);
  });
});

describe("PlansManager", () => {
  it("lists plans: rent first, name, connections, Hidden; the Owner gets the buttons", () => {
    renderManager({ plans: [BASIC, NEW_PACK, OLD] });
    const list = screen.getByRole("list", { name: "Plans" });
    const [basic, sports, old] = within(list).getAllByRole("listitem");
    expect(basic).toHaveTextContent("₹250a monthBasic12 connections");
    expect(sports).toHaveTextContent("₹1,00,000a monthSports HDNo connections");
    expect(old).toHaveTextContent("₹150a monthOld pack1 connectionHidden");
    expect(
      within(basic as HTMLElement).getByRole("button", { name: "Change: Basic" }),
    ).toBeVisible();
    expect(within(basic as HTMLElement).getByRole("button", { name: "Hide: Basic" })).toBeVisible();
    expect(
      within(old as HTMLElement).getByRole("button", { name: "Show again: Old pack" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add plan" })).toBeVisible();
  });

  it("shows Staff the list without any button", () => {
    renderManager({ editable: false, readOnlyReason: "not_owner" });
    expect(screen.getByRole("status")).toHaveTextContent("Only the owner can change this.");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells a read-only Owner why there are no buttons", () => {
    renderManager({ editable: false, readOnlyReason: "tenant_read_only", plans: [] });
    expect(screen.getByRole("status")).toHaveTextContent("Pay for the app to make changes.");
    expect(screen.getByText("No plans yet.")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds a plan in rupees (sent as paise) and keeps the dialog open on a problem", async () => {
    const create = vi
      .fn<PlanActions["create"]>()
      .mockResolvedValueOnce({ ok: false, error: "name_taken" })
      .mockResolvedValueOnce(ok);
    renderManager({ plans: [], actions: fakeActions({ create }) });
    expect(
      screen.getByText("No plans yet. Add the monthly rents you charge, like Basic ₹250."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Add plan" });
    const name = within(dialog).getByLabelText("Plan name");
    const amount = within(dialog).getByLabelText("Rent each month");
    expect(amount).toHaveAccessibleDescription("Whole rupees. ₹0 is OK for a free connection.");

    // No rent yet: said on the rent box, nothing sent.
    fireEvent.change(name, { target: { value: "Basic" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(create).not.toHaveBeenCalled();
    expect(amount).toHaveAccessibleDescription("Please write the rent.");

    // A decimal is refused as typed.
    fireEvent.change(amount, { target: { value: "250.50" } });
    expect(amount).toHaveAccessibleDescription("Write whole rupees, up to ₹1,00,000.");
    fireEvent.change(amount, { target: { value: "1,250" } });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(create).toHaveBeenLastCalledWith("Basic", 125_000);
    expect(name).toHaveAccessibleDescription("Another plan already has this name.");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Plan added")).toBeVisible();
  });

  it("renames without asking (the rent is the same)", async () => {
    const update = vi.fn<PlanActions["update"]>(async () => ({ ok: true, changed: true }));
    renderManager({ actions: fakeActions({ update }) });
    fireEvent.click(screen.getByRole("button", { name: "Change: Basic" }));
    const dialog = await screen.findByRole("dialog", { name: "Change plan" });
    expect(within(dialog).getByLabelText("Plan name")).toHaveValue("Basic");
    expect(within(dialog).getByLabelText("Rent each month")).toHaveValue("250");
    expect(within(dialog).getByLabelText("Rent each month")).toHaveAccessibleDescription(
      "A new rent is only for connections you add from now. Bills already made do not change.",
    );
    fireEvent.change(within(dialog).getByLabelText("Plan name"), {
      target: { value: "Basic pack" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(update).toHaveBeenCalledWith(BASIC.id, "Basic pack", 25_000);
    expect(await screen.findByText("Plan saved")).toBeVisible();
  });

  it("asks before a new rent: the plan's connections keep the old rent", async () => {
    const update = vi.fn<PlanActions["update"]>(async () => ({ ok: true, changed: true }));
    renderManager({ actions: fakeActions({ update }) });
    fireEvent.click(screen.getByRole("button", { name: "Change: Basic" }));
    const dialog = await screen.findByRole("dialog", { name: "Change plan" });
    fireEvent.change(within(dialog).getByLabelText("Rent each month"), {
      target: { value: "300" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(update).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog", { name: "Change the rent to ₹300?" });
    expect(confirm).toHaveTextContent(
      "12 connections are on this plan. They keep paying ₹250 a month.",
    );
    expect(confirm).toHaveTextContent(
      "Connections you add from now pay ₹300. Bills already made do not change.",
    );

    // Back keeps what was typed.
    fireEvent.click(within(confirm).getByRole("button", { name: "Back" }));
    const again = await screen.findByRole("dialog", { name: "Change plan" });
    expect(within(again).getByLabelText("Rent each month")).toHaveValue("300");
    await act(async () => {
      fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    });
    const confirmAgain = await screen.findByRole("dialog", { name: "Change the rent to ₹300?" });
    await act(async () => {
      fireEvent.click(within(confirmAgain).getByRole("button", { name: "Save new rent" }));
    });
    expect(update).toHaveBeenCalledWith(BASIC.id, "Basic", 30_000);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Plan saved")).toBeVisible();
  });

  it("does not ask when no connection is on the plan, and says when nothing changed", async () => {
    const update = vi
      .fn<PlanActions["update"]>()
      .mockResolvedValueOnce({ ok: true, changed: true })
      .mockResolvedValueOnce({ ok: true, changed: false });
    renderManager({ plans: [NEW_PACK], actions: fakeActions({ update }) });
    fireEvent.click(screen.getByRole("button", { name: "Change: Sports HD" }));
    let dialog = await screen.findByRole("dialog", { name: "Change plan" });
    fireEvent.change(within(dialog).getByLabelText("Rent each month"), {
      target: { value: "500" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(update).toHaveBeenLastCalledWith(NEW_PACK.id, "Sports HD", 50_000);
    expect(await screen.findByText("Plan saved")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Change: Sports HD" }));
    dialog = await screen.findByRole("dialog", { name: "Change plan" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(await screen.findByText("Nothing changed")).toBeVisible();
  });

  it("asks before hiding and says the connections keep the plan and their rent", async () => {
    const retire = vi.fn<PlanActions["retire"]>(async () => ok);
    renderManager({ plans: [BASIC], actions: fakeActions({ retire }) });
    fireEvent.click(screen.getByRole("button", { name: "Hide: Basic" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Hide Basic?" });
    expect(sheet).toHaveTextContent(
      "It will not show when you add a connection. Its 12 connections keep it and their rent. You can show it again later.",
    );
    expect(retire).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Hide plan" }));
    });
    expect(retire).toHaveBeenCalledWith(BASIC.id);
    expect(await screen.findByText("Plan hidden")).toBeVisible();
  });

  it("shows a hidden plan again, and says why when it fails", async () => {
    const restore = vi.fn<PlanActions["restore"]>(async () => ({
      ok: false,
      error: "name_taken_show" as const,
    }));
    renderManager({ plans: [OLD], actions: fakeActions({ restore }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show again: Old pack" }));
    });
    expect(restore).toHaveBeenCalledWith(OLD.id);
    expect(
      await screen.findByText(
        "A plan in use already has this name. Change one of the names first.",
      ),
    ).toBeVisible();
  });

  it("is in Hindi too", async () => {
    renderManager({}, "hi");
    expect(screen.getByRole("button", { name: "प्लान जोड़ें" })).toBeVisible();
    expect(screen.getByText("12 कनेक्शन")).toBeVisible();
    expect(screen.getByText("छिपा हुआ")).toBeVisible();
    expect(screen.getAllByText("हर महीने")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "बदलें: Basic" }));
    const dialog = await screen.findByRole("dialog", { name: "प्लान बदलें" });
    expect(within(dialog).getByLabelText("हर महीने का किराया")).toHaveValue("250");
  });
});
