import { ToastProvider } from "@cb/ui";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { type AreaActionResult, areaErrorKey } from "./action-state";
import { type AreaActions, type AreaRow, AreasManager } from "./areas-manager";

const NORTH: AreaRow = {
  id: "0190a3b2-0000-7000-8000-000000000001",
  name: "North",
  customerCount: 12,
  hidden: false,
};
const OLD: AreaRow = {
  id: "0190a3b2-0000-7000-8000-000000000002",
  name: "Old market",
  customerCount: 1,
  hidden: true,
};

const ok: AreaActionResult = { ok: true };

function fakeActions(overrides: Partial<AreaActions> = {}): AreaActions {
  return {
    create: vi.fn(async () => ok),
    rename: vi.fn(async () => ok),
    archive: vi.fn(async () => ok),
    restore: vi.fn(async () => ok),
    ...overrides,
  };
}

const withToasts = (ui: ReactElement) => (
  <ToastProvider closeLabel="Close" label="Notifications">
    {ui}
  </ToastProvider>
);

describe("areaErrorKey", () => {
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
      { code: "VALIDATION", details: { fields: [{ path: "areaId", code: "invalid_format" }] } },
      "unexpected",
    ],
    [{ code: "CONFLICT", details: { reason: "name_taken", archived: false } }, "name_taken"],
    [{ code: "CONFLICT", details: { reason: "name_taken", archived: true } }, "name_taken_hidden"],
    [{ code: "CONFLICT", details: { constraint: "areas_operator_name_unique" } }, "name_taken"],
    [{ code: "NOT_FOUND" }, "not_found"],
    [{ code: "FORBIDDEN" }, "not_owner"],
    [{ code: "TENANT_READ_ONLY" }, "tenant_read_only"],
    [{ code: "INTERNAL" }, "unexpected"],
  ])("%j → %s", (error, key) => {
    expect(areaErrorKey(error)).toBe(key);
  });
});

describe("AreasManager", () => {
  it("lists areas with counts and a Hidden mark; the Owner gets the buttons", () => {
    renderWithIntl(
      withToasts(
        <AreasManager
          title="Areas"
          areas={[NORTH, OLD]}
          editable
          readOnlyReason={null}
          actions={fakeActions()}
        />,
      ),
    );
    const list = screen.getByRole("list", { name: "Areas" });
    const [north, old] = within(list).getAllByRole("listitem");
    expect(north).toHaveTextContent("North12 customers");
    expect(old).toHaveTextContent("Old market1 customerHidden");
    expect(within(north as HTMLElement).getByRole("button", { name: "Hide: North" })).toBeVisible();
    expect(
      within(old as HTMLElement).getByRole("button", { name: "Show again: Old market" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add area" })).toBeVisible();
  });

  it("shows Staff the list without any button", () => {
    renderWithIntl(
      withToasts(
        <AreasManager
          title="Areas"
          areas={[NORTH, OLD]}
          editable={false}
          readOnlyReason="not_owner"
          actions={fakeActions()}
        />,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Only the owner can change this.");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds an area and keeps the dialog open with the reason when the name is taken", async () => {
    const create = vi
      .fn<AreaActions["create"]>()
      .mockResolvedValueOnce({ ok: false, error: "name_taken" })
      .mockResolvedValueOnce(ok);
    renderWithIntl(
      withToasts(
        <AreasManager
          title="Areas"
          areas={[]}
          editable
          readOnlyReason={null}
          actions={fakeActions({ create })}
        />,
      ),
    );
    expect(
      screen.getByText("No areas yet. Add the parts of town your linemen cover."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add area" }));
    const dialog = await screen.findByRole("dialog", { name: "Add area" });
    fireEvent.change(within(dialog).getByLabelText("Area name"), { target: { value: "North" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(create).toHaveBeenLastCalledWith("North");
    expect(within(dialog).getByLabelText("Area name")).toHaveAccessibleDescription(
      "Another area already has this name.",
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Area added")).toBeVisible();
  });

  it("renames with the current name filled in", async () => {
    const rename = vi.fn<AreaActions["rename"]>(async () => ok);
    renderWithIntl(
      withToasts(
        <AreasManager
          title="Areas"
          areas={[NORTH]}
          editable
          readOnlyReason={null}
          actions={fakeActions({ rename })}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change name: North" }));
    const dialog = await screen.findByRole("dialog", { name: "Change area name" });
    const input = within(dialog).getByLabelText("Area name");
    expect(input).toHaveValue("North");
    fireEvent.change(input, { target: { value: "North side" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    });
    expect(rename).toHaveBeenCalledWith(NORTH.id, "North side");
    expect(await screen.findByText("Name changed")).toBeVisible();
  });

  it("asks before hiding and says the customers keep the area", async () => {
    const archive = vi.fn<AreaActions["archive"]>(async () => ok);
    renderWithIntl(
      withToasts(
        <AreasManager
          title="Areas"
          areas={[NORTH]}
          editable
          readOnlyReason={null}
          actions={fakeActions({ archive })}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide: North" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Hide North?" });
    expect(sheet).toHaveTextContent("Its 12 customers keep it. You can show it again later.");
    expect(archive).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Hide area" }));
    });
    expect(archive).toHaveBeenCalledWith(NORTH.id);
    expect(await screen.findByText("Area hidden")).toBeVisible();
  });

  it("shows a hidden area again, and says why when it fails", async () => {
    const restore = vi.fn<AreaActions["restore"]>(async () => ({
      ok: false,
      error: "tenant_read_only" as const,
    }));
    renderWithIntl(
      withToasts(
        <AreasManager
          title="Areas"
          areas={[OLD]}
          editable
          readOnlyReason={null}
          actions={fakeActions({ restore })}
        />,
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show again: Old market" }));
    });
    expect(restore).toHaveBeenCalledWith(OLD.id);
    expect(await screen.findByText("View only. Pay for the app to make changes.")).toBeVisible();
  });

  it("is in Hindi too", () => {
    renderWithIntl(
      withToasts(
        <AreasManager
          title="एरिया"
          areas={[NORTH, OLD]}
          editable
          readOnlyReason={null}
          actions={fakeActions()}
        />,
      ),
      "hi",
    );
    expect(screen.getByRole("button", { name: "एरिया जोड़ें" })).toBeVisible();
    expect(screen.getByText("12 ग्राहक")).toBeVisible();
    expect(screen.getByText("छिपा हुआ")).toBeVisible();
  });
});
